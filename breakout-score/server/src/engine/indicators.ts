import type { Candle } from '../types.js';

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function stdev(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function bollingerWidth(closes: number[], period = 20, mult = 2): number | null {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  if (mid == null || sd == null || mid === 0) return null;
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  return ((upper - lower) / mid) * 100; // percent bandwidth
}

export function highestHigh(candles: Candle[], lookback: number): number {
  const slice = candles.slice(-lookback);
  return Math.max(...slice.map((c) => c.high));
}

export function lowestLow(candles: Candle[], lookback: number): number {
  const slice = candles.slice(-lookback);
  return Math.min(...slice.map((c) => c.low));
}

export function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

export function closesOf(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

export function volumesOf(candles: Candle[]): number[] {
  return candles.map((c) => c.volume);
}
