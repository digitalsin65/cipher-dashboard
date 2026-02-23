<<<<<<< HEAD
# CIPHER — Crypto & NFT Dashboard

Your personal crypto dashboard with live CoinMarketCap prices and price alerts.

---

## ⚡ Quick Setup (3 steps)

### Step 1 — Enter your API key

Open `server.js` in any text editor.  
Find **line 5** — it looks like this:

```js
const CMC_API_KEY = 'PASTE_YOUR_API_KEY_HERE';
```

Replace `PASTE_YOUR_API_KEY_HERE` with your CoinMarketCap API key:

```js
const CMC_API_KEY = 'your-actual-key-goes-here';
```

Save the file.

---

### Step 2 — Install dependencies

Open a terminal in this folder and run:

```bash
npm install
```

This installs Express and CORS (takes about 10 seconds).

---

### Step 3 — Start the server

```bash
npm start
```

You'll see:

```
✅  CIPHER proxy running at http://localhost:3000
    Dashboard → http://localhost:3000
    Prices API → http://localhost:3000/api/prices
```

Open your browser and go to **http://localhost:3000** — that's it!

---

## 🔄 How it works

```
Browser (dashboard)
      │
      │  fetch('/api/prices')        ← safe, local request
      ▼
Node.js proxy (server.js)           ← your API key lives here only
      │
      │  HTTPS + X-CMC_PRO_API_KEY  ← sent securely to CMC
      ▼
CoinMarketCap API
```

Your API key **never touches the browser**. It stays in `server.js` on your machine.

---

## 🔁 Auto-refresh

Prices refresh automatically every **60 seconds**.  
You'll see the timestamp update in the dashboard header.

---

## 🔔 Price Alerts

Alerts are checked against live prices on every refresh.  
When a target is hit, you'll get a toast notification and the alert turns yellow.

Supported alert types:
- **Price Above** — triggers when current price ≥ target
- **Price Below** — triggers when current price ≤ target
- **% Change Up** — triggers when 24h change ≥ target %
- **% Change Down** — triggers when 24h change ≤ -target %

---

## 📡 API Endpoints (for reference)

| Endpoint | Description |
|----------|-------------|
| `GET /api/prices?symbols=BTC,ETH,SOL` | Live prices for specific tokens |
| `GET /api/global` | Total market cap, BTC dominance, etc. |
| `GET /api/listings?limit=20` | Top N coins by market cap |

---

## 🛑 Stopping the server

Press `Ctrl + C` in the terminal.

---

## 🔐 Security notes

- Never commit `server.js` with your API key to GitHub
- Add `server.js` to `.gitignore` if you ever push this to a repo
- The free CMC plan allows 10,000 API calls/month — at 1 call/min you'll use ~43,200/month, so consider setting the refresh to 2–3 minutes if on the free tier

---

## 📁 File structure

```
cipher-dashboard/
├── server.js          ← ⭐ Your API key goes here (line 5)
├── package.json
├── README.md
└── public/
    └── index.html     ← The dashboard UI
```
=======
# cipher-dashboard
Crypto and NFTs dashboard
>>>>>>> 4354a52f0e9b540047892f0ec43b2567741f87c1
