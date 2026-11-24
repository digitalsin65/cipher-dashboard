// Paper trading: simulated Solana meme coin trades with fake money, using live DexScreener data.
// No real wallet, no real orders. Several strategies run side by side, each with its own fake balance.
const fs = require('fs');
const path = require('path');
const os = require('os');
const ind = require('./indicators');
const levMod = require('./leverage');
const walletsMod = require('./wallets');
const manualMod = require('./manual');

const FILE = process.env.PAPER_FILE || path.join(os.homedir(), 'cipher-data', 'papertrade.json');
const DS = 'https://api.dexscreener.com';
const START_BALANCE = 1000;      // US$ per strategy
const POSITION_USD = 100;        // US$ per trade (a strategy can set its own positionUsd)
const MAX_OPEN = 8;              // per strategy
const TAKE_PROFIT = 0.50;        // +50%
const STOP_LOSS = -0.25;         // -25%
const BE_TRIGGER = 0.15;         // once a trade has been up 15%, the stop moves up to break-even
const TRAIL = 0.20;              // ...and then trails 20% below the highest price seen (it never moves down)
const COOLDOWN_H = 24;           // after a stop-out at a loss, that strategy won't buy the coin (or a same-ticker copy) for 24 h
const STOP_REASONS = ['Stop loss', 'Break-even stop', 'Trailing stop'];
const symKey = sym => 'sym:' + String(sym || '').trim().toLowerCase();
const RECOUP_AT = 1.00;         // recoup strategy: sell half at +100% to get the stake back
const RUNNER_TP = 2.00;         // recoup strategy: sell the rest at +200%
const MAX_HOLD_H = 48;           // close stale trades so fake money isn't stuck forever
const COST = 0.01;               // 1% simulated swap fee + slippage on each side
const BE_LEVEL = 1 / ((1 - COST) ** 2); // break-even price as a multiple of entry (about +2%), so a stop there nets about US$0 after both fees
// popular Solana meme searches, so already-trending coins get found too (not just new listings)
const SEARCHES = ['SOL', 'pump', 'bonk', 'meme', 'pepe', 'cat', 'dog', 'ai', 'trump', 'moon'];
const SCAN_MS = 60 * 1000;
const PRICE_MS = 20 * 1000;

// ---------- Rug safety check (RugCheck.xyz, free, no key) ----------
// A coin must pass every check below or it is skipped. If the check can't be run, the coin is skipped too.
const SAFETY = {
  maxTop10Pct: 30,     // top 10 holders (not counting pools/lockers) hold at most 30%
  maxOneHolderPct: 10, // no single wallet over 10%
  maxInsiderPct: 10,   // wallets flagged as insiders/bundled hold at most 10% combined
  maxCreatorPct: 5,    // developer wallet still holds at most 5%
  minHolders: 100,
};
const safetyCache = new Map(); // token -> { at, ok, reasons, info }
async function safetyCheck(mint) {
  const c = safetyCache.get(mint);
  if (c && Date.now() - c.at < (c.ok ? 10 : 30) * 60e3) return c;
  let out;
  try {
    const d = await getJson('https://api.rugcheck.xyz/v1/tokens/' + mint + '/report');
    const reasons = [];
    const supply = +(d.token?.supply || 0), dec = +(d.token?.decimals || 0);
    if (d.rugged) reasons.push('Flagged as rugged');
    if (d.mintAuthority || d.token?.mintAuthority) reasons.push('Developer can still mint more tokens');
    if (d.freezeAuthority || d.token?.freezeAuthority) reasons.push('Developer can freeze wallets');
    const skip = new Set();
    for (const [a, k] of Object.entries(d.knownAccounts || {})) if (k && ['AMM', 'LOCKER'].includes(k.type)) skip.add(a);
    for (const m of d.markets || []) { [m.pubkey, m.liquidityA, m.liquidityB, m.liquidityAAccount, m.liquidityBAccount].forEach(a => a && skip.add(a)); }
    const holders = (d.topHolders || []).filter(h => !skip.has(h.owner) && !skip.has(h.address));
    const top10 = holders.slice(0, 10).reduce((t, h) => t + (+h.pct || 0), 0);
    const one = holders.length ? Math.max(...holders.map(h => +h.pct || 0)) : 0;
    const insider = holders.filter(h => h.insider).reduce((t, h) => t + (+h.pct || 0), 0);
    const creatorPct = supply > 0 ? (+d.creatorBalance || 0) / supply * 100 : 0;
    if (top10 > SAFETY.maxTop10Pct) reasons.push('Top 10 wallets hold ' + top10.toFixed(0) + '%');
    if (one > SAFETY.maxOneHolderPct) reasons.push('One wallet holds ' + one.toFixed(0) + '%');
    if (insider > SAFETY.maxInsiderPct) reasons.push('Insider or bundled wallets hold ' + insider.toFixed(0) + '%');
    if (creatorPct > SAFETY.maxCreatorPct) reasons.push('Developer still holds ' + creatorPct.toFixed(0) + '%');
    if ((d.totalHolders || 0) < SAFETY.minHolders) reasons.push('Only ' + (d.totalHolders || 0) + ' holders');
    for (const r of d.risks || []) if (r.level === 'danger') reasons.push(r.name);
    out = { at: Date.now(), ok: reasons.length === 0, reasons, info: { top10: +top10.toFixed(1), oneHolder: +one.toFixed(1), insider: +insider.toFixed(1), creator: +creatorPct.toFixed(1), holders: d.totalHolders || 0, score: d.score_normalised ?? null } };
  } catch (e) {
    out = { at: Date.now() - 25 * 60e3, ok: false, reasons: ['Safety check unavailable (' + e.message + ')'], info: null }; // retry in ~5 min
  }
  safetyCache.set(mint, out);
  return out;
}

