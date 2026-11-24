// Run: node test-wallets.js   (copy smart wallets: swap parsing, wallet scoring, signals, exits)
const assert = require('assert');
const C = require('./wallets');
const near = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, msg + ': got ' + a + ', expected ' + b);
const WAL = 'WALLET1111111111111111111111111111111111111', MEME = 'MEME11111111111111111111111111111111111pump', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const bal = (mint, owner, amt) => ({ mint, owner, uiTokenAmount: { uiAmountString: String(amt) } });
const tx = ({ pre = [], post = [], lamPre = 10e9, lamPost = 10e9, err = null, fee = 5000, payer = WAL, time = 1_800_000_000 }) => ({
  blockTime: time, meta: { err, fee, preBalances: [lamPre, 0], postBalances: [lamPost, 0], preTokenBalances: pre, postTokenBalances: post },
  transaction: { signatures: ['SIG' + time], message: { accountKeys: [{ pubkey: payer }, { pubkey: 'POOL' }] } },
});

// ---- parseSwap ----
// buy: 1 SOL out (plus fee), 1000 MEME in
let s = C.parseSwap(tx({ pre: [], post: [bal(MEME, WAL, 1000)], lamPre: 10e9, lamPost: 9e9 - 5000 }), WAL);
assert.strictEqual(s.side, 'buy'); assert.strictEqual(s.mint, MEME); near(s.tokenAmt, 1000, 'tokens'); near(s.sol, 1, 'SOL spent, fee not counted');
// sell paid in wrapped SOL
s = C.parseSwap(tx({ pre: [bal(MEME, WAL, 1000), bal(C.SOL, WAL, 0)], post: [bal(MEME, WAL, 0), bal(C.SOL, WAL, 1.5)], lamPost: 10e9 - 5000 }), WAL);
assert.strictEqual(s.side, 'sell'); near(s.sol, 1.5, 'WSOL received'); near(s.tokenAmt, 1000, 'sold all');
// buy paid in USDC, valued in SOL at the given SOL price
s = C.parseSwap(tx({ pre: [bal(USDC, WAL, 300)], post: [bal(USDC, WAL, 0), bal(MEME, WAL, 50)], lamPost: 10e9 - 5000 }), WAL, 150);
assert.strictEqual(s.side, 'buy'); near(s.sol, 2, 'US$300 at US$150/SOL = 2 SOL');
// someone else's balances are ignored; failed tx, plain transfer and two-token swaps are not swaps
assert.strictEqual(C.parseSwap(tx({ post: [bal(MEME, 'OTHER', 1000)], lamPost: 9e9 }), WAL), null);
assert.strictEqual(C.parseSwap(tx({ post: [bal(MEME, WAL, 1000)], lamPost: 9e9, err: { x: 1 } }), WAL), null);
assert.strictEqual(C.parseSwap(tx({ lamPost: 9e9 }), WAL), null, 'SOL transfer only');
assert.strictEqual(C.parseSwap(tx({ post: [bal(MEME, WAL, 5), bal('OTHERMINT', WAL, 5)], lamPost: 9e9 }), WAL), null);
assert.strictEqual(C.parseSwap(tx({ post: [bal(MEME, WAL, 1000)], lamPost: 10e9 }), WAL), null, 'tokens in with no SOL out = airdrop/transfer');

// ---- scoreSwaps ----
const sw = (mint, side, tokenAmt, sol, time) => ({ mint, side, tokenAmt, sol, time });
let sc = C.scoreSwaps([
  sw('A', 'buy', 100, 1, 1), sw('A', 'sell', 100, 2, 2),        // win +1
  sw('B', 'buy', 100, 1, 3), sw('B', 'sell', 95, 0.5, 4),       // loss -0.5 (95% sold counts as closed)
  sw('C', 'buy', 100, 1, 5), sw('C', 'sell', 50, 3, 6),         // only half sold: still open, not counted
  sw('D', 'sell', 100, 5, 7),                                   // bought before our window: ignored
  sw('E', 'buy', 50, 1, 8), sw('E', 'buy', 50, 1, 9), sw('E', 'sell', 100, 2.4, 10), // two buys, one sell: win +0.4
]);
assert.strictEqual(sc.trades, 3); assert.strictEqual(sc.wins, 2); near(sc.winRate, 200 / 3, 'win rate'); near(sc.pnlSol, 0.9, 'realised SOL');
// qualifies / drop rules
assert.ok(C.qualifies({ txPerDay: 40, trades: 25, winRate: 60, pnlSol: 3 }));
assert.ok(!C.qualifies({ txPerDay: 40, trades: 19, winRate: 60, pnlSol: 3 }), 'too few trades');
assert.ok(!C.qualifies({ txPerDay: 40, trades: 25, winRate: 54, pnlSol: 3 }), 'win rate too low');
assert.ok(!C.qualifies({ txPerDay: 40, trades: 25, winRate: 70, pnlSol: -1 }), 'losing money');
assert.ok(!C.qualifies({ txPerDay: 500, trades: 25, winRate: 70, pnlSol: 3 }), 'bot');
assert.ok(C.shouldDrop({ txPerDay: 40, trades: 25, winRate: 44, pnlSol: 3 }) && C.shouldDrop({ txPerDay: 40, trades: 25, winRate: 60, pnlSol: -0.1 }));
assert.ok(!C.shouldDrop({ txPerDay: 40, trades: 25, winRate: 50, pnlSol: 1 }), 'slipping a bit (50%) is kept');

