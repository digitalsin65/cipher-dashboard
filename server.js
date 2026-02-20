// ============================================================
//  CIPHER Dashboard — CoinMarketCap Proxy Server
//  
//  ▼▼▼  ENTER YOUR API KEY ON THE LINE BELOW  ▼▼▼
// ============================================================

const CMC_API_KEY = '7a33f32dad464cffb62467a24b398be3';

// ============================================================
//  Don't touch anything below unless you know what you're doing
// ============================================================

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const path    = require('path');

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Allow our own scripts to run (overrides wallet extension CSP interference)
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:;"
  );
  next();
});

// Serve the dashboard HTML
app.use(express.static(path.join(__dirname, 'public')));

// ── Helper: fetch from CoinMarketCap ──────────────────────────────────────
function cmcFetch(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(params).toString();
    const options = {
      hostname: 'pro-api.coinmarketcap.com',
      path: `/v1/${endpoint}?${query}`,
      method: 'GET',
      headers: {
        'X-CMC_PRO_API_KEY': CMC_API_KEY,
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from CMC')); }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ── Route: Live prices for ticker + portfolio ─────────────────────────────
// GET /api/prices?symbols=BTC,ETH,SOL,MATIC,AVAX,LINK,DOT,ADA,DOGE
app.get('/api/prices', async (req, res) => {
  try {
    const symbols = req.query.symbols || 'BTC,ETH,SOL,MATIC,AVAX,LINK,DOT,ADA,DOGE';
    const data = await cmcFetch('cryptocurrency/quotes/latest', {
      symbol: symbols,
      convert: 'USD',
    });

    // CMC returns each symbol as an array — take the first (highest market cap)
    const result = {};
    for (const [sym, infoRaw] of Object.entries(data.data || {})) {
      const info = Array.isArray(infoRaw) ? infoRaw[0] : infoRaw;
      const q = info?.quote?.USD || {};
      result[sym] = {
        name:         info.name,
        symbol:       sym,
        price:        q.price,
        change_1h:    q.percent_change_1h,
        change_24h:   q.percent_change_24h,
        change_7d:    q.percent_change_7d,
        volume_24h:   q.volume_24h,
        market_cap:   q.market_cap,
        last_updated: q.last_updated,
      };
    }
    console.log('[CMC] Prices fetched:', Object.keys(result).join(', '));

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('CMC /prices error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Route: Global market stats ────────────────────────────────────────────
// GET /api/global
app.get('/api/global', async (req, res) => {
  try {
    const data = await cmcFetch('global-metrics/quotes/latest', { convert: 'USD' });
    const q    = data.data?.quote?.USD || {};
    res.json({
      ok: true,
      data: {
        total_market_cap:     q.total_market_cap,
        total_volume_24h:     q.total_volume_24h,
        btc_dominance:        data.data?.btc_dominance,
        eth_dominance:        data.data?.eth_dominance,
        active_cryptocurrencies: data.data?.active_cryptocurrencies,
      },
    });
  } catch (err) {
    console.error('CMC /global error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Route: Top 20 by market cap (for markets page later) ─────────────────
// GET /api/listings?limit=20
app.get('/api/listings', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const data  = await cmcFetch('cryptocurrency/listings/latest', {
      limit,
      convert: 'USD',
      sort: 'market_cap',
    });

    const result = (data.data || []).map(coin => {
      const q = coin.quote?.USD || {};
      return {
        rank:       coin.cmc_rank,
        name:       coin.name,
        symbol:     coin.symbol,
        price:      q.price,
        change_1h:  q.percent_change_1h,
        change_24h: q.percent_change_24h,
        change_7d:  q.percent_change_7d,
        volume_24h: q.volume_24h,
        market_cap: q.market_cap,
      };
    });

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('CMC /listings error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Catch-all: serve dashboard ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  CIPHER proxy running at http://localhost:${PORT}`);
  console.log(`    Dashboard → http://localhost:${PORT}`);
  console.log(`    Prices API → http://localhost:${PORT}/api/prices`);
  console.log(`    Global API → http://localhost:${PORT}/api/global\n`);

  if (CMC_API_KEY === 'PASTE_YOUR_API_KEY_HERE') {
    console.warn('⚠️  WARNING: You have not set your API key in server.js!');
    console.warn('   Open server.js and replace PASTE_YOUR_API_KEY_HERE with your key.\n');
  }
});
