// "My leverage": Mike's own PAPER leverage account. He picks a coin or a stock, long or short, leverage and margin;
// the server tracks the position on live prices (Binance for crypto, Yahoo Finance for stocks) and closes it at take
// profit, stop loss or liquidation, even with the browser closed. Fake money only: no exchange account, no keys, no real orders.
// State lives in the shared paper file (S.manual), so it follows the leader lock, syncFromDisk and the hourly backup.
const levMod = require('./leverage');
const stocks = require('./stocks');
const { STK } = stocks;

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
// Limits and costs per asset type. Old saved positions have no asset field and are crypto.
const isStock = t => t && t.asset === 'stock';
const LIM = {
  crypto: { minLev: MAN.minLev, maxLev: MAN.maxLev, feePct: MAN.feePct, mmr: MAN.mmr },
  stock: { minLev: STK.minLev, maxLev: STK.maxLev, feePct: STK.feePct, mmr: STK.mmr },
};
const feeOf = t => (t.feePct != null ? t.feePct : MAN.feePct);
const fxOf = t => (t.fx > 0 ? t.fx : 1); // US$ per unit of the quote currency, fixed at entry (1 for US$ prices)

// ---------- maths (pure, unit tested) ----------
// Price where the margin left equals the maintenance margin: long entry*(1 - 1/lev + mmr), short entry*(1 + 1/lev - mmr).
function liqPriceFor(side, entry, lev, mmr = MAN.mmr) { return Math.max(0, entry * (1 - dirOf(side) * (1 / lev - mmr))); }
// Crypto: estimated funding 0.01% per 8 h, longs pay and shorts receive. Stocks: financing 0.02% of the position for each
// night held (charged at the 4 pm close, weekend nights count), paid on longs and shorts. Both kept in US$ in t.funding.
function accrueFunding(t, price, now = Date.now()) {
  if (isStock(t)) {
    const nights = stocks.nightsBetween(t.market || 'US', t.fundingAt || t.openedAt, now);
    if (nights > 0) { t.funding = (t.funding || 0) + nights * STK.financePct * t.notional; t.nights = (t.nights || 0) + nights; }
    if (nights > 0 || !t.fundingAt) t.fundingAt = now;
    return;
  }
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
// What the ticket shows before confirming, and what open() uses. Margin and fees in US$, prices in the asset's currency.
function preview({ side, price, leverage, margin, tp, sl, asset = 'crypto', fx = 1 }) {
  const L = LIM[asset] || LIM.crypto;
  const notional = margin * leverage, qty = notional / (price * fx), openFee = notional * L.feePct;
  const liq = liqPriceFor(side, price, leverage, L.mmr);
  const takeProfit = levelPrice(tp, 'tp', side, price), stopLoss = levelPrice(sl, 'sl', side, price);
  const pnlAt = p => p == null || !(p > 0) ? null : (dirOf(side) * qty * (p - price) - qty * p * L.feePct) * fx - openFee;
  return { side, asset, fx, feePct: L.feePct, mmr: L.mmr, entryPrice: price, leverage, margin, notional, qty, openFee, exitFeeEst: notional * L.feePct, cost: margin + openFee,
    liqPrice: liq, liqMovePct: -(1 / leverage - L.mmr) * 100, takeProfit, stopLoss, tpPnl: pnlAt(takeProfit), slPnl: pnlAt(stopLoss) };
}
// Server-side checks. ctx: { asset, cash, coin (from the list / verified, or null), price, priceAt, now, openCount, fx, marketProblem }.
function validate(body, ctx) {
  const asset = ctx.asset === 'stock' ? 'stock' : 'crypto', L = LIM[asset];
  const side = body.side, leverage = num(body.leverage), margin = num(body.margin);
  if (!ctx.coin) return { error: asset === 'stock' ? 'Unknown ticker. Pick one from the list or type a valid US or ASX ticker.' : 'Unknown coin. Pick one from the list.' };
  if (side !== 'long' && side !== 'short') return { error: 'Choose Long or Short.' };
  if (!Number.isInteger(leverage) || leverage < L.minLev || leverage > L.maxLev) return { error: 'Leverage must be a whole number from ' + L.minLev + 'x to ' + L.maxLev + 'x' + (asset === 'stock' ? ' for stocks.' : '.') };
  if (!isFinite(margin) || margin < MAN.minMargin) return { error: 'Margin must be at least US$' + MAN.minMargin + '.' };
  if (ctx.openCount >= MAN.maxOpen) return { error: 'You already have ' + MAN.maxOpen + ' positions open. Close one first.' };
  if (ctx.marketProblem) return { error: ctx.marketProblem };
  if (!(ctx.price > 0) || !ctx.priceAt || ctx.now - ctx.priceAt > (asset === 'stock' ? STK.fetchedStaleMs : MAN.staleMs)) return { error: 'No fresh price for ' + ctx.coin.symbol + ' right now. Try again in a few seconds.' };
  if (asset === 'stock' && !(ctx.fx > 0)) return { error: 'No exchange rate for ' + ctx.coin.currency + ' right now. Try again in a few seconds.' };
  const pv = preview({ side, price: ctx.price, leverage, margin, tp: body.tp, sl: body.sl, asset, fx: ctx.fx || 1 });
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
  const stock = pv.asset === 'stock';
  return { id: 'man-' + now + '-' + coin.symbol + '-' + Math.random().toString(36).slice(2, 6), kind: 'man', asset: stock ? 'stock' : 'crypto', symbol: coin.symbol, name: coin.name,
    pair: stock ? null : coin.pair, market: stock ? coin.market : null, currency: stock ? coin.currency : 'USD',
    url: stock ? 'https://finance.yahoo.com/quote/' + encodeURIComponent(coin.symbol) : 'https://www.tradingview.com/chart/?symbol=BINANCE:' + coin.pair,
    side: pv.side, leverage: pv.leverage, margin: pv.margin, notional: pv.notional, qty: pv.qty, fx: pv.fx, feePct: pv.feePct, mmr: pv.mmr,
    entryPrice: pv.entryPrice, openFee: pv.openFee, funding: 0, fundingAt: now, openedAt: now, lastPrice: pv.entryPrice, lastAt: now,
    liqPrice: pv.liqPrice, takeProfit: pv.takeProfit, stopLoss: pv.stopLoss };
}
// Net P/L in US$ if (a fraction of) the position closed at price: margin back + profit - funding - exit fee, minus the open fee.
// Liquidated = the margin is gone (no exit fee charged on top). A gap past liquidation still loses only the margin.
function closeMath(t, price, liquidated, frac = 1) {
  const fx = fxOf(t), qty = t.qty * frac, margin = t.margin * frac, openFee = t.openFee * frac, funding = (t.funding || 0) * frac;
  const exitFee = liquidated ? 0 : qty * price * fx * feeOf(t);
  const gross = dirOf(t.side) * qty * (price - t.entryPrice) * fx;
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
function closeIn(st, t, price, reason, frac = 1, now = Date.now(), extra = null) {
  const full = frac >= 0.999;
  if (full) frac = 1;
  const m = closeMath(t, price, reason === 'Liquidated', frac);
  st.cash += m.proceeds;
  const rec = { ...t, qty: m.qty, margin: m.margin, notional: t.notional * frac, openFee: m.openFee, funding: m.funding, exitPrice: price, exitAt: now,
    proceeds: m.proceeds, exitFee: m.exitFee, pnl: m.pnl, pnlPct: m.pnlPct, movePct: m.movePct, reason, partial: full ? (t.partialDone ? 'rest' : null) : Math.round(frac * 100) + '%', ...(extra || {}) };
  if (full) st.open = st.open.filter(x => x !== t);
  else { const k = 1 - frac; t.qty *= k; t.margin *= k; t.notional *= k; t.openFee *= k; t.funding = (t.funding || 0) * k; t.partialDone = true; }
  st.closed.unshift(rec);
  if (st.closed.length > 500) st.closed.length = 500;
  return rec;
}
// Stop loss / take profit / liquidation for a stock on a live in-session price. If the price opened past the level
// (an overnight gap), the fill is the gapped price, not the level; liquidation still only loses the margin.
function stockExit(t, price) {
  const why = checkExit(t, price);
  if (!why) return null;
  const level = why === 'Liquidated' ? t.liqPrice : why === 'Stop loss' ? t.stopLoss : t.takeProfit;
  const gapped = dirOf(t.side) * (price - level) * (why === 'Take profit' ? 1 : -1) > level * 0.0025; // more than 0.25% past the level
  return { why, fill: price, gapped, level };
}
function blankAccount(now = Date.now()) { return { cash: MAN.start, start: MAN.start, open: [], closed: [], startedAt: now, resets: 0 }; }
// Saved data from before stocks: tag every position as crypto, in place.
function migrate(st) {
  for (const t of [...(st.open || []), ...(st.closed || [])]) if (!t.asset) t.asset = 'crypto';
  return st;
}
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
function createManual({ getS, save, isLeader, syncFromDisk, fetchImpl, yahooFetch, backup, now: nowFn }) {
  const clock = nowFn || (() => Date.now());
  const fetchJ = fetchImpl || (async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!r.ok) { const e = new Error('Binance HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  });
  const quotes = stocks.createQuotes({ fetchImpl: yahooFetch, now: clock });
  let probeAt = 0; // Yahoo's trading-period info (holidays, early closes) for the market badges, refreshed every 10 min
  const verified = new Map(); // typed tickers that Yahoo confirmed: sym -> { symbol, name, market, currency }
  let bnHost = BN_HOSTS[0], busy = false, lastErr = null, lastTick = null;
  const px = { at: 0, map: {}, pending: null }; // per-process crypto price cache: pair -> price
  async function bn(pathq) {
    let err;
    for (const h of [bnHost, ...BN_HOSTS.filter(x => x !== bnHost)]) {
      try { const j = await fetchJ(h + pathq); bnHost = h; return j; }
      catch (e) { err = e; if (e.status && ![403, 418, 451].includes(e.status) && e.status < 500) throw e; }
    }
    throw err;
  }
  function acct() { const S = getS(); if (!S.manual) S.manual = blankAccount(); else if (!S.manual.migratedStocks) { migrate(S.manual); S.manual.migratedStocks = 1; } return S.manual; }
  // All coin prices in one call, cached a few seconds and shared by the page and the TP/SL check.
  async function prices(force) {
    if (!force && Date.now() - px.at < MAN.priceMs) return px;
    if (px.pending) { await px.pending; return px; }
    px.pending = (async () => {
      try {
        const pairs = [...new Set([...coinList(getS()).map(c => c.pair), ...acct().open.filter(t => !isStock(t)).map(t => t.pair)])];
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
  // ---- stocks ----
  const listed = sym => stocks.LIST.find(s => s.symbol === sym) || verified.get(sym) || null;
  // Look a ticker up on Yahoo: a US or ASX share or ETF. Returns { stock, cache } or { error }.
  async function lookup(sym, force) {
    sym = stocks.cleanSym(sym);
    if (!stocks.validSym(sym)) return { error: 'That doesn\'t look like a ticker.' };
    const c = (await quotes.get([sym], force))[sym];
    if (c.notFound) return { error: sym + ' was not found on Yahoo Finance.' };
    if (!c.q) return { error: 'Could not reach the stock price source: ' + (c.err || 'no data') };
    if (!c.q.market) return { error: sym + ' is listed on ' + (c.q.exchange || 'another exchange') + '. Only US and ASX listings are supported.' };
    if (c.q.type && !['EQUITY', 'ETF'].includes(c.q.type)) return { error: sym + ' is a ' + String(c.q.type).toLowerCase() + ', not a share or ETF.' };
    const known = stocks.LIST.find(s => s.symbol === sym);
    const stock = known || { symbol: sym, name: c.q.name || sym, market: c.q.market, currency: c.q.currency || stocks.MARKETS[c.q.market].currency };
    if (!known) verified.set(sym, stock);
    return { stock, cache: c };
  }
  async function fxFor(currency, force) {
    if (!currency || currency === 'USD') return 1;
    const c = (await quotes.get([currency + 'USD=X'], force))[currency + 'USD=X'];
    return c && c.q && c.q.price > 0 && Date.now() - c.fetchedAt < 30 * 60e3 ? c.q.price : null;
  }
  function stockQuoteInfo(sym) {
    const c = quotes.peek(sym), s = listed(sym);
    const market = (c && c.q && c.q.market) || (s && s.market) || stocks.marketOfSym(sym) || 'US';
    const ms = stocks.marketState(market, clock(), c && c.q && c.q.ctp);
    return { symbol: sym, name: (s && s.name) || (c && c.q && c.q.name) || sym, market, currency: (c && c.q && c.q.currency) || (s && s.currency) || stocks.MARKETS[market].currency,
      price: c && c.q ? c.q.price : null, at: c && c.q ? c.q.at : null, fetchedAt: c ? c.fetchedAt : null, prevClose: c && c.q ? c.q.prevClose : null,
      problem: stocks.quoteProblem(c, clock()), state: ms, error: c && c.err && !c.q ? c.err : null };
  }
  // every 5 s (leader only): live prices, funding/financing, liquidation, stop loss, take profit
  async function tick() {
    if (busy) return;
    syncFromDisk();
    if (!isLeader()) return;
    if (!acct().open.length) return;
    busy = true;
    try {
      const S0open = acct().open;
      const hasCrypto = S0open.some(t => !isStock(t));
      // stocks: only symbols whose market is open right now (a closed market's price doesn't move)
      const liveSyms = [...new Set(S0open.filter(t => isStock(t) && stocks.marketState(t.market || 'US', clock(), (quotes.peek(t.symbol) || {}).q?.ctp).open).map(t => t.symbol))];
      if (hasCrypto) await prices(true);
      if (liveSyms.length) await quotes.get(liveSyms);
      syncFromDisk(); // pick up anything another copy wrote while we waited
      const st = acct(), now = clock();
      let changed = false;
      for (const t of [...st.open]) {
        if (isStock(t)) {
          accrueFunding(t, t.lastPrice, now); // overnight financing, time based
          const c = quotes.peek(t.symbol);
          if (!liveSyms.includes(t.symbol) || stocks.quoteProblem(c, now)) continue;
          const p = c.q.price; t.lastPrice = p; t.lastAt = c.q.at; changed = true;
          const ex = stockExit(t, p);
          if (ex) closeIn(st, t, ex.fill, ex.why, 1, now, ex.gapped ? { gapFrom: ex.level } : null);
          continue;
        }
        if (now - px.at > MAN.staleMs) continue;
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
  function view(sel) {
    const st = acct(), now = clock();
    return { ok: true, account: stats(st),
      settings: { start: MAN.start, minLev: MAN.minLev, maxLev: MAN.maxLev, minMargin: MAN.minMargin, feePct: MAN.feePct * 100, fundingPct: MAN.fundingPct * 100, mmrPct: MAN.mmr * 100, maxOpen: MAN.maxOpen,
        stock: { minLev: STK.minLev, maxLev: STK.maxLev, feePct: STK.feePct * 100, financePct: STK.financePct * 100, mmrPct: STK.mmr * 100 } },
      priceAt: px.at || null, lastTick, error: lastErr, stockError: quotes.error, now,
      fx: { USD: 1, AUD: ((quotes.peek('AUDUSD=X') || {}).q || {}).price || null },
      markets: Object.fromEntries(Object.keys(stocks.MARKETS).map(m => { const q = quotes.peek(m === 'US' ? 'SPY' : 'BHP.AX'); return [m, { ...stocks.marketState(m, now, q && q.q && q.q.ctp), tz: stocks.MARKETS[m].tz, currency: stocks.MARKETS[m].currency }]; })),
      coins: coinList(getS()).map(c => ({ ...c, price: px.map[c.pair] || null })),
      stocks: [...stocks.LIST, ...verified.values()].map(s => { const c = quotes.peek(s.symbol); return { ...s, price: c && c.q ? c.q.price : null, at: c && c.q ? c.q.at : null }; }),
      quote: sel ? stockQuoteInfo(sel) : null,
      open: st.open.map(t => {
        if (isStock(t)) { const q = stockQuoteInfo(t.symbol); const p = q.price && !q.problem ? q.price : t.lastPrice || t.entryPrice; return { ...t, livePrice: p, priceAt: q.price && !q.problem ? q.at : t.lastAt, marketOpen: q.state.open, opensAt: q.state.opensAt, ...mark(t, p) }; }
        const p = px.map[t.pair] || t.lastPrice || t.entryPrice; return { ...t, livePrice: p, ...mark(t, p) };
      }).sort((a, b) => b.openedAt - a.openedAt),
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
  const q1 = v => (Array.isArray(v) ? v[0] : v);
  function mount(app) {
    // ?stock=SYM: also fetch that stock's price (only the stock being looked at, plus open stock positions in the tick).
    app.get('/api/manual', async (req, res) => {
      syncFromDisk();
      const sel = req.query && q1(req.query.stock) ? stocks.cleanSym(q1(req.query.stock)) : null;
      const openStocks = [...new Set(acct().open.filter(isStock).map(t => t.symbol))];
      const want = [...new Set([...(sel && stocks.validSym(sel) && (listed(sel) || quotes.peek(sel)) ? [sel] : []), ...openStocks])];
      if (want.some(x => x.endsWith('.AX'))) want.push('AUDUSD=X'); // A$ -> US$ for ASX sizing
      if (clock() - probeAt > 10 * 60e3) { probeAt = clock(); want.push('SPY', 'BHP.AX'); }
      await Promise.all([prices(), want.length ? quotes.get([...new Set(want)]) : null]);
      res.json(view(sel && stocks.validSym(sel) ? sel : null));
    });
    // Check a typed ticker with Yahoo and add it to the picker.
    app.get('/api/manual/lookup', async (req, res) => {
      const r = await lookup(q1(req.query && req.query.symbol));
      if (r.error) return res.status(404).json({ ok: false, error: r.error });
      res.json({ ok: true, stock: r.stock, quote: stockQuoteInfo(r.stock.symbol) });
    });
    app.post('/api/manual/open', sameOrigin, async (req, res) => {
      const b = req.body || {};
      if (b.asset === 'stock') {
        const r = await lookup(b.symbol, true);
        syncFromDisk();
        const st = acct(), now = clock();
        if (r.error) return res.status(400).json({ ok: false, error: r.error });
        const fx = await fxFor(r.stock.currency);
        const c = quotes.peek(r.stock.symbol), prob = stocks.quoteProblem(c, now);
        let marketProblem = null;
        if (prob === 'Market closed') { const ms = stocks.marketState(r.stock.market, now, c.q.ctp); marketProblem = stocks.MARKETS[r.stock.market].label + ' is closed. It opens ' + stocks.sydney(ms.opensAt) + '.'; }
        else if (prob) marketProblem = prob + ' for ' + r.stock.symbol + '. Try again in a few seconds.';
        const v = validate(b, { asset: 'stock', coin: r.stock, cash: st.cash, price: c.q.price, priceAt: c.fetchedAt, now, openCount: st.open.length, fx, marketProblem });
        if (v.error) return res.status(400).json({ ok: false, error: v.error });
        const t = openPos(r.stock, v.pv, now); t.lastAt = c.q.at;
        st.cash -= v.pv.cost; st.open.push(t); save();
        return res.json({ ...view(r.stock.symbol), position: t });
      }
      const coin0 = coinList(getS()).find(c => c.symbol === String(b.symbol || '').toUpperCase());
      if (coin0) { await prices(true); }
      syncFromDisk();
      const st = acct(), now = Date.now();
      const coin = coinList(getS()).find(c => c.symbol === String(b.symbol || '').toUpperCase()) || null;
      const v = validate(b, { asset: 'crypto', coin, cash: st.cash, price: coin && px.map[coin.pair], priceAt: px.at, now, openCount: st.open.length });
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
      const t0 = acct().open.find(x => x.id === b.id);
      if (!t0) return res.status(404).json({ ok: false, error: 'That position is already closed.' });
      if (isStock(t0)) await quotes.get([t0.symbol], true); else await prices(true);
      syncFromDisk();
      const st = acct(), t = st.open.find(x => x.id === b.id), now = clock();
      if (!t) return res.status(404).json({ ok: false, error: 'That position is already closed.' });
      let p;
      if (isStock(t)) {
        const c = quotes.peek(t.symbol), prob = stocks.quoteProblem(c, now);
        if (prob === 'Market closed') return res.status(409).json({ ok: false, error: stocks.MARKETS[t.market || 'US'].label + ' is closed. You can close ' + t.symbol + ' when it opens (' + stocks.sydney(stocks.marketState(t.market || 'US', now, c && c.q && c.q.ctp).opensAt) + ').' });
        if (prob) return res.status(503).json({ ok: false, error: prob + ' for ' + t.symbol + '. Try again in a few seconds.' });
        p = c.q.price; accrueFunding(t, p, now); t.lastPrice = p; t.lastAt = c.q.at;
      } else {
        p = px.map[t.pair];
        if (!(p > 0) || now - px.at > MAN.staleMs) return res.status(503).json({ ok: false, error: 'No fresh price right now. Try again in a few seconds.' });
        accrueFunding(t, p, now); t.lastPrice = p; t.lastAt = now;
      }
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
      S.manual = { ...blankAccount(), resets: ((old && old.resets) || 0) + 1, migratedStocks: 1 };
      save();
      res.json(view());
    });
  }
  return { tick, mount, prices, view, quotes, get error() { return lastErr; } };
}

module.exports = { MAN, LIM, liqPriceFor, levelPrice, preview, validate, openPos, closeMath, mark, checkExit, stockExit, closeIn, accrueFunding, blankAccount, migrate, stats, coinList, createManual };