// ---- signals ----
const now = 1_800_000_000_000, min = 60e3;
const buy = (wallet, mint, ago, sol = 1) => ({ wallet, mint, time: now - ago * min, sol, tokenAmt: 1000 });
const scores = { W1: { winRate: 60, trades: 25, pnlSol: 2 }, W2: { winRate: 60, trades: 25, pnlSol: 2 }, STAR: { winRate: 80, trades: 45, pnlSol: 9 } };
let sig = C.findSignals([buy('W1', 'X', 20), buy('W2', 'X', 5)], scores, now);
assert.strictEqual(sig.length, 1); assert.deepStrictEqual(sig[0].wallets.sort(), ['W1', 'W2']); assert.strictEqual(sig[0].firstAt, now - 20 * min);
assert.strictEqual(C.findSignals([buy('W1', 'X', 40), buy('W2', 'X', 5)], scores, now).length, 0, 'first buy outside 30 min');
assert.strictEqual(C.findSignals([buy('W1', 'X', 10), buy('W1', 'X', 5)], scores, now).length, 0, 'same wallet twice is one wallet');
assert.strictEqual(C.findSignals([buy('STAR', 'Y', 3)], scores, now).length, 1, 'one very strong wallet is enough');
assert.strictEqual(C.findSignals([buy('W1', 'X', 10, 0.05), buy('W2', 'X', 5)], scores, now).length, 0, 'dust buys ignored');

// ---- exits: majority of copied wallets sold ----
const sells = [{ wallet: 'W1', mint: 'X', time: now }, { wallet: 'W9', mint: 'X', time: now }, { wallet: 'W2', mint: 'X', time: now - 60 * min }];
assert.deepStrictEqual(C.majoritySold(sells, 'X', ['W1', 'W2'], now - 30 * min), { sold: 1, of: 2, majority: false }, 'old sell and outsiders ignored; 1 of 2 is not a majority');
assert.strictEqual(C.majoritySold([...sells, { wallet: 'W2', mint: 'X', time: now }], 'X', ['W1', 'W2'], now - 30 * min).majority, true);
assert.strictEqual(C.majoritySold(sells, 'X', ['W1'], now - 30 * min).majority, true, 'single strong wallet sold');

// ---- candidate wallets from pump trades ----
const tr = (w, kind, usd) => ({ attributes: { tx_from_address: w, kind, volume_in_usd: String(usd) } });
assert.deepStrictEqual(C.candidatesFromTrades([tr('A', 'sell', 150), tr('A', 'sell', 100), tr('B', 'sell', 900), tr('C', 'buy', 5000), tr('D', 'sell', 50)]), ['B', 'A']);

// candidates: sellers who put more in than they took out (in the visible trades) are skipped
assert.deepStrictEqual(C.candidatesFromTrades([tr('A', 'sell', 300), tr('A', 'buy', 5000), tr('B', 'sell', 400), tr('B', 'buy', 100), tr('E', 'sell', 250)]), ['B', 'E']);
assert.deepStrictEqual(C.interleave([['a1', 'a2', 'a3'], ['b1'], ['c1', 'a1', 'c2']]), ['a1', 'b1', 'c1', 'a2', 'a3', 'c2'], 'one coin can\'t fill the queue; duplicates once');

