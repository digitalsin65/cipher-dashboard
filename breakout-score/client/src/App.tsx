import { CoinRow } from './components/CoinRow';
import { useScores } from './hooks/useScores';

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: 'short',
    });
  } catch {
    return iso;
  }
}

export default function App() {
  const { data, error, loading, refresh } = useScores();

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="eyebrow">Breakout Score · Prototype</p>
          <h1>USDT Breakout Board</h1>
          <p className="sub">
            Near-live Binance public data · 7-signal weighted score (0–100)
          </p>
        </div>
        <div className="header__actions">
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh now
          </button>
        </div>
      </header>

      <section className="status">
        {loading && !data && <span className="pill pill--warn">Warming up engine…</span>}
        {data?.fromCache && <span className="pill pill--warn">Serving last good cache</span>}
        {data?.refreshing && <span className="pill">Refreshing…</span>}
        {data && (
          <>
            <span className="pill">
              {data.symbolCount} pairs · poll {Math.round(data.pollIntervalMs / 1000)}s
            </span>
            <span className="pill dim">
              Snapshot {formatTime(data.generatedAt)} AEST/AEDT
            </span>
          </>
        )}
        {error && <span className="pill pill--err">{error}</span>}
        {data?.lastRefreshError && (
          <span className="pill pill--err" title={data.lastRefreshError}>
            Last refresh issue
          </span>
        )}
      </section>

      <div className="table-head">
        <span>Rank</span>
        <span>Pair</span>
        <span>Score</span>
        <span>Price</span>
        <span>24h</span>
        <span>Vol USDT</span>
        <span />
      </div>

      <div className="list">
        {data?.coins.map((c, i) => (
          <CoinRow key={c.symbol} coin={c} rank={i + 1} />
        ))}
        {!data && !error && <p className="empty">Fetching first snapshot from Binance…</p>}
      </div>

      <footer className="footer">
        <p>
          Not financial advice. Scores are heuristic research signals. Weights live in{' '}
          <code>config/weights.json</code>.
        </p>
      </footer>
    </div>
  );
}
