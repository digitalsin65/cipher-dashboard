// ============================================================
//  CIPHER Dashboard — API Proxy Server
//
//  ▼▼▼  ENTER YOUR KEYS BELOW  ▼▼▼
// ============================================================

const CMC_API_KEY     = process.env.CMC_API_KEY     || 'PASTE_YOUR_CMC_KEY_HERE';
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || 'PASTE_YOUR_ALCHEMY_KEY_HERE';
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || 'PASTE_YOUR_OPENSEA_KEY_HERE';
const WALLET_ADDRESS  = '0x0e78641A5aa08b44c3c33b4Ea085c82749f06cda';
// ============================================================
//  Don't touch anything below unless you know what you're doing
// ============================================================

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const path    = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app  = express();
const PORT = Number(process.env.PORT || 3000);
const BREAKOUT_PORT = Number(process.env.BREAKOUT_PORT || 3847);
const BREAKOUT_TARGET = `http://127.0.0.1:${BREAKOUT_PORT}`;

app.use(cors());
app.use(express.json());

// Allow our own scripts to run (overrides wallet extension CSP interference)
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src * data: blob:; frame-src 'self';"
  );
  next();
});


// ── Proxy Breakout Score API (same paths the React client uses) ───────────
// Runs on :3847; CIPHER mounts them on :3000 so the iframe is same-origin.
function breakoutOnError(err, _req, res) {
  console.error('[breakout-proxy]', err.message);
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify({
    ok: false,
    error: 'Breakout API unavailable — is the breakout server running on ' + BREAKOUT_PORT + '?',
  }));
}

// Context-as-filter form keeps full paths (/api/scores → :3847/api/scores)
app.use(createProxyMiddleware(
  ['/api/scores', '/api/config', '/api/refresh', '/api/health'],
  {
    target: BREAKOUT_TARGET,
    changeOrigin: true,
    logLevel: 'warn',
    onError: breakoutOnError,
  }
));
// Prefixed aliases
app.use(createProxyMiddleware('/api/breakout', {
  target: BREAKOUT_TARGET,
  changeOrigin: true,
  pathRewrite: { '^/api/breakout': '/api' },
  logLevel: 'warn',
  onError: breakoutOnError,
}));

// Serve the dashboard HTML + built Breakout UI at /breakout/
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback for Breakout client routes under /breakout/
app.get('/breakout/*', (req, res, next) => {
  if (req.path.includes('.')) return next();
  res.sendFile(path.join(__dirname, 'public', 'breakout', 'index.html'), (err) => {
    if (err) next();
  });
});

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

