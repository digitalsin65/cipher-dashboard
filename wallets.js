// Copy smart wallets: find Solana wallets with a good recent trading record, watch their swaps,
// and signal when two or more of them buy the same meme coin. Read-only, no keys, no real trades.
//
// Data (all free, no key):
//  - Solana JSON-RPC (default api.mainnet-beta.solana.com; set SOLANA_RPC_URL to use your own RPC, e.g. a Helius URL)
//    getSignaturesForAddress + getTransaction, to read a wallet's swaps and score it ourselves.
//  - DexScreener official API: which coins are pumping (to find candidate wallets).
//  - GeckoTerminal public API: recent trades on those coins (who sold into the pump), through the shared throttle.
const W = {
  minWinRate: 55,           // % of closed positions that made money
  minTrades: 20,            // closed positions in the scored history
  maxTxPerDay: 300,         // more than this looks like a bot / MEV (hundreds of trades a day)
  scoreTxs: 200,            // how many recent transactions to read per wallet when scoring on the free public RPC...
  scoreTxsCustom: 400,      // ...and with your own RPC (Helius), which is fast enough to read twice as much history
  minHistoryTx: 50,         // fewer transactions than this in its whole visible history = a fresh throwaway wallet...
  minAgeDays: 3,            // ...or a first transaction less than 3 days ago. Skipped after one cheap call.
  maxWatch: 30, minWatch: 10,
  candidatesPerRefresh: 60, // candidate wallets queued per refresh (most new or bot wallets cost just one call)
  pumpsPerRefresh: 8,       // pumping coins whose recent sellers become candidates
  dailyCalls: 28000,        // RPC calls per day for scoring and discovery (Helius free plan: 1M credits a month)
  pollEachMs: 6e3,          // poll interval grows with the watchlist: 6 s per wallet (30 wallets = every 3 min), at least every minute
  refreshMs: 24 * 3600e3,   // re-discover and re-score once a day
  dropWinRate: 45,          // a watched wallet below this (or with negative P/L) on re-score is dropped
  pollMs: 60e3,             // check watched wallets for new swaps every minute
  signalWindowMs: 30 * 60e3,
  minWallets: 2,            // buyers needed for a signal...
  strongWinRate: 75, strongTrades: 40, // ...or 1 wallet this good
  minBuySol: 0.2,           // ignore dust buys
  rpcGapMs: 1100,           // per method: the public RPC allows about 10 calls per method per 10 s (x-ratelimit-method-limit)
};
const SOL = 'So11111111111111111111111111111111111111112';
const QUOTES = new Set([SOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']); // SOL, USDC, USDT
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

// ---------- Parsing (pure, unit tested) ----------
// From a jsonParsed transaction, work out what `wallet` swapped: one meme token against SOL (or USDC/USDT).
// Returns { sig, time, mint, side: 'buy'|'sell', tokenAmt, sol } (sol = SOL value spent/received), or null.
function parseSwap(tx, wallet, solUsd = 150) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map(k => (typeof k === 'string' ? k : k.pubkey));
  const wi = keys.indexOf(wallet);
  const delta = {};
  const add = (b, sign) => { if (b.owner !== wallet) return; const v = +(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0); delta[b.mint] = (delta[b.mint] || 0) + sign * v; };
  (tx.meta.preTokenBalances || []).forEach(b => add(b, -1));
  (tx.meta.postTokenBalances || []).forEach(b => add(b, 1));
  let sol = 0;
  if (wi >= 0) { sol = ((tx.meta.postBalances[wi] || 0) - (tx.meta.preBalances[wi] || 0)) / 1e9; if (wi === 0) sol += (tx.meta.fee || 0) / 1e9; }
  sol += delta[SOL] || 0;
  for (const m of STABLES) if (delta[m]) sol += delta[m] / solUsd;
  const tokens = Object.entries(delta).filter(([m, v]) => !QUOTES.has(m) && Math.abs(v) > 0);
  if (tokens.length !== 1) return null; // not a simple one-token swap
  const [mint, amt] = tokens[0];
  if (amt > 0 && sol < -0.001) return { sig: tx.transaction.signatures?.[0], time: (tx.blockTime || 0) * 1000, mint, side: 'buy', tokenAmt: amt, sol: -sol };
  if (amt < 0 && sol > 0.001) return { sig: tx.transaction.signatures?.[0], time: (tx.blockTime || 0) * 1000, mint, side: 'sell', tokenAmt: -amt, sol };
  return null;
}
// Score a wallet from its swaps. A "trade" is a token position that was mostly (>=90%) sold; a win if SOL out > SOL in.
function scoreSwaps(swaps) {
  const pos = {};
  for (const s of [...swaps].sort((a, b) => a.time - b.time)) {
    const p = pos[s.mint] = pos[s.mint] || { bought: 0, sold: 0, solIn: 0, solOut: 0, sawBuy: false };
    if (s.side === 'buy') { p.bought += s.tokenAmt; p.solIn += s.sol; p.sawBuy = true; }
    else if (p.sawBuy) { p.sold += s.tokenAmt; p.solOut += s.sol; } // sells of coins bought before our window can't be scored
    else p.unbought = (p.unbought || 0) + 1;
  }
  let trades = 0, wins = 0, pnlSol = 0, buys = 0, unboughtSells = 0;
  for (const s of swaps) if (s.side === 'buy') buys++;
  for (const p of Object.values(pos)) unboughtSells += p.unbought || 0;
  for (const p of Object.values(pos)) {
    if (!p.sawBuy || p.bought <= 0 || p.sold < p.bought * 0.9) continue;
    trades++; const r = p.solOut - p.solIn; pnlSol += r; if (r > 0) wins++;
  }
  return { trades, wins, winRate: trades ? wins / trades * 100 : 0, pnlSol: +pnlSol.toFixed(3), swaps: swaps.length, tokens: Object.keys(pos).length, buys, unboughtSells };
}
function qualifies(sc) { return !sc.bot && !sc.fresh && sc.txPerDay <= W.maxTxPerDay && sc.trades >= W.minTrades && sc.winRate >= W.minWinRate && sc.pnlSol > 0; }
// Why a scored wallet didn't make the watchlist (null if it qualifies). Checked in this order.
const REASONS = { bot: 'bot or very busy (over ' + W.maxTxPerDay + ' tx a day)', fresh: 'new wallet (under ' + W.minHistoryTx + ' tx or under ' + W.minAgeDays + ' days old)', insider: 'only sells coins it never bought (developer or insider)', fewTrades: 'too few closed trades (under ' + W.minTrades + ')', losing: 'losing money', lowWin: 'win rate under ' + W.minWinRate + '%' };
function rejectReason(sc) {
  if (!sc) return 'fewTrades';
  if (sc.bot || sc.txPerDay > W.maxTxPerDay) return 'bot';
  if (sc.fresh) return 'fresh';
  if (sc.trades < W.minTrades && (sc.unboughtSells || 0) >= 10 && sc.unboughtSells >= 3 * (sc.buys || 0)) return 'insider';
  if (sc.trades < W.minTrades) return 'fewTrades';
  if (sc.pnlSol <= 0) return 'losing';
  if (sc.winRate < W.minWinRate) return 'lowWin';
  return null;
}
// Why a watched wallet was dropped on a re-check (null if it stays).
function dropReason(sc) {
  if (!sc) return 'no data';
  if (sc.bot || sc.txPerDay > W.maxTxPerDay) return REASONS.bot;
  if (sc.pnlSol <= 0) return 'now losing money';
  if (sc.winRate < W.dropWinRate) return 'win rate fell under ' + W.dropWinRate + '%';
  if (sc.trades < Math.floor(W.minTrades / 2)) return 'too few closed trades (under ' + Math.floor(W.minTrades / 2) + ')';
  return null;
}
// Look at a wallet's signature list (newest first, up to 1000) and decide if it's a bot or a fresh throwaway wallet.
function historyCheck(sigs, now = Date.now()) {
  const ok = (sigs || []).filter(s => !s.err && s.blockTime);
  const span = ok.length > 1 ? (ok[0].blockTime - ok[ok.length - 1].blockTime) / 86400 : 0;
  const txPerDay = span > 0 ? ok.length / Math.max(span, ok.length >= 1000 ? 0 : 1) : ok.length;
  const ageDays = ok.length ? (now / 1000 - ok[ok.length - 1].blockTime) / 86400 : 0;
  const bot = txPerDay > W.maxTxPerDay;
  const fresh = !bot && (ok.length < W.minHistoryTx || (ok.length < 1000 && ageDays < W.minAgeDays));
  return { ok, txPerDay: +txPerDay.toFixed(1), ageDays: +ageDays.toFixed(1), historyTx: ok.length, bot, fresh };
}
function isStrong(sc) { return sc && sc.winRate >= W.strongWinRate && sc.trades >= W.strongTrades && sc.pnlSol > 0; }
// Signals: buys by watched wallets within the window. Returns [{ mint, wallets, firstAt, firstSol }] that meet the rule.
function findSignals(buys, scores, now = Date.now()) {
  const byMint = {};
  for (const b of buys) {
    if (now - b.time > W.signalWindowMs || b.sol < W.minBuySol) continue;
    const m = byMint[b.mint] = byMint[b.mint] || { mint: b.mint, wallets: new Set(), firstAt: b.time };
    m.wallets.add(b.wallet); m.firstAt = Math.min(m.firstAt, b.time);
  }
  return Object.values(byMint).filter(m => m.wallets.size >= W.minWallets || [...m.wallets].some(w => isStrong(scores[w])))
    .map(m => ({ mint: m.mint, wallets: [...m.wallets], firstAt: m.firstAt }));
}

// ---------- RPC client (throttled) ----------
function createRpc(url) {
  const next = {}; let backoffUntil = 0, calls = 0, backoffMs = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function call(method, params) {
    if (Date.now() < backoffUntil) await sleep(backoffUntil - Date.now());
    const at = Math.max(Date.now(), next[method] || 0); next[method] = at + W.rpcGapMs; if (at > Date.now()) await sleep(at - Date.now());
    calls++;
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { backoffMs = Math.min(backoffMs ? backoffMs * 2 : 15e3, 5 * 60e3); backoffUntil = Date.now() + backoffMs; throw new Error('Solana RPC rate limited'); }
    backoffMs = 0;
    if (!r.ok) throw new Error('Solana RPC HTTP ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error('Solana RPC: ' + (j.error.message || JSON.stringify(j.error)));
    return j.result;
  }
  return { call, get calls() { return calls; } };
}

// Read and score one wallet from its recent history.
async function scoreWallet(rpc, wallet, solUsd) {
  const h = historyCheck(await rpc.call('getSignaturesForAddress', [wallet, { limit: 1000 }])), ok = h.ok;
  const out = { wallet, txPerDay: h.txPerDay, ageDays: h.ageDays, historyTx: h.historyTx, scoredAt: Date.now() };
  if (h.bot || h.fresh) { const r = { ...out, trades: 0, wins: 0, winRate: 0, pnlSol: 0, bot: h.bot, fresh: h.fresh }; return { ...r, reason: rejectReason(r) }; }
  const swaps = [];
  for (const s of ok.slice(0, W.scoreTxs)) {
    try { const tx = await rpc.call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]); const sw = parseSwap(tx, wallet, solUsd); if (sw) swaps.push(sw); } catch (e) { if (/rate limited/.test(e.message)) throw e; }
  }
  const sc = scoreSwaps(swaps);
  const days = swaps.length > 1 ? (Math.max(...swaps.map(x => x.time)) - Math.min(...swaps.map(x => x.time))) / 86400e3 : 0;
  const res = { ...out, ...sc, days: +days.toFixed(1), lastSig: ok[0]?.signature || null };
  return { ...res, reason: rejectReason(res) };
}

