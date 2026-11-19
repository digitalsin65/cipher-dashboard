// Chart indicators for the paper trader: RSI (Wilder), MACD and a simple volume trend.
// All inputs are arrays ordered oldest -> newest. Outputs are arrays the same length (null until enough data).

// Exponential moving average, seeded with the simple average of the first n values.
function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

// RSI with Wilder's smoothing (the standard one charting sites show). Needs period + 1 closes.
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = val();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = val();
  }
  return out;
}

// MACD(fast, slow, signal): line = EMA(fast) - EMA(slow), signal = EMA(signal) of the line, histogram = line - signal.
function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
  const start = line.findIndex(v => v != null);
  const signal = new Array(closes.length).fill(null);
  if (start >= 0) { const s = ema(line.slice(start), sig); s.forEach((v, i) => { signal[start + i] = v; }); }
  const hist = line.map((v, i) => (v == null || signal[i] == null ? null : v - signal[i]));
  return { line, signal, hist };
}

// Volume trend: average of the latest `recent` candles divided by the average of the `base` candles before them.
// 1.0 = normal, 2.0 = twice the usual volume. Null if there isn't enough data or the baseline is zero.
function volumeTrend(volumes, recent = 3, base = 20) {
  if (volumes.length < recent + 5) return null;
  const r = volumes.slice(-recent), b = volumes.slice(-(recent + base), -recent);
  const avgB = b.reduce((a, x) => a + x, 0) / b.length;
  if (!(avgB > 0)) return null;
  return r.reduce((a, x) => a + x, 0) / r.length / avgB;
}

// Everything the strategy needs from one set of candles (oldest -> newest, [ts, o, h, l, c, v]).
function summarise(candles) {
  const closes = candles.map(c => c[4]), vols = candles.map(c => c[5]);
  const r = rsi(closes), m = macd(closes), n = closes.length - 1;
  const rnd = (v, d) => (v == null || !isFinite(v) ? null : +v.toPrecision(d));
  return {
    candles: candles.length,
    rsi: rnd(r[n], 4), rsiPrev: rnd(r[n - 1], 4),
    macd: rnd(m.line[n], 4), signal: rnd(m.signal[n], 4), hist: rnd(m.hist[n], 4), histPrev: rnd(m.hist[n - 1], 4),
    volRatio: rnd(volumeTrend(vols), 3),
  };
}

module.exports = { ema, rsi, macd, volumeTrend, summarise };
