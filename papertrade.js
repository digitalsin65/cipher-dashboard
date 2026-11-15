// Paper trading: simulated Solana meme coin trades with fake money, using live DexScreener data.
// No real wallet, no real orders. Two strategies run side by side, each with its own fake balance.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = process.env.PAPER_FILE || path.join(os.homedir(), 'cipher-data', 'papertrade.json');
const DS = 'https://api.dexscreener.com';
const START_BALANCE = 1000;      // US$ per strategy
const POSITION_USD = 100;        // US$ per trade
const MAX_OPEN = 8;              // per strategy
const TAKE_PROFIT = 0.50;        // +50%
const STOP_LOSS = -0.25;         // -25%
const MAX_HOLD_H = 48;           // close stale trades so fake money isn't stuck forever
const COST = 0.01;               // 1% simulated swap fee + slippage on each side
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

const STRATS = {
  fresh: {
    name: 'Fresh launches',
    rule: 'Pair 15 min to 6 h old, liquidity at least US$10k, market cap US$20k to US$2M, 1 h volume at least US$20k, more buys than sells in the last 5 min and 1 h, up in the last hour but not more than 300%.',
    pick(p, ageH) {
      const liq = p.liquidity?.usd || 0, mc = p.marketCap || p.fdv || 0;
      const t5 = p.txns?.m5 || {}, t1 = p.txns?.h1 || {};
      const ch1 = p.priceChange?.h1 ?? 0;
      return ageH >= 0.25 && ageH <= 6 && liq >= 10000 && mc >= 20000 && mc <= 2e6 &&
        (p.volume?.h1 || 0) >= 20000 && t5.buys > t5.sells && t1.buys > t1.sells * 1.2 && ch1 > 0 && ch1 < 300;
    },
  },
  trending: {
    name: 'Trending coins',
    rule: 'Pair over 24 h old, liquidity at least US$50k, 24 h volume at least US$250k, up 5% to 60% in the last hour and up over the last 6 h, more buys than sells in the last hour.',
    pick(p, ageH) {
      const liq = p.liquidity?.usd || 0, t1 = p.txns?.h1 || {};
      const ch1 = p.priceChange?.h1 ?? 0, ch6 = p.priceChange?.h6 ?? 0;
      return ageH >= 24 && liq >= 50000 && (p.volume?.h24 || 0) >= 250000 &&
        ch1 >= 5 && ch1 <= 60 && ch6 > 0 && t1.buys > t1.sells;
    },
  },
};

function blank() {
  const s = { started: Date.now(), seen: {}, strategies: {} };
  for (const k of Object.keys(STRATS)) s.strategies[k] = { cash: START_BALANCE, open: [], closed: [] };
  return s;
}
function load() { try { const s = JSON.parse(fs.readFileSync(FILE, 'utf8')); return s && s.strategies ? s : blank(); } catch (e) { return blank(); } }
function save() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(S)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.warn('[paper] save failed', e.message); } }

let S = load();
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

function closeTrade(st, t, price, reason) {
  const gross = t.qty * price;
  const proceeds = gross * (1 - COST);
  st.cash += proceeds;
  const pnl = proceeds - t.cost;
  st.open = st.open.filter(x => x !== t);
  st.closed.unshift({ ...t, exitPrice: price, exitAt: Date.now(), proceeds, pnl, pnlPct: pnl / t.cost * 100, reason });
  if (st.closed.length > 500) st.closed.length = 500;
}

