// Run: node test-stops.js   (stop, break-even, trailing, chart exits and cooldown rules of the paper trader)
const assert = require('assert');
process.env.PAPER_FILE = require('os').tmpdir() + '/paper-stoptest-' + process.pid + '.json';
const pt = require('./papertrade');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ': got ' + a + ', expected ' + b);
const trade = () => ({ token: 'TOKEN1', symbol: 'DCTY', entryPrice: 1, qty: 99, cost: 100, peak: 1, openedAt: Date.now(), entry: { liq: 80000, vol1h: 40000 } });
const BE = 1 / 0.99 / 0.99; // break-even price after a 1% fee each way
const ago = (h, t = trade()) => { t.openedAt = Date.now() - h * 3600e3; return t; };
const pair = (over = {}) => ({
  priceUsd: 1, liquidity: { usd: 80000 }, volume: { h1: 40000, h6: 120000, h24: 400000 },
  txns: { h1: { buys: 80, sells: 40 } }, priceChange: { m5: 1, h1: 6, h6: 8, h24: 10 },
  pairCreatedAt: Date.now() - 48 * 3600e3, ...over,
});

// 1. Plain stop loss at -20% before the break-even trigger
let t = trade();
assert.strictEqual(pt._updateStop(t, 1.05), null);
near(t.stop, 0.80, 'starts at -20%');
assert.strictEqual(pt._updateStop(t, 0.85), null);
assert.strictEqual(pt._updateStop(t, 0.80), 'Stop loss');
// a saved -25% stop on an older trade is raised to the new -20% floor
t = { ...trade(), stop: 0.75, stopKind: 'stop' };
assert.strictEqual(pt._updateStop(t, 0.90), null);
near(t.stop, 0.80, 'old -25% stop ratchets up to -20%');

// 2. Break-even trigger at +8%
t = trade();
assert.strictEqual(pt._updateStop(t, 1.079), null); near(t.stop, 0.80, 'not yet at +8%');
assert.strictEqual(pt._updateStop(t, 1.08), null);
near(t.stop, BE, 'stop moves to break-even at +8%'); assert.strictEqual(t.stopKind, 'breakeven');
assert.strictEqual(pt._updateStop(t, 1.05), null, 'still above break-even');
assert.strictEqual(pt._updateStop(t, 1.00), 'Break-even stop');
// selling exactly at the break-even level nets about US$0 after both fees
near(t.qty * BE * 0.99 - t.cost, 0.0000000, 'break-even P/L');

// 3. Trailing stop ratchets up, never down, and tightens at +25%
t = trade();
pt._updateStop(t, 1.08); near(t.stop, BE, 'break-even first');
pt._updateStop(t, 1.20); near(t.stop, 1.056, 'trails 12% below the 1.20 peak'); assert.strictEqual(t.stopKind, 'trail');
pt._updateStop(t, 1.24); near(t.stop, 1.0912, 'still 12% trail below +24%');
pt._updateStop(t, 1.25); near(t.stop, 1.125, 'at +25% the trail tightens to 10%');
pt._updateStop(t, 1.40); near(t.stop, 1.26, '10% below the 1.40 peak');
pt._updateStop(t, 1.30); near(t.stop, 1.26, 'price dips: stop stays put');
near(t.peak, 1.40, 'peak kept');
pt._updateStop(t, 1.45); near(t.stop, 1.305, 'new peak lifts the stop');
assert.strictEqual(pt._updateStop(t, 1.31), null);
assert.strictEqual(pt._updateStop(t, 1.305), 'Trailing stop');

// 4. Old trades without a saved stop pick it up from their saved peak
t = { ...trade(), peak: 1.30 };
assert.strictEqual(pt._updateStop(t, 1.20), null); near(t.stop, 1.17, 'peak 1.30 -> 10% trailing stop at 1.17');
assert.strictEqual(pt._updateStop(t, 1.17), 'Trailing stop');

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
// a losing chart-based exit also starts a cooldown, so we don't bounce back into a dead coin
t = { ...trade(), token: 'DEAD1', symbol: 'DEAD' }; st2.open.push(t); pt._closeTrade(st2, t, 0.90, 'Dead chart: volume dried up');
assert.ok(st2.closed[0].pnl < 0 && pt._onCooldown(st2, 'DEAD1', 'DEAD'), 'losing dead-chart exit: cooldown');

// 6. Strategy settings
assert.strictEqual(pt._STRATS.fresh.positionUsd, 50);
assert.ok(pt._STRATS.recoup.off && !pt._STRATS.fresh.off && !pt._STRATS.trending.off && !pt._STRATS.chart.off);

