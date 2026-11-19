// Run: node test-indicators.js
const assert = require('assert');
const { ema, rsi, macd, volumeTrend, summarise } = require('./indicators');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, msg + ': got ' + a + ', expected ' + b);

// RSI: the classic StockCharts / Wilder worked example (their table rounds the first averages to 2 dp, so allow 0.1)
const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
  46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];
const expected = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77];
const r = rsi(closes, 14);
assert.strictEqual(r[13], null);
expected.forEach((e, i) => near(r[14 + i], e, 0.1, 'RSI at ' + (14 + i)));
// only gains -> 100, only losses -> 0, flat -> 50
near(rsi(Array.from({ length: 20 }, (_, i) => i + 1)).at(-1), 100, 1e-9, 'RSI all up');
near(rsi(Array.from({ length: 20 }, (_, i) => 20 - i)).at(-1), 0, 1e-9, 'RSI all down');
near(rsi(new Array(20).fill(5)).at(-1), 50, 1e-9, 'RSI flat');

// EMA seeded with SMA: EMA(3) of 1..5 -> seed 2 at i=2, then 3, 4
assert.deepStrictEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);

// MACD on a straight line x = i: EMA(n) lags by (n-1)/2, so line -> 12.5 - 5.5 = 7, signal -> 7, histogram -> 0
const lin = Array.from({ length: 200 }, (_, i) => i);
const m = macd(lin);
near(m.line.at(-1), 7, 1e-6, 'MACD line on a straight line');
near(m.signal.at(-1), 7, 1e-6, 'MACD signal on a straight line');
near(m.hist.at(-1), 0, 1e-6, 'MACD histogram on a straight line');
assert.strictEqual(m.line[24], null); assert.notStrictEqual(m.line[25], null);
assert.strictEqual(m.signal[32], null); assert.notStrictEqual(m.signal[33], null);
// flat prices -> all zero
const f = macd(new Array(60).fill(3)); near(f.line.at(-1), 0, 1e-12, 'flat MACD'); near(f.hist.at(-1), 0, 1e-12, 'flat hist');
// MACD signal must equal EMA(9) of the line from where the line starts
const zz = Array.from({ length: 80 }, (_, i) => 10 + Math.sin(i / 4) * 2 + i * 0.05);
const mz = macd(zz), sig2 = ema(mz.line.slice(25), 9);
near(mz.signal.at(-1), sig2.at(-1), 1e-12, 'signal = EMA9(line)');

// Volume trend
near(volumeTrend([...new Array(20).fill(100), 200, 200, 200]), 2, 1e-12, 'volume 2x');
assert.strictEqual(volumeTrend([1, 2, 3]), null);
assert.strictEqual(volumeTrend(new Array(30).fill(0)), null);

// summarise
const c = lin.slice(0, 60).map((x, i) => [i * 300, x, x, x, x, 100]);
const s = summarise(c);
assert.strictEqual(s.candles, 60); near(s.rsi, 100, 1e-9, 'summary RSI'); near(s.volRatio, 1, 1e-9, 'summary vol');
console.log('indicators: all tests passed');

// Chart entry rules used by the "Trending + chart signals" strategy
process.env.PAPER_FILE = process.env.PAPER_FILE || require('os').tmpdir() + '/paper-test-' + process.pid + '.json';
const { _chartRules } = require('./papertrade');
const nowS = Math.floor(Date.now() / 1000);
const mk = (closes, vols, mins) => closes.map((c, i) => [nowS - (closes.length - i) * mins * 60, c, c, c, c, vols[i]]);
assert.match(_chartRules(mk([1, 2, 3], [1, 1, 1], 5), 5).reasons[0], /Not enough 5 min chart history/);
const old = mk(new Array(60).fill(1), new Array(60).fill(1), 5).map(c => [c[0] - 3600, ...c.slice(1)]);
assert.match(_chartRules(old, 5).reasons[0], /No recent trades/);
// gentle uptrend with dips, then a fresh push on rising volume -> passes the 5 min rules
const up = [100]; for (let i = 1; i < 60; i++) up.push(up[i - 1] + (i % 2 ? 1 : -0.8));
up.push(up[59] + 0.6, up[59] + 1.2);
const vols = [...new Array(59).fill(100), 180, 200, 220];
const ok5 = _chartRules(mk(up, vols, 5), 5);
assert.deepStrictEqual(ok5.reasons, [], 'uptrend should pass: ' + ok5.reasons.join('; ') + ' ' + JSON.stringify(ok5.info));
// same chart on low volume fails only the volume rule
const lowVol = _chartRules(mk(up, new Array(62).fill(100).map((v, i) => (i > 58 ? 50 : v)), 5), 5);
assert.deepStrictEqual(lowVol.reasons.length, 1); assert.match(lowVol.reasons[0], /Volume on 5 min chart is 0.5x normal/);
// straight-line pump -> RSI 100, overbought
assert.match(_chartRules(mk(Array.from({ length: 60 }, (_, i) => i + 1), new Array(60).fill(100), 15), 15).reasons[0], /overbought/);
// falling faster and faster -> weak RSI and MACD below signal
const dn = _chartRules(mk(Array.from({ length: 60 }, (_, i) => 100 - i * i * 0.01), new Array(60).fill(100), 15), 15).reasons.join('; ');
assert.match(dn, /momentum too weak/); assert.match(dn, /MACD below its signal line on 15 min chart/);
console.log('chart rules: all tests passed');