async function scan() {
  if (scanning) return; scanning = true;
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
    const held = new Set();
    for (const st of Object.values(S.strategies)) { st.open.forEach(t => held.add(t.token)); st.closed.forEach(t => held.add(t.token)); }
    addrs = addrs.filter(a => !held.has(a)); // never re-buy a token either strategy already traded
    const pairs = await pairsFor(addrs);
    for (const [key, def] of Object.entries(STRATS)) {
      const st = S.strategies[key];
      const cands = Object.values(pairs).filter(p => {
        const ageH = p.pairCreatedAt ? (now - p.pairCreatedAt) / 3600e3 : 0;
        return +p.priceUsd > 0 && def.pick(p, ageH);
      }).sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0));
      for (const p of cands) {
        if (st.open.length >= MAX_OPEN || st.cash < POSITION_USD) break;
        if (held.has(p.baseToken.address)) continue;
        const safe = await safetyCheck(p.baseToken.address);
        if (!safe.ok) {
          S.skipped = S.skipped || [];
          if (!S.skipped.some(x => x.token === p.baseToken.address && Date.now() - x.at < 6 * 3600e3)) {
            S.skipped.unshift({ at: Date.now(), strat: key, token: p.baseToken.address, symbol: p.baseToken.symbol, url: p.url, reasons: safe.reasons });
            if (S.skipped.length > 200) S.skipped.length = 200;
            S.skippedCount = (S.skippedCount || 0) + 1;
          }
          continue;
        }
        const price = +p.priceUsd;
        const qty = POSITION_USD * (1 - COST) / price;
        st.cash -= POSITION_USD;
        st.open.push({
          id: key + '-' + now + '-' + p.baseToken.address.slice(0, 6), token: p.baseToken.address,
          symbol: p.baseToken.symbol, name: p.baseToken.name, pair: p.pairAddress, dex: p.dexId, url: p.url,
          entryPrice: price, qty, cost: POSITION_USD, openedAt: now,
          entry: { liq: p.liquidity?.usd || 0, mc: p.marketCap || p.fdv || 0, vol1h: p.volume?.h1 || 0, ch1h: p.priceChange?.h1 ?? null },
          lastPrice: price, lastLiq: p.liquidity?.usd || 0, peak: price, safety: safe.info,
        });
        held.add(p.baseToken.address);
      }
    }
    lastScan = now; lastError = null; save();
  } catch (e) { lastError = e.message; console.warn('[paper] scan failed', e.message); }
  finally { scanning = false; }
}

async function checkPrices() {
  const open = Object.entries(S.strategies).flatMap(([k, st]) => st.open.map(t => [k, t]));
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
      t.lastPrice = price; t.lastLiq = liq; t.peak = Math.max(t.peak || price, price); t.lastAt = now;
      const ch = price / t.entryPrice - 1;
      if (ch >= TAKE_PROFIT) closeTrade(st, t, price, 'Take profit');
      else if (ch <= STOP_LOSS) closeTrade(st, t, price, 'Stop loss');
      else if (t.entry.liq > 0 && liq < t.entry.liq * 0.2) closeTrade(st, t, price, 'Liquidity pulled');
      else if (now - t.openedAt > MAX_HOLD_H * 3600e3) closeTrade(st, t, price, 'Time limit (48 h)');
    }
    lastPrice = now; save();
  } catch (e) { lastError = e.message; console.warn('[paper] price check failed', e.message); }
}

function summary() {
  const out = {};
  for (const [k, st] of Object.entries(S.strategies)) {
    const openVal = st.open.reduce((s, t) => s + t.qty * (t.lastPrice || t.entryPrice) * (1 - COST), 0);
    const wins = st.closed.filter(t => t.pnl > 0).length;
    const realised = st.closed.reduce((s, t) => s + t.pnl, 0);
    const equity = st.cash + openVal;
    out[k] = {
      name: STRATS[k].name, rule: STRATS[k].rule, start: START_BALANCE, cash: st.cash, openValue: openVal, equity,
      pnl: equity - START_BALANCE, pnlPct: (equity - START_BALANCE) / START_BALANCE * 100, realised,
      trades: st.closed.length, wins, winRate: st.closed.length ? wins / st.closed.length * 100 : null,
      best: st.closed.reduce((b, t) => (!b || t.pnlPct > b.pnlPct ? t : b), null),
      worst: st.closed.reduce((b, t) => (!b || t.pnlPct < b.pnlPct ? t : b), null),
      open: st.open.map(t => ({ ...t, value: t.qty * (t.lastPrice || t.entryPrice) * (1 - COST), pnlPct: ((t.lastPrice || t.entryPrice) / t.entryPrice - 1) * 100 })),
      closed: st.closed.slice(0, 100),
    };
  }
  return out;
}

module.exports = function mountPaper(app) {
  if (!global.__PAPER_TIMERS) {
    global.__PAPER_TIMERS = [setInterval(scan, SCAN_MS), setInterval(checkPrices, PRICE_MS)];
    setTimeout(scan, 3000);
  }
  app.get('/api/paper', (req, res) => {
    res.json({ ok: true, started: S.started, safety: SAFETY, skipped: (S.skipped || []).slice(0, 50), skippedCount: S.skippedCount || 0, lastScan, lastPrice, error: lastError,
      settings: { startBalance: START_BALANCE, positionUsd: POSITION_USD, maxOpen: MAX_OPEN, takeProfitPct: TAKE_PROFIT * 100, stopLossPct: STOP_LOSS * 100, maxHoldH: MAX_HOLD_H, costPct: COST * 100 },
      strategies: summary() });
  });
  app.post('/api/paper/reset', (req, res) => { S = blank(); save(); setTimeout(scan, 500); res.json({ ok: true }); });
};
