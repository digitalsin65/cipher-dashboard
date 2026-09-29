import type { Candle, WeightsConfig } from '../types.js';

const UA = 'BreakoutScore/1.0 (research prototype)';

let resolvedBase: string | null = null;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function candidateBases(cfg: WeightsConfig): string[] {
  const list = [cfg.binanceBaseUrl, ...(cfg.binanceFallbackUrls || [])].filter(Boolean);
  return [...new Set(list)];
}

async function fetchJsonFromBase<T>(base: string, path: string, retries = 3): Promise<T> {
  const url = `${base}${path}`;
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (res.status === 451) {
        throw Object.assign(new Error(`HTTP 451 geo-restricted for ${base}`), { status: 451 });
      }
      if (res.status === 429 || res.status === 418) {
        await sleep(1000 * (i + 1) * 2);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if ((e as { status?: number }).status === 451) throw e;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function resolveBase(cfg: WeightsConfig): Promise<string> {
  if (resolvedBase) return resolvedBase;
  const bases = candidateBases(cfg);
  const errors: string[] = [];
  for (const base of bases) {
    try {
      await fetchJsonFromBase<unknown>(base, '/api/v3/ping', 1);
      resolvedBase = base;
      console.log(`[binance] using ${base}`);
      return base;
    } catch (e) {
      errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // ping may not exist on vision — try ticker as probe
  for (const base of bases) {
    try {
      await fetchJsonFromBase<unknown[]>(base, '/api/v3/ticker/24hr', 1);
      resolvedBase = base;
      console.log(`[binance] using ${base} (via ticker probe)`);
      return base;
    } catch (e) {
      errors.push(`${base} ticker: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`No reachable Binance endpoint. Tried: ${errors.join(' | ')}`);
}

async function fetchJson<T>(cfg: WeightsConfig, path: string): Promise<T> {
  const base = await resolveBase(cfg);
  try {
    return await fetchJsonFromBase<T>(base, path);
  } catch (e) {
    if ((e as { status?: number }).status === 451) {
      resolvedBase = null;
      const next = await resolveBase(cfg);
      return fetchJsonFromBase<T>(next, path);
    }
    throw e;
  }
}

export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

export interface ExchangeSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed?: boolean;
}

export async function fetchUsdtSymbols(cfg: WeightsConfig): Promise<ExchangeSymbol[]> {
  const data = await fetchJson<{ symbols: ExchangeSymbol[] }>(cfg, '/api/v3/exchangeInfo');
  const excluded = new Set((cfg.excludeBases || []).map((b) => b.toUpperCase()));
  return data.symbols.filter((s) => {
    const base = s.baseAsset.toUpperCase();
    if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING') return false;
    if (excluded.has(base)) return false;
    if (base.includes('UP') || base.includes('DOWN')) return false;
    if (s.symbol.includes('_')) return false;
    if (/(BULL|BEAR|3L|3S|2L|2S)$/i.test(base)) return false;
    // Stable / USD-pegged bases (USDC, RLUSD, FDUSD, …)
    if (base.includes('USD') || base === 'U' || base === 'DAI' || base === 'EUR') return false;
    // Binance tokenized-equity style tickers: SPCXB, SNDKB, GOOGLB (keep 3-letter like BNB)
    if (/^[A-Z]{4,8}B$/.test(base)) return false;
    return true;
  });
}

export async function fetchTickers(cfg: WeightsConfig): Promise<Ticker24h[]> {
  return fetchJson<Ticker24h[]>(cfg, '/api/v3/ticker/24hr');
}

export function selectTopSymbols(
  usdtSymbols: ExchangeSymbol[],
  tickers: Ticker24h[],
  cfg: WeightsConfig
): { symbol: string; baseAsset: string; price: number; change24h: number; quoteVolume24h: number }[] {
  const usdtSet = new Set(usdtSymbols.map((s) => s.symbol));
  const baseBySymbol = new Map(usdtSymbols.map((s) => [s.symbol, s.baseAsset]));

  return tickers
    .filter((t) => usdtSet.has(t.symbol))
    .map((t) => ({
      symbol: t.symbol,
      baseAsset: baseBySymbol.get(t.symbol) || t.symbol.replace('USDT', ''),
      price: parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent),
      quoteVolume24h: parseFloat(t.quoteVolume),
    }))
    .filter((t) => Number.isFinite(t.price) && t.quoteVolume24h >= cfg.minQuoteVolumeUsdt)
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, cfg.maxSymbols);
}

type RawKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

export async function fetchKlines(cfg: WeightsConfig, symbol: string): Promise<Candle[]> {
  const path =
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${cfg.klinesInterval}&limit=${cfg.klinesLimit}`;
  const raw = await fetchJson<RawKline[]>(cfg, path);
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    quoteVolume: parseFloat(k[7]),
  }));
}

export async function fetchKlinesBatched(
  cfg: WeightsConfig,
  symbols: string[]
): Promise<{ candles: Map<string, Candle[]>; errors: string[] }> {
  const candles = new Map<string, Candle[]>();
  const errors: string[] = [];

  for (const symbol of symbols) {
    try {
      const data = await fetchKlines(cfg, symbol);
      if (data.length >= 30) {
        candles.set(symbol, data);
      } else {
        errors.push(`${symbol}: too few candles (${data.length})`);
      }
    } catch (e) {
      errors.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (cfg.requestDelayMs > 0) await sleep(cfg.requestDelayMs);
  }

  return { candles, errors };
}
