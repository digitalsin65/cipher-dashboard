export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
}

export interface SignalContribution {
  key: string;
  label: string;
  score: number; // 0–100 component score
  weight: number; // configured weight (raw)
  contribution: number; // weighted points toward final 0–100
  detail: string;
}

export interface CoinScore {
  symbol: string;
  baseAsset: string;
  price: number;
  change24h: number;
  quoteVolume24h: number;
  breakoutScore: number;
  signals: SignalContribution[];
  updatedAt: string;
}

export interface Snapshot {
  generatedAt: string;
  pollIntervalMs: number;
  symbolCount: number;
  coins: CoinScore[];
  errors: string[];
  fromCache: boolean;
}

export interface WeightsConfig {
  pollIntervalMs: number;
  klinesInterval: string;
  klinesLimit: number;
  maxSymbols: number;
  minQuoteVolumeUsdt: number;
  binanceBaseUrl: string;
  binanceFallbackUrls?: string[];
  excludeBases?: string[];
  requestDelayMs: number;
  weights: {
    accumulation: number;
    floorDistance: number;
    bearTrap: number;
    momentumIgnition: number;
    volatilitySqueeze: number;
    volumePressure: number;
    rsiResistance: number;
  };
  notes?: string;
}
