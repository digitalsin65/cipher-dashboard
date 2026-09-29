import type { Candle, SignalContribution, WeightsConfig } from '../types.js';
import {
  bollingerWidth,
  clamp,
  closesOf,
  highestHigh,
  lowestLow,
  rsi,
  sma,
  volumesOf,
} from './indicators.js';

/**
 * Signal formulas (each returns 0–100 component score + detail string).
 * Documented in README.md — keep in sync.
 */

/** 1. Accumulation: tight range + muted directional drift over mid window. */
export function accumulationScore(candles: Candle[]): { score: number; detail: string } {
  if (candles.length < 40) return { score: 0, detail: 'insufficient candles' };
  const mid = candles.slice(-40, -10);
  const highs = mid.map((c) => c.high);
  const lows = mid.map((c) => c.low);
  const closes = mid.map((c) => c.close);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const midPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
  if (midPrice === 0) return { score: 0, detail: 'zero mid price' };

  const rangePct = ((rangeHigh - rangeLow) / midPrice) * 100;
  // Tighter range → higher score. 2% range ≈ 100, 12%+ ≈ 0
  const tightness = clamp(100 - ((rangePct - 2) / 10) * 100);

  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  const driftPct = Math.abs((last - first) / first) * 100;
  // Low drift → accumulation (not trending hard)
  const driftScore = clamp(100 - driftPct * 20);

  const vols = mid.map((c) => c.volume);
  const volEarly = sma(vols.slice(0, Math.floor(vols.length / 2)), Math.floor(vols.length / 2));
  const volLate = sma(vols.slice(Math.floor(vols.length / 2)), Math.ceil(vols.length / 2));
  let volDry = 50;
  if (volEarly && volLate && volEarly > 0) {
    // Declining or stable volume during range = healthy accumulation
    const ratio = volLate / volEarly;
    volDry = clamp(100 - (ratio - 0.6) * 100); // ratio 0.6→100, 1.6→0
  }

  const score = clamp(0.45 * tightness + 0.35 * driftScore + 0.2 * volDry);
  return {
    score: Math.round(score),
    detail: `range ${rangePct.toFixed(1)}%, drift ${driftPct.toFixed(2)}%`,
  };
}

/** 2. Floor distance: how close price sits above recent structural floor (swing low). */
export function floorDistanceScore(candles: Candle[]): { score: number; detail: string } {
  if (candles.length < 30) return { score: 0, detail: 'insufficient candles' };
  const floor = lowestLow(candles, 48);
  const price = candles[candles.length - 1]!.close;
  if (floor <= 0) return { score: 0, detail: 'invalid floor' };
  const distPct = ((price - floor) / floor) * 100;

  // Sweet spot: sitting near the floor (0.5–4%) but not broken below.
  // Below floor → low. Far above (>15%) → low (already extended).
  let score: number;
  if (distPct < 0) {
    score = clamp(40 + distPct * 10); // slightly below still some score if reclaiming soon
  } else if (distPct <= 3) {
    score = 90 + (3 - distPct) * 3; // very close to floor
  } else if (distPct <= 8) {
    score = 70 - ((distPct - 3) / 5) * 30;
  } else if (distPct <= 15) {
    score = 40 - ((distPct - 8) / 7) * 30;
  } else {
    score = clamp(10 - (distPct - 15));
  }
  return {
    score: Math.round(clamp(score)),
    detail: `${distPct.toFixed(2)}% above ${lookbackLabel(48)} low`,
  };
}

function lookbackLabel(n: number): string {
  return `${n}-bar`;
}

/**
 * 3. Bear trap: recent false breakdown — wick/close below prior floor, then reclaim.
 * Looks at last 8 bars for a low that undercuts prior 20-bar floor then closes back above.
 */
