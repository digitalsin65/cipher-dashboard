// Paper LEVERAGE account: 5x longs and shorts on large-cap coins, simulated with fake money.
// No exchange account, no real orders. Candles and prices come from Binance's free public market data,
// the coin list from CoinGecko's free market-cap ranking.
const ind = require('./indicators');

const LEV = {
  leverage: 5,
  marginUsd: 200,            // per trade -> US$1,000 position at 5x
  maxOpen: 4,
  feePct: 0.0005,            // 0.05% taker fee per side, on the position size
  fundingPct: 0.0001,        // estimated 0.01% of the position every 8 h: longs pay, shorts receive
  stopPct: 0.04,             // stop 4% against the entry price (= -20% of margin at 5x)
  takeProfitPct: 0.08,       // +8% price move (= +40% of margin)
  trailTriggerPct: 0.04,     // once 4% in profit, stop goes to break-even (plus fees) ...
  trailPct: 0.03,            // ... then trails 3% behind the best price
  liqPct: 0.18,              // liquidated 18% against (20% would wipe the margin; 2% kept as maintenance buffer)
  cooldownH: 12,             // no new trade on a coin for 12 h after a losing exit on it
  universeSize: 50,
  scanMs: 15 * 60e3,         // signals every 15 min
  tickMs: 60e3,              // prices, stops and liquidation every minute
  rsiLong: [50, 70], rsiShort: [30, 50],
};
const BN_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
const CG = 'https://api.coingecko.com/api/v3';
// Not tradable trends: stablecoins, wrapped/staked copies, tokenised gold, funds and other real-world assets.
const EXCLUDE_SYMBOLS = new Set(('usdt usdc dai fdusd usde usds pyusd tusd usdd frax usd1 rlusd usdg usdy usyc usdf bfusd buidl susde susds gusd lusd usdp eurc eurt xaut paxg ' +
  'wbtc weth steth wsteth weeth reth cbbtc cbeth lbtc jitosol msol bnsol wbeth ezeth rseth solvbtc meth sweth tbtc btcb wbnb stsol bbtc clbtc oseth lseth wtrx figr_heloc eursafo u').split(' '));
const EXCLUDE_NAME = /wrapped|staked|bridged|liquid staking|restaked|tokenized|treasury|money market|\bfund\b|gold|heloc|stable|\busd\b|dollar|euro/i;
// Meme coins, in case CoinGecko's meme category can't be loaded.
const MEME_FALLBACK = new Set('doge shib pepe bonk wif floki trump bome popcat mog brett pengu fartcoin spx pnut neiro turbo mew dogs babydoge memecore m'.split(' '));
// CoinGecko id -> Binance base symbol where they differ.
const BN_SYMBOL = { 'the-open-network': 'TON' };
const FALLBACK_UNIVERSE = 'BTC ETH BNB XRP SOL TRX ADA LINK XLM BCH LTC AVAX NEAR UNI SUI HBAR DOT TAO AAVE ENA ONDO APT ICP ETC ARB OP FIL ATOM INJ TON'.split(' ');

const dirOf = side => (side === 'short' ? -1 : 1);