// ── Helper: generic HTTPS fetch ──────────────────────────────────────────
function httpsFetch(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers: { 'Accept': 'application/json', ...headers } };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Route: NFTs owned by wallet (Alchemy) ────────────────────────────────
// GET /api/nfts
app.get('/api/nfts', async (req, res) => {
  try {
    if (ALCHEMY_API_KEY === 'PASTE_YOUR_ALCHEMY_KEY_HERE') {
      return res.json({ ok: false, error: 'Alchemy API key not set in server.js' });
    }
    if (WALLET_ADDRESS === 'PASTE_YOUR_0x_WALLET_ADDRESS_HERE') {
      return res.json({ ok: false, error: 'Wallet address not set in server.js' });
    }

    const path = `/nft/v3/${ALCHEMY_API_KEY}/getNFTsForOwner?owner=${WALLET_ADDRESS}&withMetadata=true&pageSize=100`;
    const data = await httpsFetch('eth-mainnet.g.alchemy.com', path);

    const nfts = (data.ownedNfts || []).map(nft => ({
      tokenId:        nft.tokenId,
      name:           nft.name || nft.contract?.name + ' #' + nft.tokenId,
      collection:     nft.contract?.name || 'Unknown',
      contractAddress: nft.contract?.address,
      image:          nft.image?.cachedUrl || nft.image?.originalUrl || nft.image?.pngUrl || null,
      description:    nft.description || null,
      traits:         (nft.raw?.metadata?.attributes || []).map(a => ({ trait: a.trait_type, value: a.value })),
      tokenType:      nft.contract?.tokenType,
      floorPrice:     nft.contract?.openSeaMetadata?.floorPrice || null,
      floorCurrency:  'ETH',
      openseaUrl:     nft.contract?.openSeaMetadata?.collectionSlug
                        ? `https://opensea.io/collection/${nft.contract.openSeaMetadata.collectionSlug}`
                        : null,
      collectionSlug: nft.contract?.openSeaMetadata?.collectionSlug || null,
      collectionImg:  nft.contract?.openSeaMetadata?.imageUrl || null,
      safelistStatus: nft.contract?.openSeaMetadata?.safelistRequestStatus || null,
    }));

    console.log(`[Alchemy] Found ${nfts.length} NFTs for wallet`);
    res.json({ ok: true, data: nfts, total: nfts.length });
  } catch (err) {
    console.error('Alchemy /nfts error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Route: Collection stats from OpenSea ─────────────────────────────────
// GET /api/nft/collection/:slug
app.get('/api/nft/collection/:slug', async (req, res) => {
  try {
    if (OPENSEA_API_KEY === 'PASTE_YOUR_OPENSEA_KEY_HERE') {
      return res.json({ ok: false, error: 'OpenSea API key not set in server.js' });
    }

    const slug = req.params.slug;
    const [statsData, collData] = await Promise.all([
      httpsFetch('api.opensea.io', `/api/v2/collections/${slug}/stats`, { 'X-API-KEY': OPENSEA_API_KEY }),
      httpsFetch('api.opensea.io', `/api/v2/collections/${slug}`,       { 'X-API-KEY': OPENSEA_API_KEY }),
    ]);

    const s = statsData.total || {};
    res.json({
      ok: true,
      data: {
        name:             collData.name,
        slug,
        description:      collData.description,
        image:            collData.image_url,
        bannerImage:      collData.banner_image_url,
        floorPrice:       statsData.intervals?.[0]?.floor_price || s.floor_price || 0,
        floorCurrency:    'ETH',
        volume24h:        statsData.intervals?.find(i => i.interval === 'one_day')?.volume || 0,
        volume7d:         statsData.intervals?.find(i => i.interval === 'seven_day')?.volume || 0,
        volumeTotal:      s.volume || 0,
        sales24h:         statsData.intervals?.find(i => i.interval === 'one_day')?.sales || 0,
        averagePrice:     s.average_price || 0,
        marketCap:        s.market_cap || 0,
        numOwners:        collData.total_supply || 0,
        totalSupply:      collData.total_supply || 0,
        openseaUrl:       `https://opensea.io/collection/${slug}`,
      },
    });
  } catch (err) {
    console.error('OpenSea /collection error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Route: Specific NFT sale history from OpenSea ────────────────────────
// GET /api/nft/history/:contract/:tokenId
app.get('/api/nft/history/:contract/:tokenId', async (req, res) => {
  try {
    if (OPENSEA_API_KEY === 'PASTE_YOUR_OPENSEA_KEY_HERE') {
      return res.json({ ok: false, error: 'OpenSea API key not set' });
    }
    const { contract, tokenId } = req.params;
    const data = await httpsFetch(
      'api.opensea.io',
      `/api/v2/events/chain/ethereum/contract/${contract}/nfts/${tokenId}?event_type=sale&limit=10`,
      { 'X-API-KEY': OPENSEA_API_KEY }
    );

    const events = (data.asset_events || []).map(e => ({
      eventType:   e.event_type,
      date:        e.closing_date ? new Date(e.closing_date * 1000).toLocaleDateString() : null,
      salePrice:   e.payment ? (parseInt(e.payment.quantity) / 1e18).toFixed(4) : null,
      currency:    e.payment?.symbol || 'ETH',
      seller:      e.seller,
      buyer:       e.buyer,
      marketplace: 'OpenSea',
    }));

    res.json({ ok: true, data: events });
  } catch (err) {
    console.error('OpenSea /history error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Route: Search NFT collection by contract address ─────────────────────
// GET /api/nft/search-contract/:address
app.get('/api/nft/search-contract/:address', async (req, res) => {
  try {
    if (OPENSEA_API_KEY === 'PASTE_YOUR_OPENSEA_KEY_HERE') {
      return res.json({ ok: false, error: 'OpenSea API key not set' });
    }
    // First get the collection slug from the contract
    const contractData = await httpsFetch(
      'api.opensea.io',
      `/api/v2/chain/ethereum/contract/${req.params.address}`,
      { 'X-API-KEY': OPENSEA_API_KEY }
    );
    const slug = contractData.collection;
    if (!slug) return res.json({ ok: false, error: 'No collection found for this contract' });

    // Then reuse the collection route logic
    const [coll, stats] = await Promise.all([
      httpsFetch('api.opensea.io', `/api/v2/collections/${slug}`,       { 'X-API-KEY': OPENSEA_API_KEY }),
      httpsFetch('api.opensea.io', `/api/v2/collections/${slug}/stats`, { 'X-API-KEY': OPENSEA_API_KEY }),
    ]);
    const s = stats.total || {};
    const dayInterval = (stats.intervals || []).find(i => i.interval === 'one_day') || {};
    res.json({
      ok: true,
      data: {
        name: coll.name, slug, description: coll.description,
        image: coll.image_url, bannerImage: coll.banner_image_url,
        floorPrice: dayInterval.floor_price || s.floor_price || 0,
        volume24h:  dayInterval.volume || 0,
        volume7d:   (stats.intervals || []).find(i => i.interval === 'seven_day')?.volume || 0,
        volumeTotal: s.volume || 0,
        sales24h:   dayInterval.sales || 0,
        averagePrice: s.average_price || 0,
        marketCap:  s.market_cap || 0,
        openseaUrl: `https://opensea.io/collection/${slug}`,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Route: Trending NFT collections (OpenSea) ───────────────────────────
// GET /api/nft/trending
// Fetches stats for the top collections in parallel
app.get('/api/nft/trending', async (req, res) => {
  try {
    if (OPENSEA_API_KEY === 'PASTE_YOUR_OPENSEA_KEY_HERE') {
      return res.json({ ok: false, error: 'OpenSea API key not set' });
    }

    const TOP_SLUGS = [
      'boredapeyachtclub', 'pudgypenguins', 'azuki', 'doodles-official',
      'clonex', 'cryptopunks', 'proof-moonbirds', 'mutant-ape-yacht-club',
      'the-sandbox', 'lilpudgys'
    ];

    // Fetch all in parallel
    const results = await Promise.allSettled(
      TOP_SLUGS.map(slug =>
        Promise.all([
          httpsFetch('api.opensea.io', `/api/v2/collections/${slug}`,       { 'X-API-KEY': OPENSEA_API_KEY }),
          httpsFetch('api.opensea.io', `/api/v2/collections/${slug}/stats`, { 'X-API-KEY': OPENSEA_API_KEY }),
        ])
      )
    );

    const data = results
      .filter(r => r.status === 'fulfilled')
      .map(r => {
        const [coll, stats] = r.value;
        const dayInterval = (stats.intervals || []).find(i => i.interval === 'one_day') || {};
        const floor  = dayInterval.floor_price || stats.total?.floor_price || 0;
        const vol24h = dayInterval.volume || 0;
        const chg24h = dayInterval.floor_price_percentage_change || 0;
        return {
          name:       coll.name,
          slug:       coll.collection,
          image:      coll.image_url,
          floor,
          volume24h:  vol24h,
          change24h:  chg24h,
          openseaUrl: `https://opensea.io/collection/${coll.collection}`,
        };
      })
      .filter(c => c.name) // drop any that failed to parse
      .sort((a, b) => b.volume24h - a.volume24h); // sort by volume

    console.log('[OpenSea] Trending fetched:', data.length, 'collections');
    res.json({ ok: true, data });
  } catch (err) {
    console.error('OpenSea /trending error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Route: Recent whale sales (OpenSea events) ────────────────────────────
// GET /api/nft/whales
app.get('/api/nft/whales', async (req, res) => {
  try {
    if (OPENSEA_API_KEY === 'PASTE_YOUR_OPENSEA_KEY_HERE') {
      return res.json({ ok: false, error: 'OpenSea API key not set' });
    }
    const data = await httpsFetch(
      'api.opensea.io',
      '/api/v2/events/chain/ethereum?event_type=sale&limit=20',
      { 'X-API-KEY': OPENSEA_API_KEY }
    );
    const result = (data.asset_events || [])
      .filter(e => {
        const eth = e.payment ? parseInt(e.payment.quantity) / 1e18 : 0;
        return eth >= 2; // only sales >= 2 ETH
      })
      .slice(0, 8)
      .map(e => {
        const eth  = e.payment ? (parseInt(e.payment.quantity) / 1e18).toFixed(3) : '—';
        const mins = e.closing_date ? Math.floor((Date.now()/1000 - e.closing_date) / 60) : 0;
        const time = mins < 60 ? mins + 'm ago' : Math.floor(mins/60) + 'h ago';
        const wallet = e.buyer ? e.buyer.slice(0,4) + '…' + e.buyer.slice(-3) : '—';
        return {
          name:   e.nft?.name || e.nft?.identifier ? (e.nft.collection + ' #' + e.nft.identifier) : 'Unknown NFT',
          image:  e.nft?.image_url || null,
          price:  eth,
          type:   'buy',
          qty:    1,
          wallet,
          time,
        };
      });
    console.log('[OpenSea] Whale sales fetched:', result.length);
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('OpenSea /whales error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Route: NFT news (via RSS proxy) ──────────────────────────────────────
// GET /api/nft/news
app.get('/api/nft/news', async (req, res) => {
  try {
    // Use RSS2JSON free service to parse NFT-related RSS feeds
    const feed = await httpsFetch(
      'api.rss2json.com',
      '/v1/api.json?rss_url=https%3A%2F%2Fdecrypt.co%2Ffeed&count=10'
    );
    const items = (feed.items || [])
      .filter(item => {
        const text = (item.title + ' ' + (item.description || '')).toLowerCase();
        return text.includes('nft') || text.includes('opensea') || text.includes('blur') || text.includes('collection');
      })
      .slice(0, 6)
      .map(item => {
        const published = new Date(item.pubDate);
        const diffH     = Math.floor((Date.now() - published) / 3600000);
        const time      = diffH < 1 ? 'Just now' : diffH < 24 ? diffH + 'h ago' : Math.floor(diffH/24) + 'd ago';
        return { title: item.title, url: item.link, source: 'Decrypt', time };
      });
    res.json({ ok: true, data: items });
  } catch (err) {
    console.error('News /nft/news error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Catch-all: serve dashboard (skip API + breakout assets) ───────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/breakout')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  CIPHER proxy running at http://localhost:${PORT}`);
  console.log(`    Dashboard → http://localhost:${PORT}`);
  console.log(`    Breakout  → http://localhost:${PORT}/breakout/`);
  console.log(`    Prices API → http://localhost:${PORT}/api/prices`);
  console.log(`    Scores API → http://localhost:${PORT}/api/scores (proxied → :${BREAKOUT_PORT})`);
  console.log(`    Global API → http://localhost:${PORT}/api/global\n`);

  if (!process.env.CMC_API_KEY) {
    console.warn('ℹ️  Using embedded CMC API key fallback. Set CMC_API_KEY in the environment to override.\n');
  }

  const missing = [];
  if (CMC_API_KEY     === 'PASTE_YOUR_CMC_KEY_HERE')           missing.push('CMC_API_KEY');
  if (ALCHEMY_API_KEY === 'PASTE_YOUR_ALCHEMY_KEY_HERE')       missing.push('ALCHEMY_API_KEY');
  if (OPENSEA_API_KEY === 'PASTE_YOUR_OPENSEA_KEY_HERE')       missing.push('OPENSEA_API_KEY');
  if (WALLET_ADDRESS  === 'PASTE_YOUR_0x_WALLET_ADDRESS_HERE') missing.push('WALLET_ADDRESS');
  if (missing.length) {
    console.warn('⚠️  Missing keys in server.js:', missing.join(', '));
    console.warn('   Open server.js and fill in the placeholders at the top.\n');
  } else {
    console.log('✅  All API keys configured\n');
  }
});