export function bearTrapScore(candles: Candle[]): { score: number; detail: string } {
  if (candles.length < 30) return { score: 0, detail: 'insufficient candles' };
  const prior = candles.slice(-28, -8);
  const recent = candles.slice(-8);
  const priorFloor = Math.min(...prior.map((c) => c.low));
  let trapFound = false;
  let reclaimStrength = 0;
  let undercutPct = 0;

  for (const c of recent) {
    if (c.low < priorFloor) {
      undercutPct = ((priorFloor - c.low) / priorFloor) * 100;
      if (c.close > priorFloor) {
        trapFound = true;
        reclaimStrength = ((c.close - priorFloor) / priorFloor) * 100;
      }
    }
  }

  // Also check if price now holds above prior floor after any undercut in window
  const last = recent[recent.length - 1]!;
  const anyUndercut = recent.some((c) => c.low < priorFloor);
  if (anyUndercut && last.close > priorFloor) {
    trapFound = true;
    undercutPct = Math.max(
      undercutPct,
      ((priorFloor - Math.min(...recent.map((c) => c.low))) / priorFloor) * 100
    );
    reclaimStrength = ((last.close - priorFloor) / priorFloor) * 100;
  }

  if (!trapFound) {
    // Partial credit if price is near floor with long lower wick recently
    const wicks = recent.map((c) => {
      const body = Math.abs(c.close - c.open);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      return body > 0 ? lowerWick / body : 0;
    });
    const maxWick = Math.max(...wicks);
    const nearFloor = ((last.close - priorFloor) / priorFloor) * 100;
    if (maxWick > 1.5 && nearFloor >= 0 && nearFloor < 5) {
      return {
        score: Math.round(clamp(35 + maxWick * 10)),
        detail: `wick rejection near floor (${nearFloor.toFixed(1)}% above)`,
      };
    }
    return { score: 10, detail: 'no bear-trap pattern' };
  }

  // Stronger undercut + firm reclaim = higher score
  const score = clamp(55 + undercutPct * 8 + reclaimStrength * 10);
  return {
    score: Math.round(score),
    detail: `undercut ${undercutPct.toFixed(2)}%, reclaim +${reclaimStrength.toFixed(2)}%`,
  };
}

/** 4. Momentum ignition: short-term ROC + expanding range + close near highs. */
export function momentumIgnitionScore(candles: Candle[]): { score: number; detail: string } {
  if (candles.length < 20) return { score: 0, detail: 'insufficient candles' };
  const closes = closesOf(candles);
  const last = candles[candles.length - 1]!;
  const prev3 = closes[closes.length - 4]!;
  const roc3 = ((last.close - prev3) / prev3) * 100;

  const ranges = candles.slice(-10).map((c) => c.high - c.low);
  const avgRangeEarly = ranges.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const avgRangeLate = ranges.slice(5).reduce((a, b) => a + b, 0) / 5;
  const rangeExpansion = avgRangeEarly > 0 ? avgRangeLate / avgRangeEarly : 1;

  const barRange = last.high - last.low;
  const closePos = barRange > 0 ? (last.close - last.low) / barRange : 0.5;

  // Positive ROC preferred for breakout ignition; mild negative dampens
  const rocScore = clamp(50 + roc3 * 25);
  const expansionScore = clamp((rangeExpansion - 0.7) * 80);
  const closeScore = closePos * 100;

  const score = clamp(0.45 * rocScore + 0.3 * expansionScore + 0.25 * closeScore);
  return {
    score: Math.round(score),
    detail: `ROC3 ${roc3.toFixed(2)}%, range×${rangeExpansion.toFixed(2)}, closePos ${(closePos * 100).toFixed(0)}%`,
  };
}

/** 5. Volatility squeeze: Bollinger bandwidth vs its recent average (lower = squeeze). */
export function volatilitySqueezeScore(candles: Candle[]): { score: number; detail: string } {
  const closes = closesOf(candles);
  if (closes.length < 40) return { score: 0, detail: 'insufficient candles' };

  const widths: number[] = [];
  for (let i = 20; i <= closes.length; i++) {
    const w = bollingerWidth(closes.slice(0, i), 20, 2);
    if (w != null) widths.push(w);
  }
  if (widths.length < 10) return { score: 0, detail: 'insufficient BW history' };

  const current = widths[widths.length - 1]!;
  const avgBw = widths.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, widths.length);
  const ratio = avgBw > 0 ? current / avgBw : 1;

  // ratio < 1 = squeezed. ratio 0.5 → ~100, ratio 1.2 → ~20
  const score = clamp(100 - (ratio - 0.5) * (80 / 0.7));
  return {
    score: Math.round(score),
    detail: `BB width ${current.toFixed(2)}% (${(ratio * 100).toFixed(0)}% of avg)`,
  };
}

