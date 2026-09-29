# NOTES — for Mike (Australia) morning review

Built overnight as a local prototype under `/workspace/breakout-score`. Times below are **Australia/Sydney**.

## What you have

- Working **Breakout Score** engine + dark ranked web UI.
- Binance **public** REST only — no keys required.
- Seven documented signals → one 0–100 score with UI contribution breakdown.
- Tunable weights in `config/weights.json`.

## Assumptions I made (please challenge)

1. **Universe**: top ~80 USDT pairs by 24h quote volume, min **$2M** — liquid enough for a trader board without scraping dust.
2. **Timeframe**: **1h** candles (100 bars) — balances noise vs structure for accumulation / squeeze / bear-trap. If you prefer 15m scalp or 4h swing, change `klinesInterval` and maybe `pollIntervalMs`.
3. **Poll**: **90s** default — polite to Binance public limits while still feeling near-live.
4. **Volume pressure without mcap**: relative volume vs recent average is the intentional proxy (called out in README).
5. **Bear trap**: defined as undercut-then-reclaim of a recent structural floor on the last ~8 hours of 1h bars — classic wick/fake breakdown, not a multi-day pattern library.
6. **Score philosophy**: slightly favors **setup + ignition** (bear trap, momentum, volume) over pure “already ripped” extension. Floor distance and RSI/resistance penalize late chase.
7. **Ports**: API `3847`, UI `5173` — unlikely to collide with common local apps.
8. **No auth / no persistence**: in-memory cache only; restart = cold warm-up (~1–2 min for first full kline batch).

## How to run in the morning

```bash
cd /workspace/breakout-score
npm run install:all   # if not already installed
npm run dev
```

Open http://localhost:5173  

Or verify engine only: `npm run verify`

## What to look at first

1. Does the top of the board match names you’d *subjectively* call “coiled”?  
2. Expand a few rows — do signal details (ROC, BB width, RSI) match your TradingView read?  
3. Tweak weights toward your style (e.g. raise `bearTrap` / `volatilitySqueeze` for setup hunting; raise `momentumIgnition` / `volumePressure` for continuation).  
4. If Binance is slow/blocked from this network, you’ll see cache/error pills — note it in follow-up.

## Known gaps / next upgrades (not done)

- Websocket trades/depth for true live feel  
- Multi-timeframe confluence  
- Alerting (Telegram/Slack) when score crosses threshold  
- Simple walk-forward / hit-rate notebook  
- Exclude stables (beyond USDT quote) more aggressively if any leak through  

## Blockers at build time

1. **`api.binance.com` → HTTP 451** from this box’s network (geo eligibility). Mitigated by defaulting to **`https://data-api.binance.vision`** with fallback list in config. Verified: engine scored 80 coins successfully.
2. First board without filters ranked stables/gold tokens highly (tight ranges inflate accumulation/squeeze). Mitigated with `excludeBases` denylist — review and extend if you spot more junk.