// ---------- Socials check (from DexScreener's token info, free) ----------
// A coin must list its own X account or X community, plus a website or Telegram.
// A link to someone else's post, a trending page or a search doesn't count as its own account.
function xAccount(url) {
  try {
    const u = new URL(url), h = u.hostname.replace(/^www\./, '');
    if (!['x.com', 'twitter.com', 'mobile.twitter.com'].includes(h)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'i' && parts[1] === 'communities' && parts[2]) return url;
    if (parts.length !== 1) return null; // /user/status/..., /i/trending/..., /search, /hashtag/...
    if (['i', 'search', 'hashtag', 'home', 'explore', 'intent', 'share'].includes(parts[0].toLowerCase())) return null;
    return url;
  } catch (e) { return null; }
}
function socialsCheck(p) {
  const socials = p.info?.socials || [], sites = p.info?.websites || [];
  const x = socials.map(s => (s.type === 'twitter' || /(^|\.)(x|twitter)\.com\//i.test(s.url || '')) ? xAccount(s.url) : null).find(Boolean) || null;
  const anyX = socials.some(s => s.type === 'twitter' || /(x|twitter)\.com\//i.test(s.url || ''));
  const tg = socials.find(s => s.type === 'telegram' || /t\.me\//i.test(s.url || '')) || sites.find(w => /t\.me\//i.test(w.url || ''));
  const web = sites.find(w => w.url && !/t\.me\/|(x|twitter)\.com\//i.test(w.url));
  const reasons = [];
  if (!x) reasons.push(anyX ? 'X link is a post or page, not the coin\'s own account' : 'No X account listed');
  if (!web && !tg) reasons.push('No website or Telegram listed');
  return { ok: reasons.length === 0, reasons, info: { x, telegram: tg?.url || null, website: web?.url || null } };
}

// ---------- Chart check (GeckoTerminal candles, free, no key) ----------
// DexScreener has no candles, so 5 min and 15 min candles come from GeckoTerminal for the same pool.
// GeckoTerminal's free limit is small and shared per IP (their docs say about 10 calls a minute, sometimes
// less), so calls are spaced out, capped per scan, cached, and paused with growing back-off after a 429.
const GT = 'https://api.geckoterminal.com/api/v2';
const GT_NET = { solana: 'solana', ethereum: 'eth', bsc: 'bsc', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon_pos', avalanche: 'avax', optimism: 'optimism' };
const GT_GAP_MS = 8000;       // at least 8 s between calls (at most about 7 a minute)
const GT_MAX_PER_SCAN = 6;    // candle requests per scan (scans run every minute); coins past this wait for the next scan
// Entry rules per timeframe. The 5 min chart times the entry (RSI turning up, volume picking up);
// the 15 min chart confirms the bigger trend (MACD above signal and still widening).
const CHART = {
  minCandles: 40, rsiMin: 50, rsiMax: 70,
  5: { rsiRising: true, histRising: false, minVol: 1.2 },
  15: { rsiRising: false, histRising: true, minVol: null },
};
const candleCache = new Map(); // network:pool:minutes -> { at, ttl, candles } or { at, ttl, err }
let gtNext = 0, gtBackoffUntil = 0, gtBackoffMs = 0, gtUsed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Closed candles, oldest first: [time, open, high, low, close, volumeUsd]. Returns null if this scan's budget is used up.
async function gtCandles(net, pool, mins) {
  const key = net + ':' + pool + ':' + mins, c = candleCache.get(key);
  if (c && Date.now() - c.at < c.ttl) { if (c.err) throw new Error(c.err); return c.candles; }
  if (Date.now() < gtBackoffUntil) throw new Error('chart data provider is rate limiting us, will retry shortly');
  if (gtUsed >= GT_MAX_PER_SCAN) return null;
  gtUsed++;
  const at = Math.max(Date.now(), gtNext); gtNext = at + GT_GAP_MS; if (at > Date.now()) await sleep(at - Date.now());
  let r;
  try { r = await fetch(GT + '/networks/' + net + '/pools/' + pool + '/ohlcv/minute?aggregate=' + mins + '&limit=100', { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } }); }
  catch (e) { candleCache.set(key, { at: Date.now(), ttl: 2 * 60e3, err: 'chart data could not be loaded (' + e.message + ')' }); throw new Error('chart data could not be loaded (' + e.message + ')'); }
  if (r.status === 429) { gtBackoffMs = Math.min(gtBackoffMs ? gtBackoffMs * 2 : 60e3, 10 * 60e3); gtBackoffUntil = Date.now() + gtBackoffMs; console.warn('[paper] GeckoTerminal rate limit, pausing chart checks for ' + gtBackoffMs / 1000 + ' s'); throw new Error('chart data provider is rate limiting us, will retry shortly'); }
  if (r.status === 404) { candleCache.set(key, { at: Date.now(), ttl: 30 * 60e3, err: 'no chart data for this pool' }); throw new Error('no chart data for this pool'); }
  if (!r.ok) { candleCache.set(key, { at: Date.now(), ttl: 2 * 60e3, err: 'chart data could not be loaded (HTTP ' + r.status + ')' }); throw new Error('chart data could not be loaded (HTTP ' + r.status + ')'); }
  gtBackoffMs = 0;
  const d = await r.json();
  const nowS = Date.now() / 1000;
  const list = (d?.data?.attributes?.ohlcv_list || []).filter(x => Array.isArray(x) && x.length >= 6 && x[0] + mins * 60 <= nowS) // drop the candle still forming
    .map(x => x.map(Number)).sort((a, b) => a[0] - b[0]);
  candleCache.set(key, { at: Date.now(), ttl: (mins <= 5 ? 4 : 10) * 60e3, candles: list });
  return list;
}
// Any other GeckoTerminal call (used by the copy-wallets discovery) goes through the same spacing and back-off.
async function gtGet(url) {
  if (Date.now() < gtBackoffUntil) throw new Error('GeckoTerminal rate limit, will retry later');
  const at = Math.max(Date.now(), gtNext); gtNext = at + GT_GAP_MS; if (at > Date.now()) await sleep(at - Date.now());
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
  if (r.status === 429) { gtBackoffMs = Math.min(gtBackoffMs ? gtBackoffMs * 2 : 60e3, 10 * 60e3); gtBackoffUntil = Date.now() + gtBackoffMs; throw new Error('GeckoTerminal rate limit, will retry later'); }
  if (!r.ok) throw new Error('GeckoTerminal HTTP ' + r.status);
  gtBackoffMs = 0;
  return r.json();
}
// Momentum entry on one timeframe. Returns { info, reasons }.
function chartRules(candles, mins) {
  const tf = mins + ' min chart', info = ind.summarise(candles), r = [];
  const newest = candles.length ? candles[candles.length - 1][0] : 0;
  if (candles.length < CHART.minCandles) { r.push('Not enough ' + tf + ' history (' + candles.length + ' candles, needs ' + CHART.minCandles + ')'); return { info, reasons: r }; }
  if (Date.now() / 1000 - newest > mins * 60 * 4) { r.push('No recent trades on the ' + tf); return { info, reasons: r }; }
  const f = (v, d = 0) => (v == null ? '?' : v.toFixed(d)), cfg = CHART[mins] || CHART[5];
  if (info.rsi == null || info.rsi < CHART.rsiMin) r.push('RSI ' + f(info.rsi) + ' on ' + tf + ': momentum too weak (needs ' + CHART.rsiMin + ' to ' + CHART.rsiMax + ')');
  else if (info.rsi > CHART.rsiMax) r.push('RSI ' + f(info.rsi) + ' on ' + tf + ': overbought (needs ' + CHART.rsiMin + ' to ' + CHART.rsiMax + ')');
  else if (cfg.rsiRising && info.rsiPrev != null && info.rsi <= info.rsiPrev) r.push('RSI falling on ' + tf + ' (' + f(info.rsiPrev) + ' to ' + f(info.rsi) + ')');
  if (info.macd == null || info.signal == null || info.macd <= info.signal) r.push('MACD below its signal line on ' + tf);
  else if (cfg.histRising && info.histPrev != null && info.hist <= info.histPrev) r.push('MACD momentum fading on ' + tf + ' (histogram shrinking)');
  if (cfg.minVol != null && (info.volRatio == null || info.volRatio < cfg.minVol)) r.push('Volume on ' + tf + ' is ' + f(info.volRatio, 1) + 'x normal (needs ' + cfg.minVol + 'x)');
  return { info, reasons: r };
}
// 5 min first; 15 min is only fetched if 5 min passes, to save calls.
async function chartCheck(p) {
  const net = GT_NET[p.chainId];
  if (!net) return { ok: false, reasons: ['No chart data for the ' + p.chainId + ' network'], info: null };
  try {
    const c5 = await gtCandles(net, p.pairAddress, 5);
    if (!c5) return { deferred: true };
    const a = chartRules(c5, 5);
    if (a.reasons.length) return { ok: false, reasons: a.reasons, info: { m5: a.info } };
    const c15 = await gtCandles(net, p.pairAddress, 15);
    if (!c15) return { deferred: true };
    const b = chartRules(c15, 15);
    return { ok: !b.reasons.length, reasons: b.reasons, info: { m5: a.info, m15: b.info } };
  } catch (e) {
    return { ok: false, reasons: ['Chart check unavailable: ' + e.message], info: null };
  }
}

const STRATS = {
  fresh: {
    name: 'Fresh launches',
    positionUsd: 50,
    rule: 'US$50 per trade since 21 Nov. Stricter rules since 18 Nov: pair 1 h to 24 h old (survived its first hour), liquidity at least US$20k and at least 8% of market cap, market cap US$50k to US$5M, 1 h volume at least US$25k from at least 150 trades, more buys than sells in the last 1 h, up in the last hour but not more than 100%, and up over the last 6 h. Also needs at least 300 holders with the top 10 wallets holding 25% or less.',
    pick(p, ageH) {
      const liq = p.liquidity?.usd || 0, mc = p.marketCap || p.fdv || 0;
      const t1 = p.txns?.h1 || {};
      const ch1 = p.priceChange?.h1 ?? 0, ch6 = p.priceChange?.h6 ?? 0;
      return ageH >= 1 && ageH <= 24 && liq >= 20000 && mc >= 50000 && mc <= 5e6 && liq >= mc * 0.08 &&
        (p.volume?.h1 || 0) >= 25000 && ((t1.buys || 0) + (t1.sells || 0)) >= 150 &&
        t1.buys > t1.sells && ch1 > 0 && ch1 <= 100 && ch6 > 0;
    },
    // extra checks on top of the shared RugCheck rules
    extra(info) {
      const r = [];
      if (info && info.holders < 300) r.push('Only ' + info.holders + ' holders (fresh launches need 300)');
      if (info && info.top10 > 25) r.push('Top 10 wallets hold ' + info.top10.toFixed(0) + '% (fresh launches allow 25%)');
      return r;
    },
  },
  recoup: {
    name: 'Recoup and run',
    rule: 'Turned off 21 Nov: it lost most of its balance, so it no longer buys. Its history stays here for comparison. It bought the same coins as Fresh launches, sold half at +100% to get the stake back, then the rest at +200%.',
    off: true, offNote: 'Turned off 21 Nov',
    exit: 'recoup',
    pick(p, ageH) { return STRATS.fresh.pick(p, ageH); },
    extra(info) { return STRATS.fresh.extra(info); },
  },
  trending: {
    name: 'Trending coins',
    rule: 'US$100 per trade. Pair over 24 h old, liquidity at least US$50k, 24 h volume at least US$250k, up 5% to 60% in the last hour and up over the last 6 h, more buys than sells in the last hour.',
    pick(p, ageH) {
      const liq = p.liquidity?.usd || 0, t1 = p.txns?.h1 || {};
      const ch1 = p.priceChange?.h1 ?? 0, ch6 = p.priceChange?.h6 ?? 0;
      return ageH >= 24 && liq >= 50000 && (p.volume?.h24 || 0) >= 250000 &&
        ch1 >= 5 && ch1 <= 60 && ch6 > 0 && t1.buys > t1.sells;
    },
  },
  chart: {
    name: 'Trending + chart signals',
    rule: 'Added 19 Nov, US$100 per trade: same coins as Trending coins, but only buys when the 5 min and 15 min charts both agree. 5 min chart: RSI(14) between 50 and 70 and rising, MACD(12,26,9) above its signal line, and volume over the last 3 candles at least 1.2x the 20 before. 15 min chart: RSI between 50 and 70, MACD above its signal line and the gap widening. Sells like Trending coins.',
    chart: true,
    pick(p, ageH) { return STRATS.trending.pick(p, ageH); },
  },
  copy: {
    name: 'Copy smart wallets',
    kind: 'copy',
    positionUsd: 50,
    rule: 'Added 22 Nov, US$50 per trade. Watches 10 to 30 Solana wallets that we scored ourselves from their recent on-chain swaps: at least 55% of closed trades in profit, at least 20 closed trades, positive realised P/L, and not a bot (under 300 transactions a day). Buys when 2 or more watched wallets buy the same coin within 30 minutes, or 1 wallet with a very strong record (75%+ wins over 40+ trades). Skips it if the price is already up more than 50% since the first wallet bought. The coin must still pass the socials and RugCheck checks and the 24 h no-rebuy rule. Sells like the other meme strategies (stop -25%, break-even at +15%, then a 20% trailing stop, take profit +50%), and also sells when most of the wallets it copied have sold. Wallets that turn bad on a re-check are dropped.',
  },
  lev: {
    name: 'Leverage 5x (top 50)',
    kind: 'lev',
    rule: 'Added 21 Nov. Paper only: 5x leverage magnifies losses as well as gains, and a 20% move against a trade wipes out its margin. Trades the 50 largest coins by market cap (no stablecoins, wrapped or staked copies, or meme coins) on Binance prices. Every 15 min it checks the 1 h and 4 h charts. Long when both show price above its 50-candle average, MACD above signal and RSI 50 to 70; short when both show price below the average, MACD below signal and RSI 30 to 50. The last 1 h volume must beat its 20-candle average, and altcoins aren\'t bought against BTC\'s 4 h trend. Strongest trends first, at most 4 positions, US$200 margin each (US$1,000 position). Stop 4% against (-20% of margin), take profit +8% (+40%). Once 4% up, the stop moves to break-even and then trails 3% behind the best price. It also exits if the 1 h signal flips. Liquidated at 18% against (whole margin lost). 0.05% fee each side; funding is an estimate (0.01% every 8 h, longs pay, shorts receive). 12 h pause on a coin after a losing trade.',
  },
};

function blank() {
  const s = { started: Date.now(), seen: {}, strategies: {} };
  for (const k of Object.keys(STRATS)) s.strategies[k] = { cash: START_BALANCE, open: [], closed: [] };
  return s;
}
// Read the saved file. If it exists but can't be read (half-written, disk error), keep a copy of it and fall back to the
// hourly backup, so one bad read can never wipe the history. With keepOnError, return null instead (the caller keeps what it has).
function readSaved(f) { const s = JSON.parse(fs.readFileSync(f, 'utf8')); if (!s || !s.strategies) throw new Error('no strategies in ' + f); return s; }
function load(keepOnError) {
  let s;
  if (!fs.existsSync(FILE)) {
    try { s = readSaved(FILE + '.bak'); console.warn('[paper] data file missing, restored from the hourly backup'); } catch (e) { return keepOnError ? null : blank(); }
  } else {
    try { s = readSaved(FILE); }
    catch (e) {
      if (keepOnError) return null;
      console.warn('[paper] could not read data file:', e.message);
      try { fs.copyFileSync(FILE, FILE + '.unreadable-' + Date.now()); } catch (e2) {}
      try { s = readSaved(FILE + '.bak'); console.warn('[paper] restored from the hourly backup'); } catch (e2) { return blank(); }
    }
  }
  // upgrades to saved data; a failure here must never wipe the saved trades
  try {
    for (const k of Object.keys(STRATS)) if (!s.strategies[k]) s.strategies[k] = { cash: START_BALANCE, open: [], closed: [], startedAt: Date.now() };
    // first load after the 21 Nov update: start cooldowns from stop-outs in the last 24 h
    for (const st of Object.values(s.strategies)) if (!st.cooldown) {
      st.cooldown = {};
      for (const t of st.closed || []) if (t.exitAt && Date.now() - t.exitAt < COOLDOWN_H * 3600e3) noteCooldown(st, t, t.pnl, t.exitAt);
    }
  } catch (e) { console.warn('[paper] upgrading saved data failed', e.message); }
  return s;
}
let lastWriteMs = 0, lastBackup = 0; // mtime of the file as we last wrote or read it; when we last made the hourly backup
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    // hourly backup of the last good file (papertrade.json.bak), used if the main file is ever lost or unreadable
    if (Date.now() - lastBackup > 3600e3) { try { readSaved(FILE); fs.copyFileSync(FILE, FILE + '.bak'); } catch (e) {} lastBackup = Date.now(); }
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(S)); fs.renameSync(FILE + '.tmp', FILE); lastWriteMs = fs.statSync(FILE).mtimeMs;
  } catch (e) { console.warn('[paper] save failed', e.message); }
}
// The host can run more than one copy of the server. Each copy re-reads the file when another copy
// changed it (for example a Reset), so an old copy can't write stale numbers back over it.
function syncFromDisk() {
  try { const m = fs.statSync(FILE).mtimeMs; if (m > lastWriteMs) { const s = load(true); if (s) { S = s; lastWriteMs = m; } } } catch (e) {}
}
// Only one copy trades at a time; the others just read. The lock goes stale after 90 s if that copy dies.
const LOCK = FILE + '.lock', ME = process.pid + '-' + Math.random().toString(36).slice(2);
function isLeader() {
  try {
    let cur = null, age = Infinity;
    try { cur = fs.readFileSync(LOCK, 'utf8').trim(); age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch (e) {}
    if (cur === ME || !cur || age > 90e3) { fs.mkdirSync(path.dirname(LOCK), { recursive: true }); fs.writeFileSync(LOCK, ME); return fs.readFileSync(LOCK, 'utf8').trim() === ME; }
    return false;
  } catch (e) { return true; }
}

let S = load();
try { lastWriteMs = fs.statSync(FILE).mtimeMs; } catch (e) {}
let lastScan = null, lastPrice = null, lastError = null, scanning = false;

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('DexScreener HTTP ' + r.status);
  return r.json();
}
// Returns the most liquid Solana pair per token address.
async function pairsFor(addrs) {
  const best = {};
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const arr = await getJson(DS + '/tokens/v1/solana/' + chunk.join(','));
    for (const p of Array.isArray(arr) ? arr : []) {
      if (p.chainId !== 'solana' || !p.baseToken) continue;
      const a = p.baseToken.address;
      if (!chunk.includes(a)) continue;
      if (!best[a] || (p.liquidity?.usd || 0) > (best[a].liquidity?.usd || 0)) best[a] = p;
    }
  }
  return best;
}

// ---------- Stops ----------
// Starts at -25%. Once the price has been 15% above entry, the stop jumps to break-even (entry plus the two 1% fees,
// so selling there nets about US$0). After that it trails 20% below the highest price seen. It only ever moves up.
// Updates t.peak / t.stop / t.stopKind and returns the exit reason if the price is at or below the stop, else null.
function updateStop(t, price) {
  t.peak = Math.max(t.peak || t.entryPrice, price);
  const base = t.entryPrice * (1 + STOP_LOSS);
  if (!t.stop) { t.stop = base; t.stopKind = 'stop'; }
  if (t.peak >= t.entryPrice * (1 + BE_TRIGGER)) {
    const be = t.entryPrice * BE_LEVEL, trail = t.peak * (1 - TRAIL);
    const lvl = Math.max(be, trail), kind = trail > be ? 'trail' : 'breakeven';
    if (lvl > t.stop) { t.stop = lvl; t.stopKind = kind; }
  }
  if (price > t.stop) return null;
  return t.stopKind === 'trail' ? 'Trailing stop' : t.stopKind === 'breakeven' ? 'Break-even stop' : 'Stop loss';
}
// A stop-out at a loss puts the coin (by address, and by ticker so copycat coins with the same ticker are caught too) on a 24 h cooldown.
function noteCooldown(st, t, pnl, now = Date.now()) {
  if (!STOP_REASONS.includes(t.reason) || !(pnl < 0)) return;
  st.cooldown = st.cooldown || {};
  const until = now + COOLDOWN_H * 3600e3;
  st.cooldown[t.token] = until;
  if (t.symbol) st.cooldown[symKey(t.symbol)] = until;
}
function onCooldown(st, token, symbol, now = Date.now()) {
  const c = st.cooldown || {};
  return (c[token] || 0) > now || (symbol ? (c[symKey(symbol)] || 0) > now : false);
}
function pruneCooldowns(st, now = Date.now()) {
  if (!st.cooldown) return;
  for (const [k, v] of Object.entries(st.cooldown)) if (!(v > now)) delete st.cooldown[k];
}

function closeTrade(st, t, price, reason) {
  const gross = t.qty * price;
  const proceeds = gross * (1 - COST);
  st.cash += proceeds;
  const pnl = proceeds + (t.partialProceeds || 0) - t.cost;
  st.open = st.open.filter(x => x !== t);
  st.closed.unshift({ ...t, exitPrice: price, exitAt: Date.now(), proceeds, pnl, pnlPct: pnl / t.cost * 100, reason });
  if (st.closed.length > 500) st.closed.length = 500;
  noteCooldown(st, { token: t.token, symbol: t.symbol, reason }, pnl);
}

async function scan() {
  if (scanning) return;
  syncFromDisk();
  if (!isLeader()) return;
  scanning = true;
  gtUsed = 0;
  const S0 = S;
  try {
    const lists = await Promise.allSettled([
      getJson(DS + '/token-profiles/latest/v1'),
      getJson(DS + '/token-boosts/latest/v1'),
      getJson(DS + '/token-boosts/top/v1'),
      ...SEARCHES.map(q => getJson(DS + '/latest/dex/search?q=' + encodeURIComponent(q))),
    ]);
    const now = Date.now();
    for (const l of lists) {
      if (l.status !== 'fulfilled') continue;
      const v = l.value;
      if (Array.isArray(v)) { for (const x of v) if (x.chainId === 'solana' && x.tokenAddress) S.seen[x.tokenAddress] = now; }
      else if (v && Array.isArray(v.pairs)) { for (const p of v.pairs) if (p.chainId === 'solana' && p.baseToken && p.quoteToken && p.quoteToken.symbol === 'SOL') S.seen[p.baseToken.address] = now; }
    }
    // keep tokens seen in the last 48 h as candidates (so trending ones get re-checked), cap the list
    let addrs = Object.entries(S.seen).filter(([, t]) => now - t < 48 * 3600e3).sort((a, b) => b[1] - a[1]).slice(0, 450).map(([a]) => a);
    S.seen = Object.fromEntries(addrs.map(a => [a, S.seen[a]]));
    // each strategy never re-buys a token it already traded (strategies can hold the same coin as each other)
    const heldBy = {};
    for (const [k, st] of Object.entries(S.strategies)) { heldBy[k] = new Set(); st.open.forEach(t => heldBy[k].add(t.token)); st.closed.forEach(t => heldBy[k].add(t.token)); }
    addrs = addrs.filter(a => Object.keys(STRATS).some(k => !STRATS[k].off && !STRATS[k].kind && !heldBy[k].has(a)));
    const copySignals = copy.signals(now);
    if (copySignals.length) addrs = [...new Set([...addrs, ...copySignals.map(x => x.mint)])];
    const pairs = await pairsFor(addrs);
    strats: for (const [key, def] of Object.entries(STRATS)) {
      if (def.kind === 'lev') continue; // the leverage account runs on its own timer (leverage.js)
      if (def.off) continue; // turned off: open trades are still managed in checkPrices, but nothing new is bought
      const st = S.strategies[key], held = heldBy[key], pos = def.positionUsd || POSITION_USD;
      pruneCooldowns(st, now);
      const sigOf = {};
      const cands = def.kind === 'copy'
        ? copySignals.filter(x => pairs[x.mint] && +pairs[x.mint].priceUsd > 0).sort((a, b) => b.wallets.length - a.wallets.length).map(x => { sigOf[x.mint] = x; return pairs[x.mint]; })
        : Object.values(pairs).filter(p => {
          const ageH = p.pairCreatedAt ? (now - p.pairCreatedAt) / 3600e3 : 0;
          return +p.priceUsd > 0 && def.pick(p, ageH);
        }).sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0));
      for (const p of cands) {
        if (st.open.length >= MAX_OPEN || st.cash < pos) break;
        if (held.has(p.baseToken.address)) continue;
        if (onCooldown(st, p.baseToken.address, p.baseToken.symbol, now)) continue; // stopped out in the last 24 h; not listed in Failed checks
        const soc = socialsCheck(p);
        let safe = soc.ok ? await safetyCheck(p.baseToken.address) : { ok: false, reasons: soc.reasons, info: null };
        if (S !== S0) break strats; // another copy reset the data while we waited; drop this scan
        if (safe.ok && def.extra) { const r = def.extra(safe.info); if (r.length) safe = { ...safe, ok: false, reasons: r }; }
        let chart = null, copied = null;
        if (safe.ok && def.kind === 'copy') {
          const sg = sigOf[p.baseToken.address];
          const solUsd = copy.solUsd || 0;
          const curSol = p.quoteToken?.address === walletsMod.SOL ? +p.priceNative : solUsd > 0 ? +p.priceUsd / solUsd : 0;
          const runUp = sg.firstPriceSol > 0 && curSol > 0 ? (curSol / sg.firstPriceSol - 1) * 100 : null;
          copied = { wallets: sg.wallets, firstAt: sg.firstAt, firstPriceSol: sg.firstPriceSol, runUpPct: runUp == null ? null : +runUp.toFixed(1) };
          if (runUp != null && runUp > 50) safe = { ...safe, ok: false, reasons: ['Price already up ' + runUp.toFixed(0) + '% since the first wallet bought (limit 50%)'] };
        }
        if (safe.ok && def.chart) {
          const c = await chartCheck(p);
          if (S !== S0) break strats; // another copy reset the data while we waited; drop this scan
          if (c.deferred) continue; // out of chart calls this scan, try again next scan
          chart = c.info;
          if (!c.ok) safe = { ...safe, ok: false, reasons: c.reasons };
        }
        if (!safe.ok) {
          S.skipped = S.skipped || [];
          const same = x => x.token === p.baseToken.address && (x.reasons.join('|') === safe.reasons.join('|') ? Date.now() - x.at < 6 * 3600e3 : x.strat === key && Date.now() - x.at < 3600e3);
          if (!S.skipped.some(same)) {
            S.skipped.unshift({ at: Date.now(), strat: key, token: p.baseToken.address, symbol: p.baseToken.symbol, url: p.url, reasons: safe.reasons, ...(chart ? { chart } : {}) });
            if (S.skipped.length > 200) S.skipped.length = 200;
            S.skippedCount = (S.skippedCount || 0) + 1;
          }
          continue;
        }
        const price = +p.priceUsd;
        const qty = pos * (1 - COST) / price;
        st.cash -= pos;
        st.open.push({
          id: key + '-' + now + '-' + p.baseToken.address.slice(0, 6), token: p.baseToken.address,
          symbol: p.baseToken.symbol, name: p.baseToken.name, pair: p.pairAddress, dex: p.dexId, url: p.url,
          entryPrice: price, qty, cost: pos, openedAt: now, stop: price * (1 + STOP_LOSS), stopKind: 'stop',
          entry: { liq: p.liquidity?.usd || 0, mc: p.marketCap || p.fdv || 0, vol1h: p.volume?.h1 || 0, ch1h: p.priceChange?.h1 ?? null },
          lastPrice: price, lastLiq: p.liquidity?.usd || 0, peak: price, safety: safe.info, socials: soc.info, ...(chart ? { chart } : {}), ...(copied ? { copy: copied } : {}),
        });
        held.add(p.baseToken.address);
      }
    }
    if (S !== S0) return; // data was reset by another copy mid-scan; don't write the old state back
    lastScan = now; S.lastScan = now; lastError = null; save();
  } catch (e) { lastError = e.message; console.warn('[paper] scan failed', e.message); }
  finally { scanning = false; }
}

