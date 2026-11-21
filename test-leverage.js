// Run: node test-leverage.js   (paper leverage account: P&L, fees, funding, liquidation, stops, signals)
const assert = require('assert');
const L = require('./leverage');
const near = (a, b, msg, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, msg + ': got ' + a + ', expected ' + b);
const T0 = 1_800_000_000_000;

// ---- Position size, fees, P&L (long) ----
let t = L.openPosition({ symbol: 'ETH', pair: 'ETHUSDT', side: 'long', price: 100, now: T0 });
near(t.notional, 1000, '5x of US$200'); near(t.qty, 10, 'qty'); near(t.openFee, 0.5, 'open fee 0.05% of 1000');
near(t.stop, 96, 'long stop 4% below'); near(t.takeProfit, 108, 'long TP +8%'); near(t.liqPrice, 82, 'long liquidation 18% below');
let m = L.closeMath(t, 108, false);
near(m.exitFee, 0.54, 'exit fee on 1080'); near(m.proceeds, 200 + 80 - 0.54, 'proceeds'); near(m.pnl, 80 - 0.54 - 0.5, 'net P&L +8% move');
near(m.pnlPct, (80 - 1.04) / 200 * 100, 'P&L as % of margin (~+39.5%)'); near(m.movePct, 8, 'price move');
m = L.closeMath(t, 96, false); near(m.pnl, -40 - 0.48 - 0.5, 'stop at -4% = about -20% of margin'); near(m.pnlPct, -20.49, 'pct', 1e-9);

// ---- Short ----
let s = L.openPosition({ symbol: 'SOL', pair: 'SOLUSDT', side: 'short', price: 50, now: T0 });
near(s.qty, 20, 'short qty'); near(s.stop, 52, 'short stop 4% above'); near(s.takeProfit, 46, 'short TP 8% below'); near(s.liqPrice, 59, 'short liquidation 18% above');
near(L.closeMath(s, 46, false).pnl, 80 - 20 * 46 * 0.0005 - 0.5, 'short profits when price falls');
near(L.closeMath(s, 52, false).pnl, -40 - 20 * 52 * 0.0005 - 0.5, 'short loses when price rises');

// ---- Liquidation: whole margin plus open fee lost ----
m = L.closeMath(t, 82, true); near(m.proceeds, 0, 'nothing back'); near(m.pnl, -200.5, 'margin + open fee lost');
// proceeds never go below zero even past the liquidation price
near(L.closeMath(t, 50, false).proceeds, 0, 'value floored at 0');

// ---- Funding estimate: 0.01% of position per 8 h; longs pay, shorts receive ----
t = L.openPosition({ symbol: 'ETH', pair: 'ETHUSDT', side: 'long', price: 100, now: T0 });
L.accrueFunding(t, 100, T0 + 8 * 3600e3); near(t.funding, 0.1, 'long pays 0.01% of 1000 per 8 h');
L.accrueFunding(t, 100, T0 + 12 * 3600e3); near(t.funding, 0.15, 'pro rata');
near(L.closeMath(t, 100, false).pnl, -0.15 - 0.5 - 0.5, 'flat trade costs fees + funding');
s = L.openPosition({ symbol: 'SOL', pair: 'SOLUSDT', side: 'short', price: 50, now: T0 });
L.accrueFunding(s, 50, T0 + 8 * 3600e3); near(s.funding, -0.1, 'short receives');

// ---- Exits for a long: stop, break-even/trailing ratchet, TP, liquidation ----
t = L.openPosition({ symbol: 'ETH', pair: 'ETHUSDT', side: 'long', price: 100, now: T0 });
assert.strictEqual(L.checkExit(t, 102), null);
assert.strictEqual(L.checkExit(t, 96), 'Stop loss');
t = L.openPosition({ symbol: 'ETH', pair: 'ETHUSDT', side: 'long', price: 100, now: T0 });
assert.strictEqual(L.checkExit(t, 103.9), null); near(t.stop, 96, 'not yet 4% up');
assert.strictEqual(L.checkExit(t, 104), null); near(t.stop, 104 * 0.97, 'at +4% the stop trails 3% behind (above break-even 100.1)'); assert.strictEqual(t.stopKind, 'trail');
assert.strictEqual(L.checkExit(t, 102), null); near(t.stop, 100.88, 'dip: stop does not move down');
assert.strictEqual(L.checkExit(t, 106), null); near(t.stop, 102.82, 'new best lifts the stop');
assert.strictEqual(L.checkExit(t, 102.8), 'Trailing stop');
t = L.openPosition({ symbol: 'ETH', pair: 'ETHUSDT', side: 'long', price: 100, now: T0 });
assert.strictEqual(L.checkExit(t, 108), 'Take profit');
t = L.openPosition({ symbol: 'ETH', pair: 'ETHUSDT', side: 'long', price: 100, now: T0 });
assert.strictEqual(L.checkExit(t, 80), 'Liquidated', 'a gap through the liquidation price liquidates, not stops');
// break-even kicks in when 3% trail would sit below break-even (smaller trail test via a tiny move set)
t = L.openPosition({ symbol: 'ETH', pair: 'ETHUSDT', side: 'long', price: 100, now: T0 });
t.best = 100; L.checkExit(t, 104); assert.ok(t.stop > 100.1, 'stop is never below break-even (100.1) once armed');

