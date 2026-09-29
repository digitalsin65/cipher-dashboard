export interface SignalContribution {
  key: string;
  label: string;
  score: number;
  weight: number;
  contribution: number;
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
  refreshing?: boolean;
  lastRefreshError?: string | null;
}