async function checkPrices() {
  syncFromDisk();
  if (!isLeader()) return;
  const open = Object.entries(S.strategies).filter(([k]) => !(STRATS[k] && STRATS[k].kind === 'lev')).flatMap(([k, st]) => st.open.map(t => [k, t]));
  if (!open.length) return;
  try {
    const pairs = await pairsFor([...new Set(open.map(([, t]) => t.token))]);
    const now = Date.now();
    for (const [k, t] of open) {
      const st = S.strategies[k];
      const p = pairs[t.token];
      if (!p || !(+p.priceUsd > 0)) {
        if (now - t.openedAt > MAX_HOLD_H * 3600e3) closeTrade(st, t, 0, 'No price, written off');
        continue;
      }
      const price = +p.priceUsd, liq = p.liquidity?.usd || 0;
      t.lastPrice = price; t.lastLiq = liq; t.lastAt = now;
      const ch = price / t.entryPrice - 1;
      const stopHit = t.recouped ? null : updateStop(t, price);
      let si = null; // after a recoup, the runner has its own rule below
      if (STRATS[k] && STRATS[k].exit === 'recoup') {
        if (!t.recouped && ch >= RECOUP_AT) {
          // sell half to get the stake back, let the other half run
          const half = t.qty / 2, proceeds = half * price * (1 - COST);
          st.cash += proceeds; t.qty -= half; t.partialProceeds = (t.partialProceeds || 0) + proceeds;
          t.recouped = true; t.recoupedAt = now; t.recoupPrice = price;
        } else if (t.recouped && ch >= RUNNER_TP) closeTrade(st, t, price, 'Rest sold at +200%');
        else if (t.recouped && ch <= 0) closeTrade(st, t, price, 'Rest sold at buy price');
        else if (!t.recouped && stopHit) closeTrade(st, t, price, stopHit);
        else if (t.entry.liq > 0 && liq < t.entry.liq * 0.2) closeTrade(st, t, price, 'Liquidity pulled');
        else if (now - t.openedAt > MAX_HOLD_H * 3600e3) closeTrade(st, t, price, 'Time limit (48 h)');
        continue;
      }
      if (ch >= TAKE_PROFIT) closeTrade(st, t, price, 'Take profit');
      else if (stopHit) closeTrade(st, t, price, stopHit);
      else if (t.copy && (si = copy.soldInfo(t)) && si.majority) closeTrade(st, t, price, 'Copied wallets sold (' + si.sold + ' of ' + si.of + ')');
      else if (t.entry.liq > 0 && liq < t.entry.liq * 0.2) closeTrade(st, t, price, 'Liquidity pulled');
      else if (now - t.openedAt > MAX_HOLD_H * 3600e3) closeTrade(st, t, price, 'Time limit (48 h)');
    }
    lastPrice = now; S.lastPrice = now; save();
  } catch (e) { lastError = e.message; console.warn('[paper] price check failed', e.message); }
}