// Wallets that sold into a pump (from recent trades on coins that are up a lot) are candidates; scoring decides.
// Only sellers who took out more than they put in during the visible trades, best first.
function candidatesFromTrades(trades, minUsd = 200) {
  const sold = {}, bought = {};
  for (const t of trades || []) {
    const a = t.attributes || t, w = a.tx_from_address;
    if (!w) continue;
    if (a.kind === 'sell') sold[w] = (sold[w] || 0) + (+a.volume_in_usd || 0);
    else if (a.kind === 'buy') bought[w] = (bought[w] || 0) + (+a.volume_in_usd || 0);
  }
  return Object.entries(sold).filter(([w, v]) => v >= minUsd && v > (bought[w] || 0))
    .map(([w, v]) => [w, v - (bought[w] || 0)]).sort((a, b) => b[1] - a[1]).map(([w]) => w);
}
// Has a majority of the wallets that triggered a copy trade sold that coin since?
function majoritySold(sells, mint, wallets, since) {
  const sold = new Set(sells.filter(x => x.mint === mint && x.time >= since && wallets.includes(x.wallet)).map(x => x.wallet));
  return { sold: sold.size, of: wallets.length, majority: sold.size * 2 > wallets.length };
}
// Re-check a watched wallet: drop it if it turned bad.
function shouldDrop(sc) { return !!dropReason(sc); }
// Take candidates from several coins in turn, so one coin's sellers can't fill the whole queue.
function interleave(lists) {
  const out = [], seen = new Set();
  for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length && !seen.has(l[i])) { seen.add(l[i]); out.push(l[i]); }
  return out;
}