// ---------- P&L math (pure, unit tested) ----------
function liqPrice(side, entry) { return entry * (1 - dirOf(side) * LEV.liqPct); }
function openPosition({ symbol, name, pair, side, price, now = Date.now(), signals = null }) {
  const notional = LEV.marginUsd * LEV.leverage;
  return {
    kind: 'lev', id: 'lev-' + now + '-' + symbol, token: 'lev:' + symbol, symbol, name, pair, side, leverage: LEV.leverage,
    url: 'https://www.tradingview.com/chart/?symbol=BINANCE:' + pair,
    margin: LEV.marginUsd, notional, qty: notional / price, entryPrice: price, openFee: notional * LEV.feePct,
    cost: LEV.marginUsd, funding: 0, fundingAt: now, openedAt: now, lastPrice: price, best: price,
    stop: price * (1 - dirOf(side) * LEV.stopPct), stopKind: 'stop', liqPrice: liqPrice(side, price),
    takeProfit: price * (1 + dirOf(side) * LEV.takeProfitPct), signals,
  };
}
const unrealised = (t, price) => dirOf(t.side) * t.qty * (price - t.entryPrice);
// Funding estimate: 0.01% of the position value per 8 h, accrued pro rata. Positive = cost (longs), negative = income (shorts).
function accrueFunding(t, price, now = Date.now()) {
  const dt = Math.max(0, now - (t.fundingAt || t.openedAt));
  t.funding = (t.funding || 0) + dirOf(t.side) * t.qty * price * LEV.fundingPct * (dt / (8 * 3600e3));
  t.fundingAt = now;
}
// What the position would hand back if closed now (margin + profit - funding - exit fee), never below 0.
function positionValue(t, price) { return Math.max(0, t.margin + unrealised(t, price) - (t.funding || 0) - t.qty * price * LEV.feePct); }
// Net P&L of a closed position, counting both fees and funding.
function closeMath(t, price, liquidated) {
  const exitFee = liquidated ? 0 : t.qty * price * LEV.feePct;
  const proceeds = liquidated ? 0 : Math.max(0, t.margin + unrealised(t, price) - (t.funding || 0) - exitFee);
  const pnl = proceeds - t.margin - t.openFee;
  return { proceeds, exitFee, pnl, pnlPct: pnl / t.margin * 100, movePct: dirOf(t.side) * (price / t.entryPrice - 1) * 100 };
}
// Stops: 4% against at first. Once the best price is 4% in profit, the stop moves to break-even plus fees,
// then trails 3% behind the best price. It only ever moves in the trade's favour.
// Returns the exit reason if price hits liquidation, take profit or the stop; else null.
function checkExit(t, price) {
  const d = dirOf(t.side);
  t.best = d > 0 ? Math.max(t.best || t.entryPrice, price) : Math.min(t.best || t.entryPrice, price);
  if (d * (price - t.liqPrice) <= 0) return 'Liquidated';
  if (d * (price / t.entryPrice - 1) >= LEV.takeProfitPct - 1e-9) return 'Take profit';
  if (d * (t.best / t.entryPrice - 1) >= LEV.trailTriggerPct - 1e-9) {
    const be = t.entryPrice * (1 + d * 2 * LEV.feePct);
    const trail = t.best * (1 - d * LEV.trailPct);
    const lvl = d > 0 ? Math.max(be, trail) : Math.min(be, trail);
    if (d * (lvl - t.stop) > 0) { t.stop = lvl; t.stopKind = d * (trail - be) > 0 ? 'trail' : 'breakeven'; }
  }
  if (d * (price - t.stop) <= 0) return t.stopKind === 'trail' ? 'Trailing stop' : t.stopKind === 'breakeven' ? 'Break-even stop' : 'Stop loss';
  return null;
}

