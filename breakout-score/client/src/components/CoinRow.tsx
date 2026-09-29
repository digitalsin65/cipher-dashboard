import { useState } from 'react';
import type { CoinScore } from '../types';
import { ScoreBar } from './ScoreBar';
import { SignalBreakdown } from './SignalBreakdown';

interface Props {
  coin: CoinScore;
  rank: number;
}

function formatPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toPrecision(4);
}

function formatVol(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

export function CoinRow({ coin, rank }: Props) {
  const [open, setOpen] = useState(rank <= 3);

  return (
    <article className={`coin ${open ? 'coin--open' : ''}`}>
      <button className="coin__main" onClick={() => setOpen((v) => !v)} type="button">
        <span className="coin__rank">#{rank}</span>
        <a
          className="coin__sym coin__binance"
          href={`https://www.binance.com/en/trade/${coin.baseAsset}_USDT?type=spot`}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${coin.baseAsset}/USDT on Binance`}
          onClick={(e) => e.stopPropagation()}
        >
          <strong>{coin.baseAsset}</strong>
          <span className="dim">/USDT</span>
        </a>
        <span className="coin__score">
          <span className="coin__score-num">{coin.breakoutScore}</span>
          <ScoreBar score={coin.breakoutScore} />
        </span>
        <span className="coin__price mono">{formatPrice(coin.price)}</span>
        <span className={`coin__chg mono ${coin.change24h >= 0 ? 'up' : 'down'}`}>
          {coin.change24h >= 0 ? '+' : ''}
          {coin.change24h.toFixed(2)}%
        </span>
        <span className="coin__vol mono dim">{formatVol(coin.quoteVolume24h)}</span>
        <span className="coin__chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="coin__body">
          <SignalBreakdown signals={coin.signals} />
        </div>
      )}
    </article>
  );
}
