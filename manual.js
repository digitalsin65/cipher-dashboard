// "My leverage": Mike's own PAPER leverage account. He picks the coin, long or short, leverage (1-20x) and margin;
// the server tracks the position on live Binance prices and closes it at take profit, stop loss or liquidation, even
// with the browser closed. Fake money only: no exchange account, no keys, no real orders.
// State lives in the shared paper file (S.manual), so it follows the leader lock, syncFromDisk and the hourly backup.
const levMod = require('./leverage');

const MAN = {
  start: 1000,                     // US$ paper balance (and what "Reset my account" goes back to)
  minLev: 1, maxLev: 20,
  minMargin: 5,                    // US$
  feePct: levMod.LEV.feePct,       // 0.05% taker fee per side on the position size (same as the bot)
  fundingPct: levMod.LEV.fundingPct, // estimated 0.01% per 8 h: longs pay, shorts receive
  mmr: 0.005,                      // maintenance margin 0.5% of the position (Binance's lowest tier is 0.4-0.5%)
  staleMs: 20e3,                   // a price older than this can't be traded on
  priceMs: 4e3,                    // price cache life
  tickMs: 5e3,                     // TP/SL/liquidation check
  maxOpen: 20,
};
const BN_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
// Used until the leverage bot has loaded its CoinGecko top 50 (S.lev.universe).
const FALLBACK = [['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['BNB', 'BNB'], ['XRP', 'XRP'], ['SOL', 'Solana'], ['TRX', 'TRON'], ['ADA', 'Cardano'], ['LINK', 'Chainlink'],
  ['XLM', 'Stellar'], ['BCH', 'Bitcoin Cash'], ['LTC', 'Litecoin'], ['AVAX', 'Avalanche'], ['NEAR', 'NEAR Protocol'], ['UNI', 'Uniswap'], ['SUI', 'Sui'], ['HBAR', 'Hedera'],
  ['DOT', 'Polkadot'], ['TAO', 'Bittensor'], ['AAVE', 'Aave'], ['ENA', 'Ethena'], ['ONDO', 'Ondo'], ['APT', 'Aptos'], ['ICP', 'Internet Computer'], ['ETC', 'Ethereum Classic'],
  ['ARB', 'Arbitrum'], ['OP', 'Optimism'], ['FIL', 'Filecoin'], ['ATOM', 'Cosmos'], ['INJ', 'Injective'], ['TON', 'Toncoin']];
// Big coins the bot leaves out on purpose (meme coins) but that are fine to play with by hand.
const EXTRA = [['DOGE', 'Dogecoin'], ['SHIB', 'Shiba Inu'], ['PEPE', 'Pepe']];

const dirOf = side => (side === 'short' ? -1 : 1);
const num = v => (v === '' || v == null ? NaN : +v);

// ---------- maths (pure, unit tested) ----------
// Price where the margin left equals the maintenance margin: long entry*(1 - 1/lev + mmr), short entry*(1 + 1/lev - mmr).
function liqPriceFor(side, entry, lev) { return Math.max(0, entry * (1 - dirOf(side) * (1 / lev - MAN.mmr))); }
const unrealised = (t, price) => dirOf(t.side) * t.qty * (price - t.entryPrice);
function accrueFunding(t, price, now = Date.now()) {
  const dt = Math.max(0, now - (t.fundingAt || t.openedAt));
  t.funding = (t.funding || 0) + dirOf(t.side) * t.qty * price * MAN.fundingPct * (dt / (8 * 3600e3));
  t.fundingAt = now;
}
// Turn a TP/SL input into a price. { type: 'price', value } or { type: 'pct', value } where pct is the price move
// in the trade's favour (TP) or against it (SL), e.g. SL 3% on a long = 3% below entry.
function levelPrice(inp, kind, side, entry) {
  if (!inp || inp.value === '' || inp.value == null) return null;
  const v = num(inp.value);
  if (!(v > 0)) return NaN;
  if (inp.type === 'pct') return entry * (1 + dirOf(side) * (kind === 'tp' ? 1 : -1) * v / 100);
  return v;
}
// What the ticket shows before confirming, and what open() uses.
function preview({ side, price, leverage, margin, tp, sl }) {
  const notional = margin * leverage, qty = notional / price, openFee = notional * MAN.feePct;
  const liq = liqPriceFor(side, price, leverage);
  const takeProfit = levelPrice(tp, 'tp', side, price), stopLoss = levelPrice(sl, 'sl', side, price);
  const pnlAt = p => p == null || !(p > 0) ? null : dirOf(side) * qty * (p - price) - openFee - qty * p * MAN.feePct;
  return { side, entryPrice: price, leverage, margin, notional, qty, openFee, exitFeeEst: notional * MAN.feePct, cost: margin + openFee,
    liqPrice: liq, liqMovePct: -(1 / leverage - MAN.mmr) * 100, takeProfit, stopLoss, tpPnl: pnlAt(takeProfit), slPnl: pnlAt(stopLoss) };
}
// Server-side checks. ctx: { cash, coin (from the list or null), price, priceAt, now, openCount }. Returns { error } or { ok, pv }.
function validate(body, ctx) {
  const side = body.side, leverage = num(body.leverage), margin = num(body.margin);
  if (!ctx.coin) return { error: 'Unknown coin. Pick one from the list.' };
  if (side !== 'long' && side !== 'short') return { error: 'Choose Long or Short.' };
  if (!Number.isInteger(leverage) || leverage < MAN.minLev || leverage > MAN.maxLev) return { error: 'Leverage must be a whole number from 1x to 20x.' };
  if (!isFinite(margin) || margin < MAN.minMargin) return { error: 'Margin must be at least US$' + MAN.minMargin + '.' };
  if (ctx.openCount >= MAN.maxOpen) return { error: 'You already have ' + MAN.maxOpen + ' positions open. Close one first.' };
  if (!(ctx.price > 0) || !ctx.priceAt || ctx.now - ctx.priceAt > MAN.staleMs) return { error: 'No fresh price for ' + ctx.coin.symbol + ' right now. Try again in a few seconds.' };
  const pv = preview({ side, price: ctx.price, leverage, margin, tp: body.tp, sl: body.sl });
  if (pv.cost > ctx.cash + 1e-9) return { error: 'Not enough cash: margin plus the US$' + pv.openFee.toFixed(2) + ' fee is US$' + pv.cost.toFixed(2) + ', you have US$' + ctx.cash.toFixed(2) + '.' };
  const d = dirOf(side);
  if (Number.isNaN(pv.takeProfit)) return { error: 'Take profit must be a positive number.' };
  if (Number.isNaN(pv.stopLoss)) return { error: 'Stop loss must be a positive number.' };
  if (pv.takeProfit != null && d * (pv.takeProfit - ctx.price) <= 0) return { error: 'Take profit must be ' + (d > 0 ? 'above' : 'below') + ' the current price for a ' + side + '.' };
  if (pv.stopLoss != null && d * (ctx.price - pv.stopLoss) <= 0) return { error: 'Stop loss must be ' + (d > 0 ? 'below' : 'above') + ' the current price for a ' + side + '.' };
  if (pv.stopLoss != null && d * (pv.stopLoss - pv.liqPrice) <= 0) return { error: 'Stop loss is past the liquidation price (' + pv.liqPrice.toPrecision(6) + '), so it would never trigger. Move it closer or use less leverage.' };
  return { ok: true, pv };
}
function openPos(coin, pv, now = Date.now()) {
  return { id: 'man-' + now + '-' + coin.symbol + '-' + Math.random().toString(36).slice(2, 6), kind: 'man', symbol: coin.symbol, name: coin.name, pair: coin.pair,
    url: 'https://www.tradingview.com/chart/?symbol=BINANCE:' + coin.pair, side: pv.side, leverage: pv.leverage, margin: pv.margin, notional: pv.notional, qty: pv.qty,
    entryPrice: pv.entryPrice, openFee: pv.openFee, funding: 0, fundingAt: now, openedAt: now, lastPrice: pv.entryPrice, lastAt: now,
    liqPrice: pv.liqPrice, takeProfit: pv.takeProfit, stopLoss: pv.stopLoss };
}
// Net P/L if (a fraction of) the position closed at price: margin back + profit - funding - exit fee, minus the open fee.
// Liquidated = the margin is gone (no exit fee charged on top).
function closeMath(t, price, liquidated, frac = 1) {
  const qty = t.qty * frac, margin = t.margin * frac, openFee = t.openFee * frac, funding = (t.funding || 0) * frac;
  const exitFee = liquidated ? 0 : qty * price * MAN.feePct;
  const gross = dirOf(t.side) * qty * (price - t.entryPrice);
  const proceeds = liquidated ? 0 : Math.max(0, margin + gross - funding - exitFee);
  const pnl = proceeds - margin - openFee;
  return { qty, margin, openFee, funding, exitFee, proceeds, pnl, pnlPct: pnl / margin * 100, movePct: dirOf(t.side) * (price / t.entryPrice - 1) * 100 };
}
// Live numbers for an open position, as if closed now (both fees and funding counted).
function mark(t, price) {
  const m = closeMath(t, price, false);
  return { value: m.proceeds, upnl: m.pnl, pnlPct: m.pnlPct, movePct: m.movePct };
}
// Liquidation first, then stop loss, then take profit.
function checkExit(t, price) {
  const d = dirOf(t.side);
  if (d * (price - t.liqPrice) <= 0) return 'Liquidated';
  if (t.stopLoss != null && d * (price - t.stopLoss) <= 0) return 'Stop loss';
  if (t.takeProfit != null && d * (price - t.takeProfit) >= 0) return 'Take profit';
  return null;
}
// Close all or part of a position in account st. Returns the closed record.
function closeIn(st, t, price, reason, frac = 1, now = Date.now()) {
  const full = frac >= 0.999;
  if (full) frac = 1;
  const m = closeMath(t, price, reason === 'Liquidated', frac);
  st.cash += m.proceeds;
  const rec = { ...t, qty: m.qty, margin: m.margin, notional: t.notional * frac, openFee: m.openFee, funding: m.funding, exitPrice: price, exitAt: now,
    proceeds: m.proceeds, exitFee: m.exitFee, pnl: m.pnl, pnlPct: m.pnlPct, movePct: m.movePct, reason, partial: full ? (t.partialDone ? 'rest' : null) : Math.round(frac * 100) + '%' };
  if (full) st.open = st.open.filter(x => x !== t);
  else { const k = 1 - frac; t.qty *= k; t.margin *= k; t.notional *= k; t.openFee *= k; t.funding = (t.funding || 0) * k; t.partialDone = true; }
  st.closed.unshift(rec);
  if (st.closed.length > 500) st.closed.length = 500;
  return rec;
}
function blankAccount(now = Date.now()) { return { cash: MAN.start, start: MAN.start, open: [], closed: [], startedAt: now, resets: 0 }; }
function stats(st) {
  const openVal = st.open.reduce((s, t) => s + mark(t, t.lastPrice || t.entryPrice).value, 0);
  const wins = st.closed.filter(t => t.pnl > 0).length, realised = st.closed.reduce((s, t) => s + t.pnl, 0);
  const equity = st.cash + openVal;
  return { start: st.start || MAN.start, cash: st.cash, openValue: openVal, equity, pnl: equity - (st.start || MAN.start), pnlPct: (equity / (st.start || MAN.start) - 1) * 100,
    realised, unrealised: st.open.reduce((s, t) => s + mark(t, t.lastPrice || t.entryPrice).upnl, 0), trades: st.closed.length, wins,
    winRate: st.closed.length ? wins / st.closed.length * 100 : null, startedAt: st.startedAt, resets: st.resets || 0 };
}
function coinList(S) {
  const u = (S.lev && S.lev.universe || []).filter(c => c.pair);
  const list = u.length ? u.map(c => ({ symbol: c.symbol, name: c.name, pair: c.pair, rank: c.rank }))
    : FALLBACK.map(([s, n], i) => ({ symbol: s, name: n, pair: s + 'USDT', rank: i + 1 }));
  for (const [s, n] of EXTRA) if (!list.some(c => c.symbol === s)) list.push({ symbol: s, name: n, pair: s + 'USDT', rank: null });
  return list;
}

// ---------- engine + routes ----------
function createManual({ getS, save, isLeader, syncFromDisk, fetchImpl, backup }) {
  const fetchJ = fetchImpl || (async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!r.ok) { const e = new Error('Binance HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  });
  let bnHost = BN_HOSTS[0], busy = false, lastErr = null, lastTick = null;
  const px = { at: 0, map: {}, pending: null }; // per-process price cache: pair -> price
  async function bn(pathq) {
    let err;
    for (const h of [bnHost, ...BN_HOSTS.filter(x => x !== bnHost)]) {
      try { const j = await fetchJ(h + pathq); bnHost = h; return j; }
      catch (e) { err = e; if (e.status && ![403, 418, 451].includes(e.status) && e.status < 500) throw e; }
    }
    throw err;
  }
  function acct() { const S = getS(); if (!S.manual) S.manual = blankAccount(); return S.manual; }
  // All coin prices in one call, cached a few seconds and shared by the page and the TP/SL check.
  async function prices(force) {
    if (!force && Date.now() - px.at < MAN.priceMs) return px;
    if (px.pending) { await px.pending; return px; }
    px.pending = (async () => {
      try {
        const pairs = [...new Set([...coinList(getS()).map(c => c.pair), ...acct().open.map(t => t.pair)])];
        let arr;
        try { arr = await bn('/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(pairs))); }
        catch (e) { if (e.status !== 400) throw e; arr = (await bn('/api/v3/ticker/price')).filter(x => pairs.includes(x.symbol)); } // a delisted pair fails the whole list
        const map = {}; for (const x of arr) if (+x.price > 0) map[x.symbol] = +x.price;
        px.map = map; px.at = Date.now(); lastErr = null;
      } catch (e) { lastErr = e.message; }
      finally { px.pending = null; }
    })();
    await px.pending;
    return px;
  }
  // every 5 s (leader only): live price, funding, liquidation, stop loss, take profit
  async function tick() {
    if (busy) return;
    syncFromDisk();
    if (!isLeader()) return;
    if (!acct().open.length) return;
    busy = true;
    try {
      await prices(true);
      syncFromDisk(); // pick up anything another copy wrote while we waited
      const st = acct(), now = Date.now();
      if (!st.open.length || now - px.at > MAN.staleMs) return;
      let changed = false;
      for (const t of [...st.open]) {
        const p = px.map[t.pair]; if (!(p > 0)) continue;
        accrueFunding(t, p, now); t.lastPrice = p; t.lastAt = now; changed = true;
        const why = checkExit(t, p);
        if (why) closeIn(st, t, why === 'Liquidated' ? t.liqPrice : p, why, 1, now);
      }
      lastTick = now;
      if (changed) save();
    } catch (e) { lastErr = e.message; console.warn('[manual] tick failed', e.message); }
    finally { busy = false; }
  }
  function view() {
    const st = acct();
    return { ok: true, account: stats(st), settings: { start: MAN.start, minLev: MAN.minLev, maxLev: MAN.maxLev, minMargin: MAN.minMargin, feePct: MAN.feePct * 100, fundingPct: MAN.fundingPct * 100, mmrPct: MAN.mmr * 100, maxOpen: MAN.maxOpen },
      priceAt: px.at || null, lastTick, error: lastErr,
      coins: coinList(getS()).map(c => ({ ...c, price: px.map[c.pair] || null })),
      open: st.open.map(t => { const p = px.map[t.pair] || t.lastPrice || t.entryPrice; return { ...t, livePrice: p, ...mark(t, p) }; }).sort((a, b) => b.openedAt - a.openedAt),
      closed: st.closed.slice(0, 100) };
  }
  // Same-origin guard for the POST routes (the session cookie is SameSite=Lax already; this also refuses
  // any request that doesn't come from our own page).
  function sameOrigin(req, res, next) {
    const o = req.headers.origin || req.headers.referer || '';
    let ok = req.headers['x-cipher'] === '1';
    if (ok && o) { try { ok = new URL(o).host === req.headers.host; } catch (e) { ok = false; } }
    if (!ok) return res.status(403).json({ ok: false, error: 'Blocked: request did not come from the dashboard.' });
    next();
  }
  function mount(app) {
    app.get('/api/manual', async (req, res) => {
      syncFromDisk();
      await prices();
      res.json(view());
    });
    app.post('/api/manual/open', sameOrigin, async (req, res) => {
      const b = req.body || {};
      const coin0 = coinList(getS()).find(c => c.symbol === String(b.symbol || '').toUpperCase());
      if (coin0) { await prices(true); }
      syncFromDisk();
      const st = acct(), now = Date.now();
      const coin = coinList(getS()).find(c => c.symbol === String(b.symbol || '').toUpperCase()) || null;
      const v = validate(b, { coin, cash: st.cash, price: coin && px.map[coin.pair], priceAt: px.at, now, openCount: st.open.length });
      if (v.error) return res.status(400).json({ ok: false, error: v.error });
      const t = openPos(coin, v.pv, now);
      st.cash -= v.pv.cost; st.open.push(t); save();
      res.json({ ...view(), position: t });
    });
    app.post('/api/manual/close', sameOrigin, async (req, res) => {
      const b = req.body || {};
      const pct = b.pct == null ? 100 : num(b.pct);
      if (!(pct > 0 && pct <= 100)) return res.status(400).json({ ok: false, error: 'Close between 1% and 100%.' });
      syncFromDisk();
      if (!acct().open.some(x => x.id === b.id)) return res.status(404).json({ ok: false, error: 'That position is already closed.' });
      await prices(true);
      syncFromDisk();
      const st = acct(), t = st.open.find(x => x.id === b.id), now = Date.now();
      if (!t) return res.status(404).json({ ok: false, error: 'That position is already closed.' });
      const p = px.map[t.pair];
      if (!(p > 0) || now - px.at > MAN.staleMs) return res.status(503).json({ ok: false, error: 'No fresh price right now. Try again in a few seconds.' });
      accrueFunding(t, p, now); t.lastPrice = p; t.lastAt = now;
      const rec = closeIn(st, t, p, 'Manual close', pct / 100, now);
      save();
      res.json({ ...view(), trade: rec });
    });
    // Reset ONLY this account. The old file is copied first, like the main Reset.
    app.post('/api/manual/reset', sameOrigin, (req, res) => {
      syncFromDisk();
      if (backup) backup('before-manual-reset');
      const S = getS(), old = S.manual;
      S.manualHistory = [{ at: Date.now(), equity: old ? stats(old).equity : null, trades: old ? old.closed.length : 0 }, ...(S.manualHistory || [])].slice(0, 20);
      S.manual = { ...blankAccount(), resets: ((old && old.resets) || 0) + 1 };
      save();
      res.json(view());
    });
  }
  return { tick, mount, prices, view, get error() { return lastErr; } };
}

module.exports = { MAN, liqPriceFor, levelPrice, preview, validate, openPos, closeMath, mark, checkExit, closeIn, accrueFunding, blankAccount, stats, coinList, createManual };
