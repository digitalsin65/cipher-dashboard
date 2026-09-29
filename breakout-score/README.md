# Breakout Score

Trader-style prototype that ranks ~50–100 Binance **USDT** spot pairs by a single **Breakout Score (0–100)** built from seven technical signals.

Data: Binance **public REST only** (no API keys). Default poll ~90s. Last good snapshot is cached if a refresh fails.

## Quick start

```bash
cd /workspace/breakout-score
npm run install:all    # root + client deps
npm run dev            # API :3847 + Vite UI :5173
```

Open **http://localhost:5173** (UI proxies `/api` → Express).

One-shot engine check (no UI):

```bash
npm run verify
```

Production-ish (build UI, serve from Express on `:3847`):

```bash
npm run install:all
npm run build
npm start
# → http://localhost:3847
```

## Architecture

| Piece | Role |
|--------|------|
| `server/` | Express API, Binance fetch, signal engine, in-memory cache |
| `client/` | Vite + React dark ranked board |
| `config/weights.json` | Poll interval, filters, **signal weights** |

### API

- `GET /api/health` — liveness + cache state  
- `GET /api/scores` — ranked snapshot + per-signal breakdown  
- `GET /api/config` — current weights/config  
- `POST /api/refresh` — force a score cycle  

## Signal definitions (formulas)

Each signal is scored **0–100**, then blended with weights from `config/weights.json` (renormalized if weights ≠ 100).

Candles default: **1h**, last **100** bars.

### 1. Accumulation (`accumulation`)

Looks at bars **[-40, -10]** (skips the very latest impulse):

- **Range tightness**: `(rangeHigh − rangeLow) / midPrice`. Tighter → higher.  
- **Drift**: abs % move from first to last close in that window. Lower → higher.  
- **Volume dry-up**: late-half avg vol / early-half avg vol. Declining → higher.

Blend ≈ `0.45·tightness + 0.35·drift + 0.20·volDry`.

### 2. Floor distance (`floorDistance`)

Structural floor = **lowest low of last 48 bars**.  
Distance `% = (price − floor) / floor`.

Sweet spot ≈ **0–3%** above floor (high score). Far extended or clearly broken below → low.

### 3. Bear trap (`bearTrap`)

Prior floor from bars **[-28, -8]**. In last **8** bars, look for:

- Wick/low **under** prior floor, then **close back above** (false breakdown / reclaim).

Score rises with undercut depth + reclaim %. Partial credit for long lower-wick rejection near the floor.

### 4. Momentum ignition (`momentumIgnition`)

- **ROC3**: 3-bar rate of change of close.  
- **Range expansion**: avg true range of last 5 bars / prior 5.  
- **Close position** in the last bar: `(close − low) / (high − low)`.

Blend ≈ `0.45·roc + 0.30·expansion + 0.25·closePos`.

### 5. Volatility squeeze (`volatilitySqueeze`)

Bollinger **% bandwidth** `(upper−lower)/mid` (20, 2σ) vs its recent average.

`ratio = currentBW / avgBW`. Ratio ≪ 1 (squeeze) → high score.

### 6. Volume pressure (`volumePressure`)

Honest **volume vs average** proxy (no market cap):

`ratio = avg(vol last 5) / avg(vol prior 20)`.

Higher relative volume → higher score (mapped so ~1.0× ≈ mid-50s).

### 7. RSI + resistance (`rsiResistance`)

- **RSI(14)**: prefers mid/climbing zone (~45–65), penalizes deep overbought.  
- **Distance to resistance**: highest high of prior ~40 bars vs last close. Prefers **1–6% headroom** under resistance; at/above highs gets moderate “breakout in progress” credit.

Blend ≈ `0.55·rsiScore + 0.45·resScore`.

### Breakout Score

\[
\text{Score} = \sum_i \left(\text{signal}_i \times \frac{w_i}{\sum w}\right)
\]

UI shows each component’s **0–100 score**, **weight**, and **contribution** points.

## Tune these weights

Edit `config/weights.json`:

```json
"weights": {
  "accumulation": 14,
  "floorDistance": 12,
  "bearTrap": 16,
  "momentumIgnition": 18,
  "volatilitySqueeze": 12,
  "volumePressure": 14,
  "rsiResistance": 14
}
```

Also tunable there:

| Key | Default | Meaning |
|-----|---------|---------|
| `pollIntervalMs` | `90000` | Refresh cadence |
| `klinesInterval` | `"1h"` | Candle size |
| `klinesLimit` | `100` | Bars fetched |
| `maxSymbols` | `80` | Universe size |
| `minQuoteVolumeUsdt` | `2000000` | 24h quote-volume floor |
| `requestDelayMs` | `80` | Delay between kline calls (rate-limit courtesy) |
| `binanceBaseUrl` | `https://data-api.binance.vision` | Public market-data host |
| `excludeBases` | USDC, FDUSD, PAXG, … | Explicit denylist (plus USD*/equity heuristics) |

Restart `npm run dev` (or the server process) after weight edits — config is read from disk each cycle.

## Limitations

- **Not live websocket** — REST snapshots, so “near-live” only.  
- **No order book / OI / funding** — spot volume & OHLC only.  
- **Volume ≠ market-cap pressure** — we use relative volume as a deliberate proxy.  
- **USDT spot only**, leveraged tokens filtered heuristically.  
- **Heuristics, not alpha** — patterns can fake out; no backtest harness in this prototype.  
- Binance **rate limits / geo blocks** may delay or empty a cycle; last good cache is served when possible.  
- **Not financial advice.**

## Defaults chosen

- Binance host: **`https://data-api.binance.vision`** (public data mirror — `api.binance.com` often returns **HTTP 451** from restricted regions).
- Stables / pegs / some tokenized equities excluded via `excludeBases`.


- Port **3847** (API), **5173** (Vite).  
- Top **80** USDT pairs by 24h quote volume (≥ **$2M**).  
- **1h** candles, **90s** poll, **80ms** inter-request delay.  
- Dark ranked UI; top 3 rows expanded with signal breakdown.