// ---- history check: throwaway wallets and bots are caught from the signature list alone ----
const NOWS = 1_800_000_000; // seconds
const sigList = (n, spanDays) => Array.from({ length: n }, (_, i) => ({ signature: 'S' + i, err: null, blockTime: NOWS - Math.round(i / Math.max(n - 1, 1) * spanDays * 86400) }));
let h = C.historyCheck(sigList(12, 0.5), NOWS * 1000); assert.ok(h.fresh && !h.bot, 'burner: 12 tx over half a day');
h = C.historyCheck(sigList(120, 1), NOWS * 1000); assert.ok(h.fresh, 'busy but only a day old');
h = C.historyCheck(sigList(1000, 1), NOWS * 1000); assert.ok(h.bot && !h.fresh, '1000 tx in a day = bot'); assert.ok(h.txPerDay > 300);
h = C.historyCheck(sigList(400, 8), NOWS * 1000); assert.ok(!h.fresh && !h.bot, 'established trader'); near(h.txPerDay, 50, 'tx/day', 0.1);
h = C.historyCheck(sigList(1000, 30), NOWS * 1000); assert.ok(!h.fresh && !h.bot, '1000 tx over 30 days: fine');

// ---- rejection reasons (in order) and drop reasons ----
const base = { txPerDay: 40, trades: 25, winRate: 60, pnlSol: 3 };
assert.strictEqual(C.rejectReason(base), null);
assert.strictEqual(C.rejectReason({ ...base, bot: true }), 'bot');
assert.strictEqual(C.rejectReason({ ...base, txPerDay: 400 }), 'bot');
assert.strictEqual(C.rejectReason({ ...base, fresh: true, trades: 0 }), 'fresh');
assert.ok(!C.qualifies({ ...base, fresh: true }), 'fresh wallets never qualify');
assert.strictEqual(C.rejectReason({ ...base, trades: 0, buys: 0, unboughtSells: 40 }), 'insider', 'sells only coins it never bought');
assert.strictEqual(C.rejectReason({ ...base, trades: 5, buys: 10, unboughtSells: 12 }), 'fewTrades', 'some unbought sells but also buys: just too few trades');
assert.strictEqual(C.rejectReason({ ...base, trades: 19 }), 'fewTrades');
assert.strictEqual(C.rejectReason({ ...base, winRate: 70, pnlSol: -1 }), 'losing');
assert.strictEqual(C.rejectReason({ ...base, winRate: 50 }), 'lowWin');
assert.ok(C.REASONS.fresh && C.REASONS.insider && C.REASONS.fewTrades && C.REASONS.losing && C.REASONS.lowWin && C.REASONS.bot);
assert.strictEqual(C.dropReason(base), null);
assert.match(C.dropReason({ ...base, pnlSol: -0.1 }), /losing/);
assert.match(C.dropReason({ ...base, winRate: 40 }), /win rate/);
assert.match(C.dropReason({ ...base, bot: true }), /bot/);
// scoreSwaps counts sells of coins never bought in the window
sc = C.scoreSwaps([sw('Z', 'sell', 10, 1, 1), sw('Z', 'sell', 10, 1, 2), sw('Y', 'buy', 5, 1, 3)]);
assert.strictEqual(sc.unboughtSells, 2); assert.strictEqual(sc.buys, 1);