// ---- Exits for a short ----
s = L.openPosition({ symbol: 'SOL', pair: 'SOLUSDT', side: 'short', price: 100, now: T0 });
assert.strictEqual(L.checkExit(s, 103), null); assert.strictEqual(L.checkExit(s, 104), 'Stop loss');
s = L.openPosition({ symbol: 'SOL', pair: 'SOLUSDT', side: 'short', price: 100, now: T0 });
assert.strictEqual(L.checkExit(s, 95), null); near(s.stop, 97.85, 'short trails 3% above best (95)'); near(s.best, 95, 'best is the low');
assert.strictEqual(L.checkExit(s, 97), null); near(s.stop, 97.85, 'bounce: stop stays');
assert.strictEqual(L.checkExit(s, 97.9), 'Trailing stop');
s = L.openPosition({ symbol: 'SOL', pair: 'SOLUSDT', side: 'short', price: 100, now: T0 });
assert.strictEqual(L.checkExit(s, 92), 'Take profit');
s = L.openPosition({ symbol: 'SOL', pair: 'SOLUSDT', side: 'short', price: 100, now: T0 });
assert.strictEqual(L.checkExit(s, 118), 'Liquidated');

// ---- Signals ----
const mk = closes => closes.map((c, i) => [i * 3600e3, c, c, c, c, 100]);
// steady climb with pullbacks: above EMA50, MACD above signal, RSI in 50-70
const up = []; for (let i = 0; i < 121; i++) up.push(100 + i * 0.2 + (i % 2 ? -0.35 : 0.35));
const su = L.tfSignal(mk(up));
assert.strictEqual(su.dir, 'long', 'uptrend -> long: ' + JSON.stringify(su));
const dn = up.map(x => 300 - x);
const sd = L.tfSignal(mk(dn));
assert.strictEqual(sd.dir, 'short', 'mirror downtrend -> short: ' + JSON.stringify(sd));
// accelerating pump: RSI 100 -> overheated, no long
const pump = L.tfSignal(mk(Array.from({ length: 120 }, (_, i) => 100 + i * i * 0.05)));
assert.strictEqual(pump.dir, null); assert.match(pump.why, /RSI over 70/);
assert.match(L.tfSignal(mk([1, 2, 3])).why, /not enough candles/);
assert.strictEqual(L.trendOf(su), 'up'); assert.strictEqual(L.trendOf(sd), 'down');
// full decision: both timeframes, volume, BTC filter
const withVol = (closes, lastVol) => mk(closes).map((c, i, a) => (i === a.length - 1 ? [...c.slice(0, 5), lastVol] : c));
let e = L.evaluate('ETH', withVol(up, 150), mk(up), 'up');
assert.strictEqual(e.dir, 'long'); assert.ok(e.score > 0);
assert.match(L.evaluate('ETH', withVol(up, 90), mk(up), 'up').reason, /volume below/);
assert.match(L.evaluate('ETH', withVol(up, 150), mk(up), 'down').reason, /long blocked: BTC 4h trend is down/);
assert.strictEqual(L.evaluate('BTC', withVol(up, 150), mk(up), 'down').dir, 'long', 'BTC itself is exempt');
assert.match(L.evaluate('SOL', withVol(dn, 150), mk(dn), 'up').reason, /short blocked/);
assert.strictEqual(L.evaluate('SOL', withVol(dn, 150), mk(dn), 'down').dir, 'short');
assert.match(L.evaluate('ETH', withVol(up, 150), mk(dn), 'flat').reason, /1h and 4h point different ways/);
assert.match(L.evaluate('ETH', withVol(up, 150), mk(Array.from({ length: 120 }, (_, i) => 100 + i * i * 0.05)), 'flat').reason, /^4h: uptrend but RSI over 70/);

// ---- Coin list filtering ----
const markets = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1 }, { id: 'tether', symbol: 'usdt', name: 'Tether', market_cap_rank: 2 },
  { id: 'wrapped-bitcoin', symbol: 'wbtc', name: 'Wrapped Bitcoin', market_cap_rank: 3 }, { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin', market_cap_rank: 4 },
  { id: 'the-open-network', symbol: 'gram', name: 'Toncoin', market_cap_rank: 5 }, { id: 'tether-gold', symbol: 'xaut', name: 'Tether Gold', market_cap_rank: 6 },
  { id: 'some-dollar', symbol: 'usdgo', name: 'USDGO', market_cap_rank: 7 }, { id: 'obscure', symbol: 'obs', name: 'Obscure', market_cap_rank: 8 },
  { id: 'lido-staked-ether', symbol: 'steth', name: 'Lido Staked Ether', market_cap_rank: 9 },
];
const u = L.pickUniverse(markets, new Set(['dogecoin']), new Set(['tether']), new Set(['BTCUSDT', 'TONUSDT']));
assert.deepStrictEqual(u.map(c => c.symbol), ['BTC', 'TON', 'OBS']);
assert.deepStrictEqual(u.map(c => c.pair), ['BTCUSDT', 'TONUSDT', null], 'coins without a Binance USDT pair are kept but skipped');
console.log('leverage: all tests passed');