// ---------- Signals (pure, unit tested) ----------
// candles: closed candles oldest -> newest, [openTime, open, high, low, close, volume]
function tfSignal(candles) {
  const closes = candles.map(c => c[4]);
  const n = closes.length - 1;
  if (closes.length < 60) return { dir: null, why: 'not enough candles' };
  const e = ind.ema(closes, 50)[n], r = ind.rsi(closes)[n], m = ind.macd(closes);
  const close = closes[n], macd = m.line[n], sig = m.signal[n], hist = m.hist[n];
  const info = { close, ema50: e, rsi: r, macd, signal: sig, hist, dist: (close - e) / e };
  const up = close > e && macd > sig, down = close < e && macd < sig;
  if (up && r >= LEV.rsiLong[0] && r <= LEV.rsiLong[1]) return { ...info, dir: 'long' };
  if (down && r >= LEV.rsiShort[0] && r <= LEV.rsiShort[1]) return { ...info, dir: 'short' };
  let why;
  if (up) why = r > LEV.rsiLong[1] ? 'uptrend but RSI over 70 (overheated)' : 'uptrend but RSI under 50';
  else if (down) why = r < LEV.rsiShort[0] ? 'downtrend but RSI under 30 (oversold)' : 'downtrend but RSI over 50';
  else why = 'price and MACD disagree (no clear trend)';
  return { ...info, dir: null, why };
}
// BTC's 4 h trend: up, down or flat (price vs EMA50 and MACD vs signal agree, or not).
function trendOf(s) { return s && s.close > s.ema50 && s.macd > s.signal ? 'up' : s && s.close < s.ema50 && s.macd < s.signal ? 'down' : 'flat'; }
// Full entry decision for one coin. Returns { dir, score, reason, h1, h4 }.
function evaluate(symbol, c1h, c4h, btcTrend) {
  const h1 = tfSignal(c1h), h4 = tfSignal(c4h);
  const out = { symbol, h1: slim(h1), h4: slim(h4), dir: null, score: 0 };
  if (!h1.dir || !h4.dir) { out.reason = !h4.dir ? '4h: ' + h4.why : '1h: ' + h1.why; return out; }
  if (h1.dir !== h4.dir) { out.reason = '1h and 4h point different ways'; return out; }
  const vr = ind.volumeTrend(c1h.map(c => c[5]), 1, 20);
  out.volRatio = vr == null ? null : +vr.toFixed(2);
  if (!(vr > 1)) { out.reason = 'last 1h volume below its 20-candle average'; return out; }
  if (symbol !== 'BTC' && h1.dir === 'long' && btcTrend === 'down') { out.reason = 'long blocked: BTC 4h trend is down'; return out; }
  if (symbol !== 'BTC' && h1.dir === 'short' && btcTrend === 'up') { out.reason = 'short blocked: BTC 4h trend is up'; return out; }
  out.dir = h1.dir;
  // strength: distance from EMA50 on both charts plus MACD histogram size, all as % of price
  out.score = +((Math.abs(h1.dist) + Math.abs(h4.dist)) * 100 + (Math.abs(h1.hist) + Math.abs(h4.hist)) / h1.close * 1000).toFixed(3);
  return out;
}
function slim(s) {
  const r = (v, d = 4) => (v == null || !isFinite(v) ? null : +(+v).toPrecision(d));
  return { dir: s.dir || null, close: r(s.close, 6), ema50: r(s.ema50, 6), rsi: r(s.rsi, 3), macd: r(s.macd), signal: r(s.signal), hist: r(s.hist) };
}

// ---------- Coin list ----------
function pickUniverse(markets, memeIds, stableIds, binanceSymbols) {
  const out = [];
  for (const c of markets) {
    const sym = String(c.symbol || '').toLowerCase();
    if (EXCLUDE_SYMBOLS.has(sym) || /^usd|usd$/.test(sym) || EXCLUDE_NAME.test(c.name || '') || stableIds.has(c.id)) continue;
    if (memeIds.has(c.id) || MEME_FALLBACK.has(sym)) continue;
    out.push(c);
    if (out.length >= LEV.universeSize) break;
  }
  return out.map(c => {
    const base = BN_SYMBOL[c.id] || String(c.symbol).toUpperCase();
    return { id: c.id, symbol: base, name: c.name, rank: c.market_cap_rank, pair: binanceSymbols.has(base + 'USDT') ? base + 'USDT' : null };
  });
}

