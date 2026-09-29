# Run Breakout Score on your computer

## Needs
- Node.js 20+ (https://nodejs.org)

## Steps (Mac / Linux / Windows with Node)
1. Unzip `breakout-score-portable.zip`
2. Open a terminal in the `breakout-score` folder
3. Run:
   ```bash
   npm run install:all
   npm run dev
   ```
4. Open http://localhost:5173 in your browser

## Notes
- Uses Binance public market data (no API key)
- First load can take ~1–2 minutes while candles are fetched
- If Binance is blocked on your network, the UI may show a cache/error state
- Tune signal weights in `config/weights.json` (or `config/weights.json` — see README)

API runs on http://localhost:3847