/** 6. Volume pressure: recent volume vs longer average (quote-volume proxy when available). */
export function volumePressureScore(candles: Candle[]): { score: number; detail: string } {
  const vols = volumesOf(candles);
  if (vols.length < 25) return { score: 0, detail: 'insufficient candles' };

  const recent = vols.slice(-5);
  const baseline = vols.slice(-25, -5);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const baseAvg = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  if (baseAvg <= 0) return { score: 0, detail: 'zero baseline volume' };

  const ratio = recentAvg / baseAvg;
  // ratio 0.5 → 20, 1.0 → 50, 1.5 → 75, 2.5+ → 100
  const score = clamp(20 + (ratio - 0.5) * 40);
  return {
    score: Math.round(score),
    detail: `vol ${(ratio * 100).toFixed(0)}% of 20-bar avg`,
  };
}

/**
 * 7. RSI + distance from resistance.
 * Ideal: RSI 45–65 (room to run) AND price not jammed into resistance.
 */
export function rsiResistanceScore(candles: Candle[]): { score: number; detail: string } {
  const closes = closesOf(candles);
  if (candles.length < 30) return { score: 0, detail: 'insufficient candles' };

  const r = rsi(closes, 14);
  if (r == null) return { score: 0, detail: 'RSI unavailable' };

  let rsiScore: number;
  if (r < 30) rsiScore = 40 + r; // oversold — can bounce but weak momentum
  else if (r <= 55) rsiScore = 70 + (r - 30) * 1.2; // sweet zone climbing
  else if (r <= 65) rsiScore = 95 - (r - 55) * 1.5;
  else if (r <= 75) rsiScore = 70 - (r - 65) * 3;
  else rsiScore = clamp(40 - (r - 75) * 2); // overbought

  const resistance = highestHigh(candles.slice(0, -1), 40);
  const price = closes[closes.length - 1]!;
  const distToRes =
    resistance > price ? ((resistance - price) / price) * 100 : ((price - resistance) / price) * -100;

  // Prefer some headroom (1–6% below resistance). At/above resistance = breakout already happening (mixed).
  let resScore: number;
  if (distToRes < 0) {
    // already above recent highs — breakout in progress, moderate credit
    resScore = clamp(55 + distToRes * 5);
  } else if (distToRes <= 2) {
    resScore = 75 + distToRes * 5; // coiling under resistance
  } else if (distToRes <= 6) {
    resScore = 85 - ((distToRes - 2) / 4) * 20;
  } else if (distToRes <= 12) {
    resScore = 65 - ((distToRes - 6) / 6) * 35;
  } else {
    resScore = clamp(30 - (distToRes - 12));
  }

  const score = clamp(0.55 * rsiScore + 0.45 * resScore);
  return {
    score: Math.round(score),
    detail: `RSI ${r.toFixed(1)}, ${distToRes >= 0 ? distToRes.toFixed(1) + '% below res' : Math.abs(distToRes).toFixed(1) + '% above res'}`,
  };
}

export function computeAllSignals(
  candles: Candle[],
  weights: WeightsConfig['weights']
): { signals: SignalContribution[]; breakoutScore: number } {
  const raw = [
    { key: 'accumulation', label: 'Accumulation', ...accumulationScore(candles), weight: weights.accumulation },
    { key: 'floorDistance', label: 'Floor Distance', ...floorDistanceScore(candles), weight: weights.floorDistance },
    { key: 'bearTrap', label: 'Bear Trap', ...bearTrapScore(candles), weight: weights.bearTrap },
    {
      key: 'momentumIgnition',
      label: 'Momentum Ignition',
      ...momentumIgnitionScore(candles),
      weight: weights.momentumIgnition,
    },
    {
      key: 'volatilitySqueeze',
      label: 'Volatility Squeeze',
      ...volatilitySqueezeScore(candles),
      weight: weights.volatilitySqueeze,
    },
    {
      key: 'volumePressure',
      label: 'Volume Pressure',
      ...volumePressureScore(candles),
      weight: weights.volumePressure,
    },
    {
      key: 'rsiResistance',
      label: 'RSI + Resistance',
      ...rsiResistanceScore(candles),
      weight: weights.rsiResistance,
    },
  ];

  const weightSum = raw.reduce((a, s) => a + s.weight, 0) || 100;
  const signals: SignalContribution[] = raw.map((s) => ({
    key: s.key,
    label: s.label,
    score: s.score,
    weight: s.weight,
    contribution: Math.round(((s.score * s.weight) / weightSum) * 100) / 100,
    detail: s.detail,
  }));

  const breakoutScore = Math.round(
    clamp(signals.reduce((a, s) => a + (s.score * s.weight) / weightSum, 0))
  );

  return { signals, breakoutScore };
}

// silence unused import warning if stdev unused at top level
