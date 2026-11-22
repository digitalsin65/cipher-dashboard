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
console.log('copy wallets: all tests passed');