// Leverage account (its own timer: prices every minute, signals every 15 min)
const lev = levMod.createLeverage({ getS: () => S, save, isLeader, syncFromDisk, key: 'lev' });
// Copy smart wallets engine (its own timer: wallet swaps every minute, scoring a slice at a time, discovery daily).
// SOLANA_RPC_URL can point at your own RPC (e.g. a Helius URL with its key); otherwise the free public RPC is used.
const copy = walletsMod.createCopy({ getS: () => S, save, isLeader, syncFromDisk, gtGet, rpcUrl: process.env.SOLANA_RPC_URL || null });
// "My leverage": Mike's own hand-picked paper leverage trades (S.manual), checked every 5 s for TP/SL/liquidation.
const manual = manualMod.createManual({ getS: () => S, save, isLeader, syncFromDisk,
  backup: tag => { try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.' + tag + '-' + Date.now()); } catch (e) {} } });

function summary() {
  const out = {};
  for (const [k, st] of Object.entries(S.strategies)) {
    const levSum = STRATS[k] && STRATS[k].kind === 'lev' ? lev.summarise(st) : null;
    const openVal = levSum ? levSum.openValue : st.open.reduce((s, t) => s + t.qty * (t.lastPrice || t.entryPrice) * (1 - COST), 0);
    const wins = st.closed.filter(t => t.pnl > 0).length;
    const realised = st.closed.reduce((s, t) => s + t.pnl, 0);
    const equity = st.cash + openVal;
    out[k] = {
      name: (STRATS[k] || {}).name || k, rule: (STRATS[k] || {}).rule || '', off: !!(STRATS[k] || {}).off, offNote: (STRATS[k] || {}).offNote || null,
      positionUsd: (STRATS[k] || {}).positionUsd || POSITION_USD, cooling: Object.entries(st.cooldown || {}).filter(([c, v]) => !c.startsWith('sym:') && v > Date.now()).length, startedAt: st.startedAt || S.started, start: START_BALANCE, cash: st.cash, openValue: openVal, equity,
      pnl: equity - START_BALANCE, pnlPct: (equity - START_BALANCE) / START_BALANCE * 100, realised,
      trades: st.closed.length, wins, winRate: st.closed.length ? wins / st.closed.length * 100 : null,
      best: st.closed.reduce((b, t) => (!b || t.pnlPct > b.pnlPct ? t : b), null),
      worst: st.closed.reduce((b, t) => (!b || t.pnlPct < b.pnlPct ? t : b), null),
      open: st.open.map(t => ({ ...t, value: t.qty * (t.lastPrice || t.entryPrice) * (1 - COST), pnlPct: ((t.lastPrice || t.entryPrice) / t.entryPrice - 1) * 100 })),
      recouped: st.closed.filter(t => t.recouped).length + st.open.filter(t => t.recouped).length,
      closed: st.closed.slice(0, 100),
    };
    if (STRATS[k] && STRATS[k].kind === 'copy') out[k].copy = copy.info();
    if (levSum) Object.assign(out[k], { kind: 'lev', open: levSum.open, longs: levSum.longs, shorts: levSum.shorts, positionUsd: levMod.LEV.marginUsd, leverage: levMod.LEV.leverage, scan: (S.lev && S.lev.scan) || null, error: lev.error });
  }
  return out;
}

module.exports = function mountPaper(app) {
  if (!global.__PAPER_TIMERS) {
    global.__PAPER_TIMERS = [setInterval(scan, SCAN_MS), setInterval(checkPrices, PRICE_MS), setInterval(lev.tick, levMod.LEV.tickMs), setInterval(copy.tick, walletsMod.W.pollMs), setInterval(manual.tick, manualMod.MAN.tickMs)];
    setTimeout(copy.tick, 15000);
    setTimeout(scan, 3000);
    setTimeout(lev.tick, 8000);
  }
  manual.mount(app);
  app.get('/api/paper', (req, res) => {
    syncFromDisk();
    res.json({ ok: true, started: S.started, safety: SAFETY, skipped: (S.skipped || []).slice(0, 50), skippedCount: S.skippedCount || 0, lastScan: lastScan || S.lastScan || null, lastPrice: lastPrice || S.lastPrice || null, error: lastError,
      settings: { startBalance: START_BALANCE, positionUsd: POSITION_USD, freshPositionUsd: STRATS.fresh.positionUsd, breakEvenAtPct: BE_TRIGGER * 100, trailPct: TRAIL * 100, cooldownH: COOLDOWN_H, maxOpen: MAX_OPEN, takeProfitPct: TAKE_PROFIT * 100, recoupPct: RECOUP_AT * 100, runnerPct: RUNNER_TP * 100, stopLossPct: STOP_LOSS * 100, maxHoldH: MAX_HOLD_H, costPct: COST * 100 },
      strategies: summary() });
  });
  // Reset wipes the fake trades only. A copy of the old file is kept, and the copy-wallets research (scored and watched
  // wallets) carries over, since it isn't trading history and takes days to rebuild.
  app.post('/api/paper/reset', (req, res) => {
    try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.before-reset-' + Date.now()); } catch (e) {}
    const keep = S.copy, keepManual = S.manual, keepManualHist = S.manualHistory; S = blank();
    if (keep) S.copy = { ...keep, buys: [], sells: [], job: null };
    if (keepManual) { S.manual = keepManual; S.manualHistory = keepManualHist; } // your own leverage account has its own Reset
    save(); setTimeout(scan, 500); res.json({ ok: true });
  });
};
module.exports._checkPrices = checkPrices; // used by tests
module.exports._scan = scan; // used by tests
module.exports._socialsCheck = socialsCheck; // used by tests
module.exports._chartCheck = chartCheck; // used by tests
module.exports._chartRules = chartRules; // used by tests
module.exports._updateStop = updateStop; // used by tests
module.exports._closeTrade = closeTrade; // used by tests
module.exports._onCooldown = onCooldown; // used by tests
module.exports._pruneCooldowns = pruneCooldowns; // used by tests
module.exports._STRATS = STRATS; // used by tests
module.exports._copy = copy; // used by tests
module.exports._state = () => S; // used by tests
module.exports._manual = manual; // used by tests