// ---------- Engine ----------
// getS/save/isLeader/syncFromDisk: the paper trader's shared state helpers. gtGet(url): GeckoTerminal fetch via the shared throttle.
function createCopy({ getS, save, isLeader, syncFromDisk, gtGet, rpcUrl }) {
  const rpc = createRpc(rpcUrl || 'https://api.mainnet-beta.solana.com');
  let busy = false, lastErr = null, solUsd = 0, solAt = 0;
  const DS = 'https://api.dexscreener.com';
  const getJson = async u => { const r = await fetch(u, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  async function refreshSolUsd() {
    if (Date.now() - solAt < 10 * 60e3 && solUsd) return;
    const arr = await getJson(DS + '/tokens/v1/solana/' + SOL);
    const p = (arr || []).filter(x => x.baseToken?.address === SOL && /USD/.test(x.quoteToken?.symbol || '')).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (p && +p.priceUsd > 0) { solUsd = +p.priceUsd; solAt = Date.now(); }
  }
  async function discover(C) {
    const addrs = new Set();
    for (const u of ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1']) {
      try { for (const x of await getJson(DS + u)) if (x.chainId === 'solana') addrs.add(x.tokenAddress); } catch (e) {}
    }
    const A = [...addrs], best = {};
    for (let i = 0; i < A.length; i += 30) {
      try { for (const p of await getJson(DS + '/tokens/v1/solana/' + A.slice(i, i + 30).join(','))) { const a = p.baseToken?.address; if (a && (!best[a] || (p.liquidity?.usd || 0) > (best[a].liquidity?.usd || 0))) best[a] = p; } } catch (e) {}
    }
    const isPump = (chg, liq, vol) => chg >= 50 && liq >= 20000 && vol >= 100000;
    const pumps = Object.values(best).filter(p => isPump(Math.max(p.priceChange?.h24 || 0, p.priceChange?.h6 || 0), p.liquidity?.usd || 0, p.volume?.h24 || 0))
      .map(p => ({ pool: p.pairAddress, symbol: p.baseToken?.symbol, vol: p.volume?.h24 || 0 }));
    // GeckoTerminal's trending Solana pools add coins that aren't paying for DexScreener promotion
    try {
      const d = await gtGet('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=24h');
      for (const x of d.data || []) {
        const a = x.attributes || {}, pool = a.address;
        if (!pool || pumps.some(p => p.pool === pool)) continue;
        const chg = Math.max(+a.price_change_percentage?.h24 || 0, +a.price_change_percentage?.h6 || 0);
        if (isPump(chg, +a.reserve_in_usd || 0, +a.volume_usd?.h24 || 0)) pumps.push({ pool, symbol: (a.name || '').split(' / ')[0], vol: +a.volume_usd.h24 });
      }
    } catch (e) {}
    pumps.sort((a, b) => b.vol - a.vol); pumps.length = Math.min(pumps.length, W.pumpsPerRefresh);
    const lists = [];
    for (const p of pumps) {
      try { const d = await gtGet('https://api.geckoterminal.com/api/v2/networks/solana/pools/' + p.pool + '/trades?trade_volume_in_usd_greater_than=100'); lists.push(candidatesFromTrades(d.data)); } catch (e) { if (/rate limit/i.test(e.message)) break; }
    }
    const recent = w => C.scored[w] && Date.now() - C.scored[w].scoredAt < 3 * 86400e3;
    const queue = interleave(lists).filter(w => !C.watch[w] && !recent(w) && !C.queue.includes(w)).slice(0, W.candidatesPerRefresh);
    C.queue.push(...queue);
    C.lastDiscover = Date.now(); C.lastDiscoverInfo = { at: Date.now(), pumps: pumps.map(p => p.symbol), candidates: queue.length };
  }
  // read new swaps of watched wallets (newest signatures since the last one we saw)
  async function poll(C, S0) {
    const now = Date.now();
    if (C.lastPoll && now - C.lastPoll < Math.max(W.pollMs, Object.keys(C.watch).length * W.pollEachMs) - 5e3) return;
    for (const w of Object.keys(C.watch)) {
      if (getS() !== S0) return;
      const opts = { limit: 25 }; if (C.lastSig[w]) opts.until = C.lastSig[w];
      let sigs; try { sigs = await rpc.call('getSignaturesForAddress', [w, opts]); } catch (e) { if (/rate limited/.test(e.message)) throw e; continue; }
      if (!sigs.length) continue;
      const first = !C.lastSig[w];
      C.lastSig[w] = sigs[0].signature;
      if (first) continue; // first look: just remember where we are
      for (const s of sigs.filter(x => !x.err && x.blockTime && now - x.blockTime * 1000 < W.signalWindowMs * 2).reverse()) {
        try {
          const tx = await rpc.call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
          const sw = parseSwap(tx, w, solUsd || 150);
          if (!sw) continue;
          const rec = { wallet: w, mint: sw.mint, time: sw.time, sol: +sw.sol.toFixed(4), tokenAmt: sw.tokenAmt, sig: sw.sig };
          (sw.side === 'buy' ? C.buys : C.sells).unshift(rec);
        } catch (e) { if (/rate limited/.test(e.message)) throw e; }
      }
    }
    C.buys = C.buys.filter(b => now - b.time < 2 * 3600e3).slice(0, 1000);
    C.sells = C.sells.filter(b => now - b.time < 72 * 3600e3).slice(0, 3000);
    C.lastPoll = now;
  }
  function dropWallet(C, res, why) {
    delete C.watch[res.wallet];
    C.dropped.unshift({ ...res, dropReason: why, droppedAt: Date.now() }); C.dropped.length = Math.min(C.dropped.length, 50);
  }
  // RPC calls used today (UTC day), kept in the paper file so a restart doesn't reset the count
  function callBudget(C) { const day = new Date().toISOString().slice(0, 10); if (!C.budget || C.budget.day !== day) C.budget = { day, calls: 0 }; return C.budget; }
  // score candidates (and re-score watched wallets every 3 days), a slice at a time so polling isn't held up
  async function scoreSome(C, S0, budget) {
    const now = Date.now();
    for (const [w, sc] of Object.entries(C.watch)) if (now - sc.scoredAt > 3 * 86400e3 && !C.queue.includes(w) && C.job?.wallet !== w) C.queue.push(w);
    while (budget > 0) {
      if (getS() !== S0) return;
      if (!C.job) {
        const w = C.queue.shift(); if (!w) return;
        let sigs; try { sigs = await rpc.call('getSignaturesForAddress', [w, { limit: 1000 }]); } catch (e) { if (/rate limited/.test(e.message)) C.queue.unshift(w); throw e; }
        budget--;
        const h = historyCheck(sigs, now);
        if (h.bot || (h.fresh && !C.watch[w])) {
          const res = { wallet: w, txPerDay: h.txPerDay, ageDays: h.ageDays, historyTx: h.historyTx, bot: h.bot, fresh: h.fresh, trades: 0, wins: 0, winRate: 0, pnlSol: 0, scoredAt: now };
          res.reason = rejectReason(res); C.scored[w] = res;
          if (C.watch[w]) dropWallet(C, res, REASONS.bot);
          continue;
        }
        C.job = { wallet: w, txPerDay: h.txPerDay, ageDays: h.ageDays, historyTx: h.historyTx, sigs: h.ok.slice(0, rpcUrl ? W.scoreTxsCustom : W.scoreTxs).map(s => s.signature), i: 0, swaps: [] };
      }
      const J = C.job;
      while (budget > 0 && J.i < J.sigs.length) {
        try { const tx = await rpc.call('getTransaction', [J.sigs[J.i], { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]); const sw = parseSwap(tx, J.wallet, solUsd || 150); if (sw) J.swaps.push({ mint: sw.mint, side: sw.side, tokenAmt: sw.tokenAmt, sol: sw.sol, time: sw.time }); }
        catch (e) { if (/rate limited/.test(e.message)) throw e; }
        J.i++; budget--;
        if (getS() !== S0) return;
      }
      if (J.i >= J.sigs.length) {
        const sc = scoreSwaps(J.swaps), times = J.swaps.map(x => x.time);
        const res = { wallet: J.wallet, txPerDay: J.txPerDay, ageDays: J.ageDays, historyTx: J.historyTx, ...sc, days: times.length > 1 ? +((Math.max(...times) - Math.min(...times)) / 86400e3).toFixed(1) : 0, scoredAt: Date.now() };
        res.reason = rejectReason(res);
        C.scored[J.wallet] = res;
        if (C.watch[J.wallet]) { const why = dropReason(res); if (why) dropWallet(C, res, why); else C.watch[J.wallet] = res; }
        else if (qualifies(res)) C.watch[J.wallet] = res;
        // keep the best maxWatch by realised P/L
        const ws = Object.values(C.watch).sort((a, b) => b.pnlSol - a.pnlSol);
        for (const x of ws.slice(W.maxWatch)) dropWallet(C, x, 'replaced by a better wallet (list full)');
        C.job = null;
      }
    }
  }
  async function tick() {
    if (busy) return;
    syncFromDisk();
    if (!isLeader()) return;
    busy = true;
    const S0 = getS();
    try {
      S0.copy = S0.copy || {};
      const C = S0.copy;
      C.watch = C.watch || {}; C.scored = C.scored || {}; C.queue = C.queue || []; C.lastSig = C.lastSig || {}; C.buys = C.buys || []; C.sells = C.sells || []; C.dropped = C.dropped || [];
      await refreshSolUsd().catch(() => {});
      const calls0 = rpc.calls;
      if (!C.lastDiscover || Date.now() - C.lastDiscover > W.refreshMs || (!C.queue.length && !C.job && Object.keys(C.watch).length < W.minWatch && Date.now() - C.lastDiscover > 2 * 3600e3)) await discover(C);
      if (getS() !== S0) return;
      await poll(C, S0);
      if (getS() !== S0) return;
      // scoring gets more of the call budget while the watchlist is still being built, and stops for the day at the daily cap
      callBudget(C).calls += rpc.calls - calls0;
      const left = W.dailyCalls - callBudget(C).calls, c1 = rpc.calls;
      if (left > 0) await scoreSome(C, S0, Math.min(left, Object.keys(C.watch).length < W.minWatch ? 45 : 20));
      callBudget(C).calls += rpc.calls - c1;
      for (const k of Object.keys(C.scored)) if (Date.now() - C.scored[k].scoredAt > 7 * 86400e3) delete C.scored[k];
      C.rpcCalls = rpc.calls; C.solUsd = solUsd;
      lastErr = null;
      if (getS() === S0) save();
    } catch (e) { lastErr = e.message; console.warn('[copy] tick failed', e.message); if (getS() === S0) save(); }
    finally { busy = false; }
  }
  // signals for the paper trader's scan: [{ mint, wallets, firstAt, firstPriceSol }]
  function signals(now = Date.now()) {
    const C = getS().copy; if (!C) return [];
    return findSignals(C.buys || [], C.watch || {}, now).map(s => {
      const first = (C.buys || []).filter(b => b.mint === s.mint && s.wallets.includes(b.wallet)).sort((a, b) => a.time - b.time)[0];
      return { ...s, firstPriceSol: first && first.tokenAmt > 0 ? first.sol / first.tokenAmt : null };
    });
  }
  function soldInfo(t) { const C = getS().copy; return C && t.copy ? majoritySold(C.sells || [], t.token, t.copy.wallets, t.copy.firstAt) : null; }
  function rejectCounts(C) {
    const n = {};
    for (const x of Object.values(C.scored || {})) { if (C.watch?.[x.wallet]) continue; const r = x.reason || rejectReason(x) || 'fewTrades'; n[r] = (n[r] || 0) + 1; }
    return n;
  }
  function info() {
    const C = getS().copy || {};
    return { watch: Object.values(C.watch || {}).sort((a, b) => b.pnlSol - a.pnlSol), queued: (C.queue || []).length, scoring: C.job ? { wallet: C.job.wallet, done: C.job.i, of: C.job.sigs.length } : null,
      scoredCount: Object.keys(C.scored || {}).length, rejected: Object.values(C.scored || {}).filter(x => !C.watch?.[x.wallet]).length, dropped: (C.dropped || []).slice(0, 10),
      reasons: rejectCounts(C), reasonLabels: REASONS, budget: C.budget ? { calls: C.budget.calls, of: W.dailyCalls } : null,
      lastDiscover: C.lastDiscoverInfo || null, lastPoll: C.lastPoll || null, rpc: rpcUrl ? 'custom' : 'public', error: lastErr, recentBuys: (C.buys || []).length };
  }
  return { tick, signals, soldInfo, info, get solUsd() { return solUsd; } };
}

module.exports = { W, SOL, REASONS, parseSwap, scoreSwaps, qualifies, rejectReason, dropReason, historyCheck, interleave, isStrong, findSignals, candidatesFromTrades, majoritySold, shouldDrop, createRpc, scoreWallet, createCopy };
