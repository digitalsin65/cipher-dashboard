// Run: node test-manual.js   ("My leverage" paper account: sizing, fees, P/L, liquidation, TP/SL, partial close, validation, routes)
const assert = require('assert');
const M = require('./manual');
const near = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, msg + ': got ' + a + ', expected ' + b);
const T0 = 1_800_000_000_000;
const BTC = { symbol: 'BTC', name: 'Bitcoin', pair: 'BTCUSDT' };

// ---- liquidation price: long entry*(1 - 1/lev + 0.5%), short entry*(1 + 1/lev - 0.5%) ----
near(M.liqPriceFor('long', 100, 10), 90.5, 'long 10x'); near(M.liqPriceFor('short', 100, 10), 109.5, 'short 10x');
near(M.liqPriceFor('long', 100, 20), 95.5, 'long 20x'); near(M.liqPriceFor('short', 100, 2), 149.5, 'short 2x');
near(M.liqPriceFor('long', 100, 1), 0.5, 'long 1x basically never');

// ---- preview: size, fees, TP/SL as price or % ----
let pv = M.preview({ side: 'long', price: 100, leverage: 10, margin: 100, tp: { type: 'pct', value: 5 }, sl: { type: 'price', value: 97 } });
near(pv.notional, 1000, 'position size'); near(pv.qty, 10, 'qty'); near(pv.openFee, 0.5, 'open fee 0.05%'); near(pv.cost, 100.5, 'cash needed');
near(pv.takeProfit, 105, 'TP +5% for a long'); near(pv.stopLoss, 97, 'SL as price'); near(pv.liqPrice, 90.5, 'liq');
near(pv.tpPnl, 50 - 0.5 - 0.525, 'P/L at TP after both fees'); near(pv.slPnl, -30 - 0.5 - 0.485, 'P/L at SL');
pv = M.preview({ side: 'short', price: 100, leverage: 5, margin: 200, tp: { type: 'pct', value: 10 }, sl: { type: 'pct', value: 4 } });
near(pv.takeProfit, 90, 'short TP 10% below'); near(pv.stopLoss, 104, 'short SL 4% above'); near(pv.liqPrice, 119.5, 'short 5x liq');

// ---- P/L, fees, funding ----
let t = M.openPos(BTC, M.preview({ side: 'long', price: 100, leverage: 10, margin: 100 }), T0);
let m = M.closeMath(t, 110, false);
near(m.exitFee, 0.55, 'exit fee'); near(m.proceeds, 100 + 100 - 0.55, 'proceeds'); near(m.pnl, 100 - 0.55 - 0.5, 'net +10% at 10x ~ +99%'); near(m.pnlPct, 98.95, 'pct of margin');
near(M.mark(t, 100).upnl, -1, 'flat = both fees'); near(M.closeMath(t, 50, false).proceeds, 0, 'never below zero');
let s = M.openPos(BTC, M.preview({ side: 'short', price: 100, leverage: 4, margin: 50 }), T0);
near(M.closeMath(s, 90, false).pnl, 20 - 2 * 90 * 0.0005 - 0.1, 'short gains when price falls');
M.accrueFunding(t, 100, T0 + 8 * 3600e3); near(t.funding, 0.1, 'long pays 0.01%/8h on 1000');
M.accrueFunding(s, 100, T0 + 8 * 3600e3); near(s.funding, -0.02, 'short receives');
m = M.closeMath(t, 90, true); near(m.proceeds, 0, 'liquidated: nothing back'); near(m.pnl, -100.5, 'margin + open fee lost'); near(m.exitFee, 0, 'no exit fee');

// ---- exits: liquidation > stop loss > take profit ----
t = M.openPos(BTC, M.preview({ side: 'long', price: 100, leverage: 10, margin: 100, tp: { type: 'price', value: 105 }, sl: { type: 'price', value: 97 } }), T0);
assert.strictEqual(M.checkExit(t, 101), null); assert.strictEqual(M.checkExit(t, 105), 'Take profit'); assert.strictEqual(M.checkExit(t, 97), 'Stop loss');
assert.strictEqual(M.checkExit(t, 90.4), 'Liquidated', 'gap through SL and liq = liquidated');
s = M.openPos(BTC, M.preview({ side: 'short', price: 100, leverage: 20, margin: 100 }), T0);
assert.strictEqual(M.checkExit(s, 104), null); assert.strictEqual(M.checkExit(s, 104.5), 'Liquidated'); assert.strictEqual(M.checkExit(s, 50), null, 'no TP set');