// ---- engine, end to end with a fake Solana RPC: rejection reasons, watchlist, re-score drops ----
(async () => {
  C.W.rpcGapMs = 0;
  const nowMs = Date.now(), nowS = Math.floor(nowMs / 1000);
  let goodWins = true; // flips to make the GOOD wallet a loser on its re-check
  const sigsFor = (w, n, spanDays) => Array.from({ length: n }, (_, i) => ({ signature: w + '-' + i, err: null, blockTime: nowS - 60 - Math.round(i / Math.max(n - 1, 1) * spanDays * 86400) }));
  const SIGS = { FRESHW: sigsFor('FRESHW', 9, 0.4), BOTW: sigsFor('BOTW', 1000, 0.5), GOODW: sigsFor('GOODW', 60, 10), DUMPW: sigsFor('DUMPW', 60, 10) };
  const swapTx = (w, i) => { // GOODW: 30 round trips on 30 coins, 2 txs each (buy then sell); 20 of 30 win
    const k = Math.floor(i / 2), isSell = i % 2 === 0, mint = 'M' + k, win = goodWins ? k % 3 !== 0 : k % 3 === 0;
    const solDelta = w === 'DUMPW' ? 2e9 : isSell ? (win ? 1.5e9 : 0.5e9) : -1e9;
    const pre = w === 'DUMPW' || isSell ? [bal(mint, w, 1000)] : [], post = w === 'DUMPW' || isSell ? [bal(mint, w, 0)] : [bal(mint, w, 1000)];
    return { blockTime: SIGS[w][i].blockTime, meta: { err: null, fee: 0, preBalances: [10e9, 0], postBalances: [10e9 + solDelta, 0], preTokenBalances: pre, postTokenBalances: post }, transaction: { signatures: [w + '-' + i], message: { accountKeys: [{ pubkey: w }, { pubkey: 'POOL' }] } } };
  };
  global.fetch = async (url, opts) => {
    const ok = j => ({ ok: true, status: 200, json: async () => j });
    if (!String(url).includes('fake-rpc')) return ok([]); // DexScreener etc.
    const { method, params } = JSON.parse(opts.body);
    if (method === 'getSignaturesForAddress') return ok({ result: SIGS[params[0]] || [] });
    const [w, i] = params[0].split('-'); return ok({ result: swapTx(w, +i) });
  };
  const S = { copy: { queue: ['FRESHW', 'BOTW', 'GOODW', 'DUMPW'], lastDiscover: nowMs } };
  let saves = 0;
  const eng = C.createCopy({ getS: () => S, save: () => saves++, isLeader: () => true, syncFromDisk: () => {}, gtGet: async () => ({ data: [] }), rpcUrl: 'http://fake-rpc' });
  for (let i = 0; i < 10 && (S.copy.queue.length || S.copy.job); i++) await eng.tick();
  let inf = eng.info();
  assert.deepStrictEqual(inf.watch.map(x => x.wallet), ['GOODW'], 'good wallet watched');
  assert.strictEqual(inf.watch[0].trades, 30); near(inf.watch[0].winRate, 200 / 3, 'win rate', 1e-6);
  assert.deepStrictEqual(inf.reasons, { fresh: 1, bot: 1, insider: 1 }, 'reasons counted');
  assert.ok(S.copy.budget.calls > 0 && inf.budget.of === C.W.dailyCalls, 'calls counted against the daily budget');
  assert.ok(saves > 0 && S.copy.watch.GOODW, 'watchlist lives in the saved paper state');
  // three days later GOOD turns into a loser: re-scored and dropped with a reason
  S.copy.watch.GOODW.scoredAt = S.copy.scored.GOODW.scoredAt = nowMs - 4 * 86400e3; S.copy.lastPoll = 0;
  goodWins = false;
  for (let i = 0; i < 10; i++) { await eng.tick(); if (!S.copy.queue.length && !S.copy.job && !S.copy.watch.GOODW) break; }
  inf = eng.info();
  assert.strictEqual(inf.watch.length, 0, 'dropped from the watchlist');
  assert.strictEqual(inf.dropped[0].wallet, 'GOODW'); assert.match(inf.dropped[0].dropReason, /losing|win rate/);
  assert.strictEqual(inf.reasons.lowWin || inf.reasons.losing, 1, 'and now counted as rejected');

  // ---- paper file safety: an unreadable file falls back to the hourly backup; Reset keeps the wallet research ----
  const fs = require('fs'), os = require('os'), path = require('path');
  const F = path.join(os.tmpdir(), 'paper-wallettest-' + process.pid + '.json');
  fs.writeFileSync(F, '{"strategies": {"fresh": {"cash": 1'); // half-written
  fs.writeFileSync(F + '.bak', JSON.stringify({ started: 1, seen: {}, strategies: { fresh: { cash: 777, open: [], closed: [] } }, copy: { watch: { GOODW: { wallet: 'GOODW', pnlSol: 1 } }, scored: {} } }));
  process.env.PAPER_FILE = F;
  global.__PAPER_TIMERS = []; // don't start the trading timers
  const pt = require('./papertrade');
  assert.strictEqual(pt._state().strategies.fresh.cash, 777, 'restored from backup instead of starting blank');
  assert.ok(fs.readdirSync(os.tmpdir()).some(f => f.startsWith('paper-wallettest-' + process.pid + '.json.unreadable-')), 'unreadable file kept');
  const routes = {}; pt({ get: () => {}, post: (p, fn) => { routes[p] = fn; } });
  routes['/api/paper/reset']({}, { json: () => {} });
  assert.strictEqual(pt._state().strategies.fresh.cash, 1000, 'trades reset');
  assert.ok(pt._state().copy.watch.GOODW, 'watched wallets survive a Reset');
  assert.ok(fs.readdirSync(os.tmpdir()).some(f => f.startsWith('paper-wallettest-' + process.pid + '.json.before-reset-')), 'copy kept before Reset');
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('paper-wallettest-' + process.pid)) fs.unlinkSync(path.join(os.tmpdir(), f));
  console.log('copy wallets: all tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
