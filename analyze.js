// Coin Analyze: rule-based scores from real public data. No numbers are invented;
// any source that fails or has no key is reported as unavailable.
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = function mountAnalyze(app, { CMC_API_KEY, ALCHEMY_API_KEY }) {
  const hasCmc = !!CMC_API_KEY && !CMC_API_KEY.startsWith('PASTE_');
  const hasAlchemy = !!ALCHEMY_API_KEY && !ALCHEMY_API_KEY.startsWith('PASTE_');
  const TTL = 5 * 60 * 1000;
  const cache = new Map();
  async function cached(key, ttl, fn) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttl) return c.v;
    const v = await fn();
    cache.set(key, { at: Date.now(), v });
    return v;
  }
  async function getJson(url, opts = {}) {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
  const r1 = v => Math.round(v * 10) / 10;

  // ---------- Binance daily candles ----------
  async function klines(sym) {
    return cached('k:' + sym, TTL, async () => {
      const q = '/api/v3/klines?symbol=' + sym + 'USDT&interval=1d&limit=1000';
      let j;
      try { j = await getJson('https://api.binance.com' + q); }
      catch (e) { j = await getJson('https://data-api.binance.vision' + q); }
      if (!Array.isArray(j) || !j.length) throw new Error('No Binance data');
      return j.map(k => ({ t: k[0], h: +k[2], l: +k[3], c: +k[4], v: +k[7] }));
    });
  }
  const sma = (a, n) => a.length < n ? null : a.slice(-n).reduce((s, x) => s + x, 0) / n;
  function emaSeries(a, n) { const k = 2 / (n + 1); const out = [a[0]]; for (let i = 1; i < a.length; i++) out.push(a[i] * k + out[i - 1] * (1 - k)); return out; }
  function rsi(a, n = 14) {
    if (a.length < n + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  const chg = (a, d) => a.length > d ? (a[a.length - 1] / a[a.length - 1 - d] - 1) * 100 : null;

  function technical(k) {
    const c = k.map(x => x.c), price = c[c.length - 1];
    const reasons = []; let s = 50;
    const m50 = sma(c, 50), m200 = sma(c, 200);
    if (m50 != null) { const up = price > m50; s += up ? 12 : -12; reasons.push({ up, text: 'Price is ' + (up ? 'above' : 'below') + ' its 50-day average' }); }
    if (m200 != null) { const up = price > m200; s += up ? 12 : -12; reasons.push({ up, text: 'Price is ' + (up ? 'above' : 'below') + ' its 200-day average' }); }
    else reasons.push({ up: null, text: 'Less than 200 days of history, long-term trend skipped' });
    if (m50 != null && m200 != null) { const up = m50 > m200; s += up ? 8 : -8; reasons.push({ up, text: up ? '50-day average is above the 200-day (uptrend)' : '50-day average is below the 200-day (downtrend)' }); }
    const R = rsi(c);
    if (R != null) {
      if (R >= 70) { s -= 8; reasons.push({ up: false, text: 'RSI ' + R.toFixed(0) + ': overbought, may cool off' }); }
      else if (R <= 30) { s += 8; reasons.push({ up: true, text: 'RSI ' + R.toFixed(0) + ': oversold, may bounce' }); }
      else if (R >= 50) { s += 5; reasons.push({ up: true, text: 'RSI ' + R.toFixed(0) + ': positive momentum' }); }
      else { s -= 5; reasons.push({ up: false, text: 'RSI ' + R.toFixed(0) + ': weak momentum' }); }
    }
    let macdHist = null;
    if (c.length >= 35) {
      const e12 = emaSeries(c, 12), e26 = emaSeries(c, 26);
      const macd = c.map((_, i) => e12[i] - e26[i]); const sig = emaSeries(macd, 9);
      const h = macd.map((m, i) => m - sig[i]); macdHist = h[h.length - 1]; const prev = h[h.length - 2];
      s += macdHist > 0 ? 8 : -8; reasons.push({ up: macdHist > 0, text: 'MACD is ' + (macdHist > 0 ? 'above' : 'below') + ' its signal line' });
      const rising = macdHist > prev; s += rising ? 4 : -4; reasons.push({ up: rising, text: 'MACD momentum is ' + (rising ? 'improving' : 'fading') });
    }
    const v = k.map(x => x.v);
    if (v.length >= 30) {
      const ratio = sma(v, 7) / sma(v, 30), p7 = chg(c, 7);
      if (ratio > 1.2) { const up = p7 >= 0; s += up ? 6 : -6; reasons.push({ up, text: 'Volume up ' + Math.round((ratio - 1) * 100) + '% vs 30-day average while price ' + (up ? 'rose' : 'fell') }); }
      else if (ratio < 0.8) reasons.push({ up: null, text: 'Volume is ' + Math.round((1 - ratio) * 100) + '% below its 30-day average' });
      else reasons.push({ up: null, text: 'Volume is near its 30-day average' });
    }
    return { available: true, score: Math.round(clamp(s)), reasons, metrics: { price, ma50: m50, ma200: m200, rsi: R && r1(R), macdHist } };
  }

  // ---------- CoinMarketCap fundamentals ----------
  async function cmc(endpoint, params) {
    const u = 'https://pro-api.coinmarketcap.com/v1/' + endpoint + '?' + new URLSearchParams(params);
    const j = await getJson(u, { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' } });
    if (j.status && j.status.error_code) throw new Error('CMC error');
    return j.data;
  }
  async function fundamental(sym, k) {
    if (!hasCmc) return { available: false, note: 'CoinMarketCap key not set' };
    const d = await cached('cmc:' + sym, TTL, () => cmc('cryptocurrency/quotes/latest', { symbol: sym, convert: 'USD' }));
    const c = d && d[sym]; if (!c) return { available: false, note: 'Coin not found on CoinMarketCap' };
    const q = c.quote.USD, reasons = []; let s = 50;
    const rank = c.cmc_rank;
    if (rank) { const pts = rank <= 10 ? 20 : rank <= 50 ? 12 : rank <= 100 ? 6 : rank <= 300 ? 0 : -10; s += pts; reasons.push({ up: pts > 0 ? true : pts < 0 ? false : null, text: 'Ranked #' + rank + ' by market cap' }); }
    if (q.market_cap > 0 && q.volume_24h != null) {
      const vm = q.volume_24h / q.market_cap;
      if (vm < 0.01) { s -= 10; reasons.push({ up: false, text: 'Thin trading: 24h volume is ' + (vm * 100).toFixed(1) + '% of market cap' }); }
      else if (vm > 0.5) { s -= 5; reasons.push({ up: false, text: 'Very heavy trading (' + Math.round(vm * 100) + '% of market cap), speculative' }); }
      else if (vm >= 0.03) { s += 10; reasons.push({ up: true, text: 'Healthy trading: 24h volume is ' + (vm * 100).toFixed(1) + '% of market cap' }); }
      else reasons.push({ up: null, text: '24h volume is ' + (vm * 100).toFixed(1) + '% of market cap' });
    }
    const cap = c.max_supply || c.total_supply;
    if (cap && c.circulating_supply) {
      const f = c.circulating_supply / cap;
      const pts = f >= 0.9 ? 10 : f >= 0.6 ? 5 : f < 0.4 ? -10 : 0; s += pts;
      reasons.push({ up: pts > 0 ? true : pts < 0 ? false : null, text: Math.round(f * 100) + '% of ' + (c.max_supply ? 'max' : 'total') + ' supply is circulating' + (f < 0.4 ? ' (future dilution risk)' : '') });
    }
    if (!c.max_supply) reasons.push({ up: null, text: 'No fixed maximum supply' });
    let belowHigh = null;
    if (k && k.length) { const hi = Math.max(...k.map(x => x.h)); belowHigh = (1 - k[k.length - 1].c / hi) * 100;
      const pts = belowHigh < 15 ? 6 : belowHigh > 80 ? -6 : 0; s += pts;
      reasons.push({ up: pts > 0 ? true : pts < 0 ? false : null, text: Math.round(belowHigh) + '% below its ' + Math.round(k.length / 365 * 10) / 10 + '-year high (Binance)' }); }
    return { available: true, score: Math.round(clamp(s)), reasons, metrics: { name: c.name, rank, market_cap: q.market_cap, volume_24h: q.volume_24h, circulating_supply: c.circulating_supply, max_supply: c.max_supply, total_supply: c.total_supply, pct_below_high: belowHigh && r1(belowHigh), platform: c.platform } };
  }

  // ---------- Sentiment ----------
  async function sentiment(sym, k) {
    const reasons = []; const parts = [];
    let fng = null;
    try {
      const j = await cached('fng', 30 * 60 * 1000, () => getJson('https://api.alternative.me/fng/?limit=1'));
      fng = { value: +j.data[0].value, label: j.data[0].value_classification };
      parts.push({ w: 0.4, v: fng.value });
      reasons.push({ up: fng.value >= 55 ? true : fng.value <= 45 ? false : null, text: 'Crypto Fear & Greed index: ' + fng.value + ' (' + fng.label + ')' });
    } catch (e) { reasons.push({ up: null, text: 'Fear & Greed index not available' }); }
    let rel7 = null, rel30 = null;
    if (k) {
      const c = k.map(x => x.c);
      if (sym === 'BTC') { reasons.push({ up: null, text: 'Bitcoin is the benchmark, so performance vs BTC is neutral' }); parts.push({ w: 0.6, v: 50 }); }
      else {
        try {
          const b = (await klines('BTC')).map(x => x.c);
          rel7 = chg(c, 7) - chg(b, 7); rel30 = chg(c, 30) - chg(b, 30);
          if (isFinite(rel7) && isFinite(rel30)) {
            parts.push({ w: 0.6, v: clamp(50 + rel7 * 2 + rel30, 0, 100) });
            reasons.push({ up: rel7 >= 0, text: (rel7 >= 0 ? 'Beat' : 'Lagged') + ' Bitcoin by ' + Math.abs(rel7).toFixed(1) + ' pts over 7 days' });
            reasons.push({ up: rel30 >= 0, text: (rel30 >= 0 ? 'Beat' : 'Lagged') + ' Bitcoin by ' + Math.abs(rel30).toFixed(1) + ' pts over 30 days' });
          }
        } catch (e) { reasons.push({ up: null, text: 'Bitcoin comparison not available' }); }
      }
    }
    if (!parts.length) return { available: false, note: 'No sentiment data available', reasons };
    const W = parts.reduce((s, p) => s + p.w, 0);
    return { available: true, score: Math.round(parts.reduce((s, p) => s + p.w * p.v, 0) / W), reasons, metrics: { fear_greed: fng, vs_btc_7d: rel7 && r1(rel7), vs_btc_30d: rel30 && r1(rel30) } };
  }

  // ---------- On-chain ----------
  async function onchainBtc() {
    const [hr, fees, mp] = await Promise.all([
      cached('mp:hr', TTL, () => getJson('https://mempool.space/api/v1/mining/hashrate/1m')),
      cached('mp:fees', TTL, () => getJson('https://mempool.space/api/v1/fees/recommended')),
      cached('mp:pool', TTL, () => getJson('https://mempool.space/api/mempool')),
    ]);
    const reasons = []; let s = 50;
    const h = hr.hashrates || [];
    if (h.length >= 2) { const d = (h[h.length - 1].avgHashrate / h[0].avgHashrate - 1) * 100;
      const pts = d > 5 ? 15 : d < -5 ? -15 : 0; s += pts;
      reasons.push({ up: pts > 0 ? true : pts < 0 ? false : null, text: 'Network hashrate ' + (d >= 0 ? 'up ' : 'down ') + Math.abs(d).toFixed(1) + '% over the last month (miner confidence)' }); }
    const f = fees.fastestFee;
    if (f != null) { const pts = f >= 20 ? 10 : f <= 3 ? -5 : 3; s += pts;
      reasons.push({ up: pts > 0, text: 'Fast transaction fee ' + f + ' sat/vB (' + (f >= 20 ? 'high demand for block space' : f <= 3 ? 'low network demand' : 'normal demand') + ')' }); }
    if (mp && mp.count != null) { const pts = mp.count > 50000 ? 5 : 0; s += pts; reasons.push({ up: pts ? true : null, text: mp.count.toLocaleString('en-US') + ' transactions waiting in the mempool' }); }
    return { available: true, score: Math.round(clamp(s)), reasons, source: 'mempool.space' };
  }
  async function alchemy(method, params) {
    const j = await getJson('https://eth-mainnet.g.alchemy.com/v2/' + ALCHEMY_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }) });
    if (j.error) throw new Error('Alchemy error');
    return j.result;
  }
  async function onchainEth() {
    const reasons = []; let s = 50;
    const [gas, blk] = await Promise.all([alchemy('eth_gasPrice', []), alchemy('eth_getBlockByNumber', ['latest', false])]);
    const gwei = parseInt(gas, 16) / 1e9;
    const util = parseInt(blk.gasUsed, 16) / parseInt(blk.gasLimit, 16) * 100;
    const ptsU = util > 55 ? 10 : util < 40 ? -10 : 0; s += ptsU;
    reasons.push({ up: ptsU > 0 ? true : ptsU < 0 ? false : null, text: 'Latest block ' + util.toFixed(0) + '% full (' + blk.transactions.length + ' transactions)' });
    const ptsG = gwei > 20 ? 8 : gwei < 1 ? -5 : 0; s += ptsG;
    reasons.push({ up: ptsG > 0 ? true : ptsG < 0 ? false : null, text: 'Gas price ' + gwei.toFixed(2) + ' gwei (' + (gwei > 20 ? 'busy network' : gwei < 1 ? 'quiet network' : 'normal activity') + ')' });
    return { available: true, score: Math.round(clamp(s)), reasons, source: 'Alchemy' };
  }
  async function onchainToken(contract) {
    const head = parseInt(await alchemy('eth_blockNumber', []), 16), span = 1800; // ~6 hours
    const count = async (from, to) => { const r = await alchemy('alchemy_getAssetTransfers', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), contractAddresses: [contract], category: ['erc20'], maxCount: '0x3e8', withMetadata: false }]); return { n: r.transfers.length, more: !!r.pageKey }; };
    const [now, prev] = await Promise.all([count(head - span, head), count(head - 2 * span, head - span - 1)]);
    const reasons = []; let s = 50;
    if (now.more && prev.more) { s += 10; reasons.push({ up: true, text: 'Very active: over 1,000 token transfers in each of the last two 6-hour windows' }); }
    else { const d = prev.n ? (now.n / prev.n - 1) * 100 : 0; const pts = d > 15 ? 15 : d < -15 ? -15 : 0; s += pts;
      reasons.push({ up: pts > 0 ? true : pts < 0 ? false : null, text: now.n + (now.more ? '+' : '') + ' token transfers in the last 6 hours vs ' + prev.n + (prev.more ? '+' : '') + ' in the 6 hours before' }); }
    return { available: true, score: Math.round(clamp(s)), reasons, source: 'Alchemy' };
  }
  async function onchain(sym, fund) {
    if (sym === 'BTC') return onchainBtc();
    if (sym === 'ETH') { if (!hasAlchemy) return { available: false, note: 'Alchemy key not set' }; return onchainEth(); }
    const p = fund && fund.metrics && fund.metrics.platform;
    if (p && /ethereum/i.test(p.name || p.slug || '') && p.token_address) {
      if (!hasAlchemy) return { available: false, note: 'Alchemy key not set' };
      return onchainToken(p.token_address);
    }
    if (!fund || !fund.available) return { available: false, note: 'Needs CoinMarketCap to find the token contract' };
    return { available: false, note: 'No free on-chain source for this coin' };
  }

  // CoinGecko page link for a symbol. Symbols can collide, so pick the exact
  // symbol match with the best market cap rank (preferring the CMC name).
  const CG_FIXED = { BTC: 'bitcoin', ETH: 'ethereum', USDT: 'tether', BNB: 'binancecoin', SOL: 'solana', XRP: 'ripple', USDC: 'usd-coin', ADA: 'cardano', DOGE: 'dogecoin', TRX: 'tron', POL: 'polygon-ecosystem-token', DOT: 'polkadot', LINK: 'chainlink', AVAX: 'avalanche-2', LTC: 'litecoin', SHIB: 'shiba-inu' };
  async function coingeckoUrl(sym, name) {
    const fallback = 'https://www.coingecko.com/en/search?query=' + encodeURIComponent(sym);
    if (CG_FIXED[sym]) return 'https://www.coingecko.com/en/coins/' + CG_FIXED[sym];
    try {
      const id = await cached('cg:' + sym + ':' + (name || ''), 24 * 60 * 60 * 1000, async () => {
        const r = await fetch('https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(sym), { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const m = (j.coins || []).filter(c => String(c.symbol).toUpperCase() === sym);
        if (!m.length) return null;
        const byName = name && m.find(c => String(c.name).toLowerCase() === String(name).toLowerCase());
        if (byName) return byName.id;
        m.sort((a, b) => (a.market_cap_rank || 1e9) - (b.market_cap_rank || 1e9));
        return m[0].id;
      });
      return id ? 'https://www.coingecko.com/en/coins/' + id : fallback;
    } catch (e) { cache.delete('cg:' + sym + ':' + (name || '')); return fallback; }
  }

  const safe = async (fn, label) => { try { return await fn(); } catch (e) { console.warn('[analyze] ' + label + ':', e.message); return { available: false, note: label + ' source unavailable' }; } };

  app.get('/api/analyze/:symbol', async (req, res) => {
    const sym = String(req.params.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
    if (!sym) return res.status(400).json({ ok: false, error: 'Bad symbol' });
    try {
      const out = await cached('a:' + sym, TTL, async () => {
        let k = null, kErr = null;
        try { k = await klines(sym); } catch (e) { kErr = e.message; }
        const tech = k ? await safe(async () => technical(k), 'Technical') : { available: false, note: 'No Binance ' + sym + '/USDT market' };
        const [fund, sent] = await Promise.all([safe(() => fundamental(sym, k), 'CoinMarketCap'), safe(() => sentiment(sym, k), 'Sentiment')]);
        const chain = await safe(() => onchain(sym, fund), 'On-chain');
        if (fund.metrics) delete fund.metrics.platform;
        const c = k ? k.map(x => x.c) : [];
        const name = fund.metrics && fund.metrics.name || null;
        const cgUrl = await coingeckoUrl(sym, name);
        return { symbol: sym, name: fund.metrics && fund.metrics.name || sym, price: k ? c[c.length - 1] : null, change_7d: k ? chg(c, 7) : null, change_30d: k ? chg(c, 30) : null, coingecko_url: cgUrl,
          scores: { technical: tech, fundamental: fund, onchain: chain, sentiment: sent }, updated: new Date().toISOString() };
      });
      res.json({ ok: true, data: out });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  // Weight sliders, shared across devices. Stored outside the app folder.
  const WFILE = process.env.ANALYZE_WEIGHTS_FILE || path.join(os.homedir(), 'cipher-data', 'analyze-weights.json');
  const KEYS = ['technical', 'fundamental', 'onchain', 'sentiment'];
  app.get('/api/analyze-weights', (req, res) => {
    try { const j = JSON.parse(fs.readFileSync(WFILE, 'utf8')); res.json({ ok: true, weights: j.weights, saved: true }); }
    catch (e) { res.json({ ok: true, weights: null, saved: false }); }
  });
  app.put('/api/analyze-weights', (req, res) => {
    const w = req.body && req.body.weights;
    if (!w || typeof w !== 'object' || !KEYS.every(k => Number.isFinite(+w[k]) && +w[k] >= 0 && +w[k] <= 100)) return res.status(400).json({ ok: false, error: 'Bad weights' });
    try {
      fs.mkdirSync(path.dirname(WFILE), { recursive: true });
      const clean = {}; KEYS.forEach(k => clean[k] = +w[k]);
      fs.writeFileSync(WFILE + '.tmp', JSON.stringify({ weights: clean, updated: Date.now() }));
      fs.renameSync(WFILE + '.tmp', WFILE);
      res.json({ ok: true });
    } catch (e) { console.error('weights save error:', e.message); res.status(500).json({ ok: false, error: 'Could not save weights' }); }
  });
};