// ---- account bookkeeping, partial close ----
let st = M.blankAccount(T0);
pv = M.preview({ side: 'long', price: 100, leverage: 10, margin: 200 });
t = M.openPos(BTC, pv, T0); st.cash -= pv.cost; st.open.push(t); near(st.cash, 799, 'cash after open');
let r = M.closeIn(st, t, 110, 'Manual close', 0.25, T0 + 1);
near(r.pnl, 50 - 5 * 110 * 0.0005 - 0.25, 'partial P/L'); assert.strictEqual(r.partial, '25%');
near(t.margin, 150, 'rest margin'); near(t.qty, 15, 'rest qty'); assert.strictEqual(st.open.length, 1);
r = M.closeIn(st, t, 110, 'Manual close', 1, T0 + 2); assert.strictEqual(st.open.length, 0); assert.strictEqual(r.partial, 'rest');
near(st.cash, 1000 + 200 - 20 * 110 * 0.0005 - 1, 'cash = start + profit - fees');
let k = M.stats(st); assert.strictEqual(k.trades, 2); assert.strictEqual(k.winRate, 100); near(k.pnl, 200 - 1.1 - 1, 'total P/L');

// ---- validation ----
const ctx = { coin: BTC, cash: 1000, price: 100, priceAt: T0, now: T0 + 1000, openCount: 0 };
const ok = b => M.validate({ side: 'long', leverage: 10, margin: 100, ...b }, ctx);
assert.ok(ok({}).ok);
assert.match(M.validate({ side: 'long', leverage: 10, margin: 100 }, { ...ctx, coin: null }).error, /Unknown coin/);
assert.match(ok({ side: 'up' }).error, /Long or Short/);
assert.match(ok({ leverage: 21 }).error, /1x to 20x/); assert.match(ok({ leverage: 0 }).error, /1x to 20x/); assert.match(ok({ leverage: 2.5 }).error, /whole number/);
assert.match(ok({ margin: 1000 }).error, /Not enough cash/, 'margin + fee over cash'); assert.match(ok({ margin: 2 }).error, /at least/); assert.match(ok({ margin: 'abc' }).error, /at least/);
assert.match(M.validate({ side: 'long', leverage: 10, margin: 100 }, { ...ctx, now: T0 + 60e3 }).error, /fresh price/, 'stale price');
assert.match(M.validate({ side: 'long', leverage: 10, margin: 100 }, { ...ctx, priceAt: 0 }).error, /fresh price/);
assert.match(ok({ tp: { type: 'price', value: 99 } }).error, /Take profit must be above/);
assert.match(ok({ side: 'short', tp: { type: 'price', value: 101 } }).error, /Take profit must be below/);
assert.match(ok({ sl: { type: 'price', value: 101 } }).error, /Stop loss must be below/);
assert.match(ok({ sl: { type: 'price', value: 90 } }).error, /past the liquidation/, '10x long liq is 90.5');
assert.match(ok({ sl: { type: 'pct', value: -3 } }).error, /positive/);
assert.ok(ok({ tp: { type: 'pct', value: '' }, sl: { type: 'price', value: '' } }).ok, 'blank TP/SL allowed');
assert.match(M.validate({ side: 'long', leverage: 10, margin: 10 }, { ...ctx, openCount: M.MAN.maxOpen }).error, /positions open/);

// ---- coin list ----
let list = M.coinList({ lev: { universe: [{ symbol: 'BTC', name: 'Bitcoin', pair: 'BTCUSDT', rank: 1 }, { symbol: 'XYZ', name: 'No pair', pair: null }] } });
assert.deepStrictEqual(list.map(c => c.symbol), ['BTC', 'DOGE', 'SHIB', 'PEPE'], 'bot list without pairless coins, plus extras');
assert.ok(M.coinList({}).length >= 30, 'fallback list');