// 7. Dead / fading volume, sell pressure, daily bleed, stalled trade
const healthy = () => ago(3);
assert.strictEqual(pt._momentumExit(healthy(), pair({ priceUsd: 0.95 })), null, 'healthy tape, just red: hold');
// volume collapsed vs entry (25% of US$40k = US$10k)
assert.strictEqual(pt._momentumExit(healthy(), pair({ priceUsd: 0.95, volume: { h1: 9000, h6: 20000, h24: 400000 } })), 'Dead chart: volume dried up');
// already-thin entry volume: absolute US$5k floor after 1 h
t = ago(2); t.entry = { liq: 90000, vol1h: 6000 };
assert.strictEqual(pt._momentumExit(t, pair({ priceUsd: 0.90, volume: { h1: 2500, h6: 8000, h24: 130000 } })), 'Dead chart: volume dried up');
// a running trade is not cut for thin volume
t = ago(3);
assert.strictEqual(pt._momentumExit(t, pair({ priceUsd: 1.12, volume: { h1: 2000, h6: 8000, h24: 130000 } })), null, 'green runner: ignore thin volume');
// too early to call volume dead
assert.strictEqual(pt._momentumExit(ago(0.4), pair({ priceUsd: 0.95, volume: { h1: 1000, h6: 8000, h24: 130000 } })), null, 'first hour: give it time');
// sellers in control while underwater (after 30 min)
assert.strictEqual(pt._momentumExit(ago(0.6), pair({ priceUsd: 0.94, txns: { h1: { buys: 20, sells: 40 } }, priceChange: { h1: -3, h6: 1, h24: 5 } })), 'Momentum broke down');
assert.strictEqual(pt._momentumExit(ago(0.6), pair({ priceUsd: 0.94, txns: { h1: { buys: 2, sells: 4 } } })), null, 'too few trades for a ratio');
assert.strictEqual(pt._momentumExit(ago(0.6), pair({ priceUsd: 1.05, txns: { h1: { buys: 20, sells: 40 } } })), null, 'green: ignore sell pressure');
// 1 h and 6 h both down, still red, after 2 h
assert.strictEqual(pt._momentumExit(ago(2.1), pair({ priceUsd: 0.96, volume: { h1: 30000, h6: 80000, h24: 400000 }, priceChange: { h1: -0.5, h6: -2, h24: -4 } })), 'Momentum broke down');
assert.strictEqual(pt._momentumExit(ago(1.5), pair({ priceUsd: 0.96, priceChange: { h1: -0.5, h6: -2, h24: -4 } })), null, 'wait 2 h for the 1h+6h fade');
// daily bleed on an older pair, after 30 min, bounce already faded
assert.strictEqual(pt._momentumExit(ago(0.6), pair({ priceUsd: 0.94, volume: { h1: 126000, h6: 187000, h24: 1e6 }, txns: { h1: { buys: 755, sells: 457 } }, priceChange: { h1: -4.8, h6: -2.3, h24: -41.2 } })), 'Dead chart: still bleeding on the daily');
// a brand-new pair (fresh launch) is not judged on a 24 h dump
assert.strictEqual(pt._momentumExit(ago(0.6), pair({ priceUsd: 0.94, pairCreatedAt: Date.now() - 5 * 3600e3, priceChange: { h1: -4, h6: 2, h24: -41 } })), null, 'fresh pair: no daily-bleed exit');
// stalled: still flat or red after 6 h
assert.strictEqual(pt._momentumExit(ago(6.1), pair({ priceUsd: 1.02, volume: { h1: 30000, h6: 80000, h24: 400000 }, priceChange: { h1: 1, h6: 2, h24: 3 } })), 'Stalled trade: no progress after 6 h');
assert.strictEqual(pt._momentumExit(ago(6.1), pair({ priceUsd: 1.05, volume: { h1: 30000, h6: 80000, h24: 400000 }, priceChange: { h1: 1, h6: 2, h24: 3 } })), null, 'still moving up after 6 h: hold');
assert.strictEqual(pt._momentumExit(ago(5), pair({ priceUsd: 0.97 })), null, 'not yet 6 h');
// WASTED-shaped snapshot: 40 h in, volume dead, slightly red, 1h and 6h down
const wasted = ago(40); wasted.entry = { liq: 94643, vol1h: 6153 };
assert.strictEqual(pt._momentumExit(wasted, pair({ priceUsd: 0.88, volume: { h1: 2535, h6: 12635, h24: 130141 }, txns: { h1: { buys: 43, sells: 35 } }, priceChange: { m5: 0.43, h1: -0.34, h6: -1.26, h24: -3.91 } })), 'Dead chart: volume dried up');

