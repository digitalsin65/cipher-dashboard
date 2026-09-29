import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { CoinScore, Snapshot, WeightsConfig } from '../types.js';
import { computeAllSignals } from './signals.js';
import {
  fetchKlinesBatched,
  fetchTickers,
  fetchUsdtSymbols,
  selectTopSymbols,
} from '../services/binance.js';
import { getCachedSnapshot, saveSnapshot } from '../services/cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig(): WeightsConfig {
  const path = join(__dirname, '../../../config/weights.json');
  return JSON.parse(readFileSync(path, 'utf8')) as WeightsConfig;
}

export async function runScoreCycle(cfg?: WeightsConfig): Promise<Snapshot> {
  const config = cfg ?? loadConfig();
  const errors: string[] = [];

  try {
    const [usdtSymbols, tickers] = await Promise.all([
      fetchUsdtSymbols(config),
      fetchTickers(config),
    ]);

    const selected = selectTopSymbols(usdtSymbols, tickers, config);
    if (selected.length === 0) {
      throw new Error('No symbols passed volume filter');
    }

    const { candles, errors: klineErrors } = await fetchKlinesBatched(
      config,
      selected.map((s) => s.symbol)
    );
    errors.push(...klineErrors);

    const coins: CoinScore[] = [];
    const now = new Date().toISOString();

    for (const meta of selected) {
      const series = candles.get(meta.symbol);
      if (!series) continue;
      try {
        const { signals, breakoutScore } = computeAllSignals(series, config.weights);
        coins.push({
          symbol: meta.symbol,
          baseAsset: meta.baseAsset,
          price: meta.price,
          change24h: meta.change24h,
          quoteVolume24h: meta.quoteVolume24h,
          breakoutScore,
          signals,
          updatedAt: now,
        });
      } catch (e) {
        errors.push(
          `${meta.symbol} score: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    coins.sort((a, b) => b.breakoutScore - a.breakoutScore);

    const snap: Snapshot = {
      generatedAt: now,
      pollIntervalMs: config.pollIntervalMs,
      symbolCount: coins.length,
      coins,
      errors: errors.slice(0, 40),
      fromCache: false,
    };

    if (coins.length > 0) {
      saveSnapshot(snap);
    }

    return snap;
  } catch (e) {
    const cached = getCachedSnapshot(true);
    if (cached) {
      return {
        ...cached,
        errors: [
          `Refresh failed: ${e instanceof Error ? e.message : String(e)}`,
          ...cached.errors,
        ].slice(0, 40),
        fromCache: true,
      };
    }
    throw e;
  }
}