// ---- engine + routes against a fake Binance and a fake express app ----
(async () => {
  let S = { strategies: {} }, saves = 0, price = 100, fail = false;
  const fakeFetch = async url => { if (fail) { const e = new Error('Binance HTTP 500'); e.status = 500; throw e; }
    const pairs = JSON.parse(decodeURIComponent(url.split('symbols=')[1])); return pairs.map(p => ({ symbol: p, price: String(p === 'BTCUSDT' ? price : 1) })); };
  const routes = {};
  const app = { get: (p, ...h) => (routes['GET ' + p] = h), post: (p, ...h) => (routes['POST ' + p] = h) };
  const eng = M.createManual({ getS: () => S, save: () => saves++, isLeader: () => true, syncFromDisk: () => {}, fetchImpl: fakeFetch });
  eng.mount(app);
  const call = (key, body, headers = { 'x-cipher': '1', origin: 'http://localhost:3000', host: 'localhost:3000' }) => new Promise(resolve => {
    const hs = routes[key]; let i = 0, code = 200;
    const res = { status(c) { code = c; return res; }, json(j) { resolve({ code, j }); } };
    const req = { body, headers };
    const next = () => { const h = hs[i++]; h(req, res, next); };
    next();
  });
  let x = await call('POST /api/manual/open', { symbol: 'BTC', side: 'long', leverage: 10, margin: 100 }, {});
  assert.strictEqual(x.code, 403, 'missing same-origin header blocked');
  x = await call('POST /api/manual/open', { symbol: 'BTC', side: 'long', leverage: 10, margin: 100 }, { 'x-cipher': '1', origin: 'https://evil.example', host: 'localhost:3000' });
  assert.strictEqual(x.code, 403, 'other origin blocked');
  x = await call('POST /api/manual/open', { symbol: 'NOPE', side: 'long', leverage: 10, margin: 100 }); assert.strictEqual(x.code, 400);
  x = await call('POST /api/manual/open', { symbol: 'btc', side: 'long', leverage: 10, margin: 100, tp: { type: 'pct', value: 5 } });
  assert.strictEqual(x.code, 200, JSON.stringify(x.j)); near(S.manual.cash, 899.5, 'cash after long');
  x = await call('POST /api/manual/open', { symbol: 'BTC', side: 'short', leverage: 5, margin: 50, sl: { type: 'pct', value: 3 } });
  assert.strictEqual(x.code, 200); assert.strictEqual(S.manual.open.length, 2);
  price = 103.1; await eng.tick(); assert.strictEqual(S.manual.open.length, 1, 'short stopped out at +3%'); assert.strictEqual(S.manual.closed[0].reason, 'Stop loss');
  price = 105; await eng.tick(); assert.strictEqual(S.manual.open.length, 0); assert.strictEqual(S.manual.closed[0].reason, 'Take profit');
  x = await call('POST /api/manual/open', { symbol: 'BTC', side: 'long', leverage: 20, margin: 100 });
  const id = S.manual.open[0].id;
  x = await call('POST /api/manual/close', { id, pct: 50 }); assert.strictEqual(x.code, 200); near(S.manual.open[0].margin, 50, 'half closed');
  price = 100; await eng.tick(); assert.strictEqual(S.manual.closed[0].reason, 'Liquidated', '20x long liquidated at -4.5%');
  x = await call('POST /api/manual/close', { id }); assert.strictEqual(x.code, 404);
  fail = true; const realNow = Date.now; Date.now = () => realNow() + 30e3; // Binance down for 30 s
  x = await call('POST /api/manual/open', { symbol: 'BTC', side: 'long', leverage: 2, margin: 10 }); assert.strictEqual(x.code, 400); assert.match(x.j.error, /fresh price/, 'stale when Binance down');
  Date.now = realNow; fail = false;
  const before = S.manual.closed.length; assert.ok(before >= 4);
  x = await call('POST /api/manual/reset', {}); assert.strictEqual(S.manual.cash, 1000); assert.strictEqual(S.manual.closed.length, 0); assert.strictEqual(S.manual.resets, 1);
  assert.strictEqual(S.manualHistory[0].trades, before);
  x = await call('GET /api/manual', {}); assert.ok(x.j.coins.find(c => c.symbol === 'BTC').price > 0);
  await stockTests();
  console.log('test-manual: all passed');
})().catch(e => { console.error(e); process.exit(1); });

