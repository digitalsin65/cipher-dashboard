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
  console.log('test-manual: all passed');
})().catch(e => { console.error(e); process.exit(1); });