// 8. Missing-price timeout (30 min, not 48 h)
t = trade(); t.priceMissingSince = Date.now() - 29 * 60e3;
assert.strictEqual(pt._missingPriceExit(t), null, '29 min: still waiting');
t.priceMissingSince = Date.now() - 30 * 60e3;
assert.strictEqual(pt._missingPriceExit(t), 'No price for 30 min, written off');
assert.strictEqual(pt._missingPriceExit(trade()), null, 'price is flowing: no exit');

// 9. 15 min candle exits: below EMA + lower lows / MACD breakdown; dead volume; leave runners alone
const nowS = Math.floor(Date.now() / 1000);
function candles(closes, vols) {
  return closes.map((c, i) => [nowS - (closes.length - i) * 15 * 60, c, c, c, c, vols[i]]);
}
// gentle downtrend after a bounce, priced below entry, below EMA, lower lows and MACD down
const dn = []; let px = 1.04;
for (let i = 0; i < 50; i++) { px = px - 0.004 - (i > 30 ? 0.003 : 0); dn.push(+px.toFixed(6)); }
const dnVol = new Array(50).fill(100);
t = { ...trade(), entryPrice: 1 };
assert.strictEqual(pt._candleExit(t, candles(dn, dnVol)), 'Momentum broke down');
// same shape but the last close is still >= +8% — leave it for the trail
t = { ...trade(), entryPrice: dn[dn.length - 1] / 1.10 };
assert.strictEqual(pt._candleExit(t, candles(dn, dnVol)), null, 'runner: candle exit stands down');
// not enough history
assert.strictEqual(pt._candleExit(trade(), candles(dn.slice(0, 10), dnVol.slice(0, 10))), null);
// uptrend above EMA should not exit
const up = []; px = 0.90;
for (let i = 0; i < 50; i++) { px = px + 0.004; up.push(+px.toFixed(6)); }
t = { ...trade(), entryPrice: 1 };
assert.strictEqual(pt._candleExit(t, candles(up, new Array(50).fill(100))), null, 'uptrend: hold');
// below EMA, red, and volume has dried up vs the prior 20 candles
const flatDn = [...new Array(40).fill(1.0), 0.99, 0.985, 0.98, 0.975, 0.97, 0.965, 0.96, 0.955, 0.95, 0.945];
const dryVol = [...new Array(40).fill(200), ...new Array(10).fill(40)];
t = { ...trade(), entryPrice: 1 };
assert.ok(['Dead chart: volume dried up', 'Momentum broke down'].includes(pt._candleExit(t, candles(flatDn, dryVol))), 'dead volume or momentum on a drying chart');

// 10. Trending entry filter: skip thin 1 h volume and 24 h bleed (the WASTED / BRUH pattern)
const trendingOk = {
  liquidity: { usd: 80000 }, marketCap: 500000,
  volume: { h1: 30000, h24: 300000 },
  txns: { h1: { buys: 80, sells: 40 } },
  priceChange: { h1: 8, h6: 5, h24: 2 },
};
assert.ok(pt._STRATS.trending.pick(trendingOk, 30), 'healthy trending coin is bought');
assert.ok(!pt._STRATS.trending.pick({ ...trendingOk, volume: { h1: 6000, h24: 300000 } }, 30), 'thin 1 h volume rejected (WASTED-like)');
assert.ok(!pt._STRATS.trending.pick({ ...trendingOk, priceChange: { h1: 8, h6: 5, h24: -41 } }, 30), '24 h bleed rejected (BRUH-like)');
assert.ok(pt._STRATS.chart.pick(trendingOk, 30) && !pt._STRATS.chart.pick({ ...trendingOk, volume: { h1: 6000, h24: 300000 } }, 30), 'chart strategy uses the same entry filter');
// fresh launches keep their own 1-24 h rules and are not blocked by a 24 h change filter of -20%
assert.ok(pt._STRATS.fresh.pick({
  liquidity: { usd: 25000 }, marketCap: 200000, volume: { h1: 30000 },
  txns: { h1: { buys: 100, sells: 60 } }, priceChange: { h1: 20, h6: 10, h24: -15 },
}, 5), 'fresh launch still allowed');

console.log('stops, chart exits and cooldowns: all tests passed');