// ================= stocks =================
async function stockTests() {
  const K = require('./stocks');
  const NY = (y, mo, d, h, mi) => K.zoned('America/New_York', y, mo, d, h, mi);
  // time zones incl. daylight saving: 9:30 New York is 14:30 UTC in winter, 13:30 UTC in summer
  assert.strictEqual(new Date(NY(2026, 11, 23, 9, 30)).toISOString(), '2026-11-23T14:30:00.000Z');
  assert.strictEqual(new Date(NY(2026, 3, 9, 9, 30)).toISOString(), '2026-03-09T13:30:00.000Z');
  // US hours: Mon 23 Nov 2026
  assert.strictEqual(K.marketState('US', NY(2026, 11, 23, 10, 0)).open, true);
  let ms = K.marketState('US', NY(2026, 11, 23, 9, 0)); assert.strictEqual(ms.open, false); assert.strictEqual(ms.opensAt, NY(2026, 11, 23, 9, 30));
  ms = K.marketState('US', NY(2026, 11, 23, 16, 0)); assert.strictEqual(ms.open, false); assert.strictEqual(ms.opensAt, NY(2026, 11, 24, 9, 30), 'after close -> next day');
  ms = K.marketState('US', NY(2026, 11, 28, 12, 0)); assert.strictEqual(ms.open, false); assert.strictEqual(ms.opensAt, NY(2026, 11, 30, 9, 30), 'Saturday -> Monday');
  // Yahoo trading period knows holidays: Thanksgiving Thu 26 Nov, next session Fri 27 Nov
  ms = K.marketState('US', NY(2026, 11, 26, 11, 0), { start: NY(2026, 11, 27, 9, 30) / 1000, end: NY(2026, 11, 27, 13, 0) / 1000 });
  assert.strictEqual(ms.open, false, 'holiday closed'); assert.strictEqual(ms.opensAt, NY(2026, 11, 27, 9, 30));
  assert.strictEqual(K.marketState('US', NY(2026, 11, 27, 13, 30), { start: NY(2026, 11, 27, 9, 30) / 1000, end: NY(2026, 11, 27, 13, 0) / 1000 }).open, false, 'early close');
  // ASX 10:00-16:00 Sydney
  const SY = (y, mo, d, h, mi) => K.zoned('Australia/Sydney', y, mo, d, h, mi);
  assert.strictEqual(K.marketState('ASX', SY(2026, 11, 24, 15, 59)).open, true); assert.strictEqual(K.marketState('ASX', SY(2026, 11, 24, 20, 0)).opensAt, SY(2026, 11, 25, 10, 0));
  // nights for financing: Fri 10:00 -> Mon 10:00 = 3 nights; within a day = 0; across one close = 1
  assert.strictEqual(K.nightsBetween('US', NY(2026, 11, 20, 10, 0), NY(2026, 11, 23, 10, 0)), 3);
  assert.strictEqual(K.nightsBetween('US', NY(2026, 11, 23, 10, 0), NY(2026, 11, 23, 15, 0)), 0);
  assert.strictEqual(K.nightsBetween('US', NY(2026, 11, 23, 15, 0), NY(2026, 11, 23, 16, 1)), 1);
  assert.strictEqual(K.nightsBetween('US', NY(2026, 11, 30, 10, 0), NY(2026, 12, 2, 10, 0)), 2, 'across a month end');

  // sizing, fees, liquidation, currency
  let pv = M.preview({ asset: 'stock', side: 'long', price: 200, leverage: 5, margin: 100 });
  near(pv.notional, 500, 'stock size'); near(pv.openFee, 0.5, '0.1% fee'); near(pv.liqPrice, 200 * (1 - 0.2 + 0.05), 'stock 5x liq 15% against');
  pv = M.preview({ asset: 'stock', side: 'short', price: 50, leverage: 2, margin: 100, fx: 0.65 }); // an ASX share in A$
  near(pv.qty, 200 / (50 * 0.65), 'qty in shares, A$ price converted'); near(pv.liqPrice, 50 * (1 + 0.5 - 0.05), 'short 2x');
  let t = M.openPos({ symbol: 'BHP.AX', name: 'BHP', market: 'ASX', currency: 'AUD' }, pv, T0);
  near(M.closeMath(t, 45, false).pnl, (5 * t.qty - t.qty * 45 * 0.001) * 0.65 - 0.2, 'A$ profit converted to US$');
  // leverage caps per asset
  const sctx = { asset: 'stock', coin: { symbol: 'AAPL', name: 'Apple', market: 'US', currency: 'USD' }, cash: 1000, price: 200, priceAt: T0, now: T0 + 1000, openCount: 0, fx: 1 };
  assert.ok(M.validate({ side: 'long', leverage: 5, margin: 100 }, sctx).ok);
  assert.match(M.validate({ side: 'long', leverage: 6, margin: 100 }, sctx).error, /1x to 5x for stocks/);
  assert.ok(M.validate({ side: 'long', leverage: 20, margin: 100 }, { ...sctx, asset: 'crypto' }).ok, 'crypto still 20x');
  assert.match(M.validate({ side: 'long', leverage: 2, margin: 100 }, { ...sctx, marketProblem: 'US market is closed.' }).error, /closed/);
  assert.match(M.validate({ side: 'long', leverage: 2, margin: 100 }, { ...sctx, fx: null }).error, /exchange rate/);
  assert.match(M.validate({ side: 'long', leverage: 2, margin: 100 }, { ...sctx, coin: null }).error, /Unknown ticker/);
  // overnight financing: 0.02% of the position per night, long or short
  t = M.openPos(sctx.coin, M.preview({ asset: 'stock', side: 'short', price: 200, leverage: 4, margin: 250 }), NY(2026, 11, 20, 10, 0));
  M.accrueFunding(t, 200, NY(2026, 11, 20, 15, 0)); near(t.funding, 0, 'no charge intraday');
  M.accrueFunding(t, 200, NY(2026, 11, 23, 10, 0)); near(t.funding, 3 * 0.0002 * 1000, 'three nights over the weekend'); assert.strictEqual(t.nights, 3);
  M.accrueFunding(t, 200, NY(2026, 11, 23, 11, 0)); near(t.funding, 0.6, 'not charged twice');
  near(M.closeMath(t, 200, false).pnl, -0.6 - 1 - 1, 'flat trade = fees + financing');
  // gaps: stop loss fills at the gapped open price; a gap through liquidation loses only the margin
  t = M.openPos(sctx.coin, M.preview({ asset: 'stock', side: 'long', price: 100, leverage: 5, margin: 100, sl: { type: 'price', value: 95 }, tp: { type: 'price', value: 110 } }), T0);
  assert.strictEqual(M.stockExit(t, 96), null);
  let ex = M.stockExit(t, 90); assert.strictEqual(ex.why, 'Stop loss'); near(ex.fill, 90, 'filled at the gap'); assert.ok(ex.gapped);
  near(M.closeMath(t, 90, false).pnl, -50 - 5 * 90 * 0.001 - 0.5, 'gap loss bigger than the stop');
  ex = M.stockExit(t, 113); assert.strictEqual(ex.why, 'Take profit'); near(ex.fill, 113, 'gap up fills above TP'); assert.ok(ex.gapped);
  ex = M.stockExit(t, 95); assert.ok(!ex.gapped, 'touching the level is not a gap');
  ex = M.stockExit(t, 70); assert.strictEqual(ex.why, 'Liquidated');
  let m2 = M.closeMath(t, 70, true); near(m2.proceeds, 0, 'nothing back'); near(m2.pnl, -100.5, 'capped at margin + open fee');
  // old saved positions become crypto
  const old = { cash: 900, open: [{ symbol: 'BTC', pair: 'BTCUSDT' }], closed: [{ symbol: 'ETH' }] };
  M.migrate(old); assert.strictEqual(old.open[0].asset, 'crypto'); assert.strictEqual(old.closed[0].asset, 'crypto');
  near(M.closeMath({ side: 'long', qty: 1, margin: 10, openFee: 0.05, entryPrice: 100 }, 110, false).exitFee, 0.055, 'old position: crypto fee, fx 1');

  // ---- routes with a fake Yahoo and a fake clock ----
  let now = NY(2026, 11, 23, 11, 0), yCalls = [];
  const px = { AAPL: 200, 'BHP.AX': 50, 'AUDUSD=X': 0.65 };
  const fakeY = async url => {
    const sym = decodeURIComponent(url.split('/chart/')[1].split('?')[0]); yCalls.push(sym);
    if (!(sym in px)) return { chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } };
    const asx = sym.endsWith('.AX');
    return { chart: { result: [{ meta: { symbol: sym, regularMarketPrice: px[sym], regularMarketTime: Math.floor(now / 1000) - 5, currency: asx ? 'AUD' : 'USD', shortName: sym,
      exchangeTimezoneName: sym.includes('=X') ? 'Europe/London' : asx ? 'Australia/Sydney' : 'America/New_York', instrumentType: sym.includes('=X') ? 'CURRENCY' : 'EQUITY' } }] } };
  };
  let S = { strategies: {}, manual: { cash: 1000, start: 1000, open: [{ id: 'old1', kind: 'man', symbol: 'BTC', pair: 'BTCUSDT', side: 'long', leverage: 2, margin: 100, notional: 200, qty: 2, entryPrice: 100, openFee: 0.1, liqPrice: 50.5, openedAt: T0, lastPrice: 100 }], closed: [] } };
  const routes = {};
  const app = { get: (p, ...h) => (routes['GET ' + p] = h), post: (p, ...h) => (routes['POST ' + p] = h) };
  const eng = M.createManual({ getS: () => S, save: () => {}, isLeader: () => true, syncFromDisk: () => {}, now: () => now, yahooFetch: fakeY,
    fetchImpl: async u => JSON.parse(decodeURIComponent(u.split('symbols=')[1])).map(p => ({ symbol: p, price: '100' })) });
  eng.mount(app);
  const call = (key, body, query) => new Promise(resolve => {
    const hs = routes[key]; let i = 0, code = 200;
    const res = { status(c) { code = c; return res; }, json(j) { resolve({ code, j }); } };
    const req = { body, query: query || {}, headers: { 'x-cipher': '1', origin: 'http://x', host: 'x' } };
    const next = () => { const h = hs[i++]; h(req, res, next); }; next();
  });
  let x = await call('GET /api/manual', {}, { stock: 'AAPL' });
  assert.strictEqual(S.manual.open[0].asset, 'crypto', 'old crypto position migrated in place'); assert.ok(x.j.quote && x.j.quote.price === 200 && x.j.quote.state.open);
  assert.ok(x.j.stocks.length >= 40, 'stock list');
  x = await call('GET /api/manual/lookup', {}, { symbol: 'zzzzq' }); assert.strictEqual(x.code, 404); assert.match(x.j.error, /not found/);
  x = await call('POST /api/manual/open', { asset: 'stock', symbol: 'AAPL', side: 'long', leverage: 6, margin: 100 }); assert.match(x.j.error, /1x to 5x/);
  x = await call('POST /api/manual/open', { asset: 'stock', symbol: 'AAPL', side: 'long', leverage: 5, margin: 100, sl: { type: 'pct', value: 5 } });
  assert.strictEqual(x.code, 200, JSON.stringify(x.j)); const aapl = x.j.position; assert.strictEqual(aapl.asset, 'stock'); near(aapl.stopLoss, 190, 'SL 5%');
  near(S.manual.cash, 1000 - 100.5, 'cash after stock open');
  // ASX share is closed at 11:00 New York (3 am Sydney)
  x = await call('POST /api/manual/open', { asset: 'stock', symbol: 'BHP.AX', side: 'long', leverage: 2, margin: 50 }); assert.match(x.j.error, /ASX is closed. It opens .*Sydney time/);
  // after the US close: no new trades, no closing, no stop checks
  now = NY(2026, 11, 23, 17, 0); px.AAPL = 150;
  x = await call('POST /api/manual/open', { asset: 'stock', symbol: 'AAPL', side: 'short', leverage: 2, margin: 50 }); assert.match(x.j.error, /US market is closed/);
  x = await call('POST /api/manual/close', { id: aapl.id }); assert.strictEqual(x.code, 409);
  yCalls = []; await eng.tick(); assert.ok(!yCalls.includes('AAPL'), 'closed market not polled'); assert.strictEqual(S.manual.open.filter(t => t.asset === 'stock').length, 1, 'no stop out while closed');
  // next open: price gapped to 150, below the 190 stop -> stopped at 150 (and past the 5x liquidation at 170 -> liquidated)
  now = NY(2026, 11, 24, 9, 31); await eng.tick();
  const rec = S.manual.closed[0]; assert.strictEqual(rec.symbol, 'AAPL'); assert.strictEqual(rec.reason, 'Liquidated'); near(rec.exitPrice, 150, 'gap fill price');
  near(rec.pnl, -100.5, 'liquidation capped at margin + fee'); near(rec.funding, 0.1, 'one night financing on US$500');
  // ASX open in Sydney daytime: A$ prices, fx at entry
  now = K.zoned('Australia/Sydney', 2026, 11, 25, 11, 0);
  x = await call('POST /api/manual/open', { asset: 'stock', symbol: 'BHP.AX', side: 'short', leverage: 2, margin: 50, tp: { type: 'pct', value: 4 } });
  assert.strictEqual(x.code, 200, JSON.stringify(x.j)); near(x.j.position.fx, 0.65, 'AUD fx'); assert.strictEqual(x.j.position.currency, 'AUD');
  px['BHP.AX'] = 47.9; now += 15e3; await eng.tick(); assert.strictEqual(S.manual.closed[0].reason, 'Take profit'); assert.ok(S.manual.closed[0].pnl > 0);
  x = await call('GET /api/manual/lookup', {}, { symbol: 'xyz.l' }); assert.strictEqual(x.code, 404);
}
