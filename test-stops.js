// Run: node test-stops.js   (stop, break-even, trailing and cooldown rules of the paper trader)
const assert = require('assert');
process.env.PAPER_FILE = require('os').tmpdir() + '/paper-stoptest-' + process.pid + '.json';
const pt = require('./papertrade');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ': got ' + a + ', expected ' + b);
const trade = () => ({ token: 'TOKEN1', symbol: 'DCTY', entryPrice: 1, qty: 99, cost: 100, peak: 1 });
const BE = 1 / 0.99 / 0.99; // break-even price after a 1% fee each way

// 1. Plain stop loss at -25% before the break-even trigger
let t = trade();
assert.strictEqual(pt._updateStop(t, 1.10), null);
near(t.stop, 0.75, 'starts at -25%');
assert.strictEqual(pt._updateStop(t, 0.80), null);
assert.strictEqual(pt._updateStop(t, 0.75), 'Stop loss');

// 2. Break-even trigger at +15%
t = trade();
assert.strictEqual(pt._updateStop(t, 1.149), null); near(t.stop, 0.75, 'not yet at +15%');
assert.strictEqual(pt._updateStop(t, 1.15), null);
near(t.stop, BE, 'stop moves to break-even at +15%'); assert.strictEqual(t.stopKind, 'breakeven');
assert.strictEqual(pt._updateStop(t, 1.05), null, 'still above break-even');
assert.strictEqual(pt._updateStop(t, 1.00), 'Break-even stop');
// selling exactly at the break-even level nets about US$0 after both fees
near(t.qty * BE * 0.99 - t.cost, 0.0000000, 'break-even P/L');

// 3. Trailing stop ratchets up and never down
t = trade();
pt._updateStop(t, 1.20); near(t.stop, BE, 'trail 0.96 is below break-even, so break-even holds');
pt._updateStop(t, 1.40); near(t.stop, 1.12, 'trails 20% below the 1.40 peak'); assert.strictEqual(t.stopKind, 'trail');
pt._updateStop(t, 1.30); near(t.stop, 1.12, 'price dips: stop stays put');
near(t.peak, 1.40, 'peak kept');
pt._updateStop(t, 1.45); near(t.stop, 1.16, 'new peak lifts the stop');
assert.strictEqual(pt._updateStop(t, 1.20), null);
assert.strictEqual(pt._updateStop(t, 1.16), 'Trailing stop');

// 4. Old trades without a saved stop pick it up from their saved peak
t = { ...trade(), peak: 1.30 };
assert.strictEqual(pt._updateStop(t, 1.10), null); near(t.stop, 1.04, 'peak 1.30 -> trailing stop at 1.04');
assert.strictEqual(pt._updateStop(t, 1.03), 'Trailing stop');

// 5. Cooldown: a stop-out at a loss blocks the coin and same-ticker copies for 24 h, only in that strategy
const st = { cash: 0, open: [], closed: [] }, other = { cash: 0, open: [], closed: [] };
t = trade(); st.open.push(t);
pt._updateStop(t, 0.70); pt._closeTrade(st, t, 0.70, 'Stop loss');
const now = Date.now();
assert.ok(pt._onCooldown(st, 'TOKEN1', 'DCTY', now), 'same coin blocked');
assert.ok(pt._onCooldown(st, 'OTHERADDR', 'dcty ', now), 'copycat with the same ticker blocked');
assert.ok(!pt._onCooldown(st, 'OTHERADDR', 'DCTYCAT', now), 'different ticker allowed');
assert.ok(!pt._onCooldown(other, 'TOKEN1', 'DCTY', now), 'other strategies unaffected');
assert.ok(pt._onCooldown(st, 'TOKEN1', 'DCTY', now + 23.9 * 3600e3), 'still blocked at 23.9 h');
assert.ok(!pt._onCooldown(st, 'TOKEN1', 'DCTY', now + 24.1 * 3600e3), 'free again after 24 h');
pt._pruneCooldowns(st, now + 25 * 3600e3); assert.deepStrictEqual(st.cooldown, {}, 'expired cooldowns pruned');
// a trailing stop that sells at a profit does NOT start a cooldown; take profit doesn't either
const st2 = { cash: 0, open: [], closed: [] };
t = { ...trade(), token: 'WIN1', symbol: 'WIN' }; st2.open.push(t); pt._closeTrade(st2, t, 1.20, 'Trailing stop');
t = { ...trade(), token: 'TP1', symbol: 'TP' }; st2.open.push(t); pt._closeTrade(st2, t, 1.50, 'Take profit');
assert.ok(!pt._onCooldown(st2, 'WIN1', 'WIN') && !pt._onCooldown(st2, 'TP1', 'TP'), 'profitable exits: no cooldown');
// a break-even stop that fills slightly below break-even (a loss) does start one
t = { ...trade(), token: 'BE1', symbol: 'BEX' }; st2.open.push(t); pt._closeTrade(st2, t, 1.0, 'Break-even stop');
assert.ok(st2.closed[0].pnl < 0 && pt._onCooldown(st2, 'BE1', 'BEX'), 'losing break-even exit: cooldown');

// 6. Strategy settings
assert.strictEqual(pt._STRATS.fresh.positionUsd, 50);
assert.ok(pt._STRATS.recoup.off && !pt._STRATS.fresh.off && !pt._STRATS.trending.off && !pt._STRATS.chart.off);
console.log('stops and cooldowns: all tests passed');