// ---------- Engine ----------
function createLeverage({ getS, save, isLeader, syncFromDisk, key = 'lev' }) {
  let bnHost = BN_HOSTS[0], busy = false, lastErr = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function getJson(url, label) {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
    if (!r.ok) { const e = new Error(label + ' HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  // Binance, falling back to its mirror if the main host is blocked where the server runs.
  async function bn(pathq) {
    let err;
    for (const h of [bnHost, ...BN_HOSTS.filter(x => x !== bnHost)]) {
      try { const j = await getJson(h + pathq, 'Binance'); if (h !== bnHost) { console.warn('[lev] switching Binance host to ' + h); bnHost = h; } return j; }
      catch (e) { err = e; if (e.status && ![403, 418, 451].includes(e.status) && e.status < 500) throw e; }
    }
    throw err;
  }
  async function klines(pair, interval) {
    const rows = await bn('/api/v3/klines?symbol=' + pair + '&interval=' + interval + '&limit=150');
    const now = Date.now();
    return rows.filter(k => k[6] < now).map(k => [k[0], +k[1], +k[2], +k[3], +k[4], +k[7]]); // closed candles; volume in USDT
  }
  async function refreshUniverse(L) {
    try {
      const markets = await getJson(CG + '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=150&page=1', 'CoinGecko');
      await sleep(3000);
      let memeIds = new Set(), stableIds = new Set();
      try { memeIds = new Set((await getJson(CG + '/coins/markets?vs_currency=usd&category=meme-token&order=market_cap_desc&per_page=250&page=1', 'CoinGecko')).map(c => c.id)); } catch (e) { console.warn('[lev] meme list unavailable, using built-in list', e.message); }
      await sleep(3000);
      try { stableIds = new Set((await getJson(CG + '/coins/markets?vs_currency=usd&category=stablecoins&order=market_cap_desc&per_page=250&page=1', 'CoinGecko')).map(c => c.id)); } catch (e) { console.warn('[lev] stablecoin list unavailable, using built-in list', e.message); }
      const syms = new Set((await bn('/api/v3/ticker/price')).map(x => x.symbol));
      L.universe = pickUniverse(markets, memeIds, stableIds, syms);
      L.universeAt = Date.now(); L.universeSource = 'CoinGecko';
    } catch (e) {
      console.warn('[lev] coin list refresh failed', e.message);
      if (!L.universe || !L.universe.length) { L.universe = FALLBACK_UNIVERSE.map((s, i) => ({ id: s.toLowerCase(), symbol: s, name: s, rank: i + 1, pair: s + 'USDT' })); L.universeSource = 'built-in list (CoinGecko unavailable)'; }
      L.universeAt = Date.now() - 23 * 3600e3; // retry in about an hour
    }
  }
  function closePos(st, t, price, reason, now = Date.now()) {
    const liq = reason === 'Liquidated';
    const m = closeMath(t, price, liq);
    st.cash += m.proceeds;
    st.open = st.open.filter(x => x !== t);
    st.closed.unshift({ ...t, exitPrice: price, exitAt: now, proceeds: m.proceeds, exitFee: m.exitFee, pnl: m.pnl, pnlPct: m.pnlPct, movePct: m.movePct, reason });
    if (st.closed.length > 500) st.closed.length = 500;
    if (m.pnl < 0) { st.cooldown = st.cooldown || {}; st.cooldown['lev:' + t.symbol] = now + LEV.cooldownH * 3600e3; }
  }
  async function tick() {
    if (busy) return;
    syncFromDisk();
    if (!isLeader()) return;
    busy = true;
    const S0 = getS();
    try {
      const S = S0, st = S.strategies[key];
      if (!st) return;
      S.lev = S.lev || {};
      const L = S.lev, now = Date.now();
      // 1) every minute: prices, funding, liquidation, take profit, stops
      if (st.open.length) {
        const pairs = [...new Set(st.open.map(t => t.pair))];
        const px = await bn('/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(pairs)));
        if (getS() !== S0) return;
        const pm = Object.fromEntries(px.map(x => [x.symbol, +x.price]));
        for (const t of [...st.open]) {
          const p = pm[t.pair]; if (!(p > 0)) continue;
          accrueFunding(t, p, now); t.lastPrice = p; t.lastAt = now;
          const why = checkExit(t, p);
          if (why) closePos(st, t, p, why, now);
        }
        L.lastPrice = now;
      }
      // 2) every 15 minutes: coin list (daily), signals, signal-flip exits, new entries
      if (!L.lastScan || now - L.lastScan >= LEV.scanMs - 5000) {
        if (!L.universe || !L.universeAt || now - L.universeAt > 24 * 3600e3) await refreshUniverse(L);
        if (getS() !== S0) return;
        const coins = L.universe.filter(c => c.pair);
        const btcC4 = await klines('BTCUSDT', '4h');
        const btcTrend = trendOf(tfSignal(btcC4));
        const results = [];
        for (const c of coins) {
          try {
            const c1 = await klines(c.pair, '1h'); await sleep(120);
            const c4 = c.pair === 'BTCUSDT' ? btcC4 : await klines(c.pair, '4h'); await sleep(120);
            results.push({ ...evaluate(c.symbol, c1, c4, btcTrend), name: c.name, pair: c.pair, rank: c.rank });
          } catch (e) { results.push({ symbol: c.symbol, pair: c.pair, dir: null, reason: 'candles unavailable (' + e.message + ')' }); }
          if (getS() !== S0) return;
        }
        const t1h = Object.fromEntries(results.map(r => [r.symbol, r]));
        // exit when the 1 h signal has flipped to the other side
        for (const t of [...st.open]) {
          const r = t1h[t.symbol];
          if (r && r.h1 && r.h1.dir && r.h1.dir !== t.side) closePos(st, t, t.lastPrice || r.h1.close, 'Signal flipped', now);
        }
        // open the strongest new setups
        const cands = results.filter(r => r.dir).sort((a, b) => b.score - a.score);
        const fresh = [];
        for (const r of cands) {
          if (st.open.length >= LEV.maxOpen) { r.note = 'max 4 positions open'; continue; }
          if (st.open.some(t => t.symbol === r.symbol)) { r.note = 'already open'; continue; }
          if ((st.cooldown?.['lev:' + r.symbol] || 0) > now) { r.note = 'cooling down after a loss'; continue; }
          const need = LEV.marginUsd * (1 + LEV.leverage * LEV.feePct);
          if (st.cash < need) { r.note = 'not enough cash'; continue; }
          let price;
          try { price = +(await bn('/api/v3/ticker/price?symbol=' + r.pair)).price; } catch (e) { r.note = 'no live price'; continue; }
          if (!(price > 0)) continue;
          const t = openPosition({ symbol: r.symbol, name: r.name, pair: r.pair, side: r.dir, price, now, signals: { h1: r.h1, h4: r.h4, volRatio: r.volRatio, score: r.score, btcTrend } });
          st.cash -= t.margin + t.openFee; st.open.push(t); fresh.push(r.symbol);
        }
        for (const [k, v] of Object.entries(st.cooldown || {})) if (!(v > now)) delete st.cooldown[k];
        const tally = {};
        for (const r of results) if (!r.dir) tally[r.reason] = (tally[r.reason] || 0) + 1;
        L.scan = { at: now, checked: results.length, btcTrend, longs: cands.filter(r => r.dir === 'long').map(r => r.symbol), shorts: cands.filter(r => r.dir === 'short').map(r => r.symbol), opened: fresh,
          reasons: Object.entries(tally).sort((a, b) => b[1] - a[1]), skippedNoPair: L.universe.filter(c => !c.pair).map(c => c.symbol), universeSource: L.universeSource, universeAt: L.universeAt };
        L.lastScan = now;
      }
      lastErr = null;
      if (getS() === S0) save();
    } catch (e) { lastErr = e.message; console.warn('[lev] tick failed', e.message); }
    finally { busy = false; }
  }
  function summarise(st) {
    const openVal = st.open.reduce((s, t) => s + positionValue(t, t.lastPrice || t.entryPrice), 0);
    const all = [...st.closed, ...st.open];
    return {
      openValue: openVal, equity: st.cash + openVal,
      longs: all.filter(t => t.side === 'long').length, shorts: all.filter(t => t.side === 'short').length,
      open: st.open.map(t => { const p = t.lastPrice || t.entryPrice, u = unrealised(t, p) - (t.funding || 0) - t.openFee - t.qty * p * LEV.feePct; /* net of both fees, as if closed now */ return { ...t, value: positionValue(t, p), upnl: u, pnlPct: u / t.margin * 100, movePct: dirOf(t.side) * (p / t.entryPrice - 1) * 100 }; }),
    };
  }
  return { tick, summarise, get error() { return lastErr; } };
}

module.exports = { LEV, liqPrice, openPosition, unrealised, accrueFunding, positionValue, closeMath, checkExit, tfSignal, trendOf, evaluate, pickUniverse, createLeverage };
