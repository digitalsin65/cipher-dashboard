// Stocks for the "My leverage" paper account: the stock list, market hours (US and ASX) and free Yahoo Finance prices.
// Paper only. Yahoo's public chart endpoint needs no key; it is unofficial, so it can change or rate-limit without notice.
// US prices are usually near real time; ASX prices are about 20 minutes delayed. The page shows each price's age.

const STK = {
  minLev: 1, maxLev: 5,             // like share CFDs
  feePct: 0.001,                    // 0.1% per side on the position size
  financePct: 0.0002,               // 0.02% of the position size for each night held (weekend nights count), longs and shorts
  mmr: 0.05,                        // maintenance margin 5%: 5x is liquidated about 15% against, 2x about 45%
  cacheMs: 12e3,                    // one Yahoo call per symbol at most every 12 s
  fetchedStaleMs: 30e3,             // we must have fetched the price within 30 s to trade on it
  maxDataAgeMs: { US: 20 * 60e3, ASX: 30 * 60e3 }, // the price itself may be this old (ASX is ~20 min delayed)
};
const MARKETS = {
  US: { tz: 'America/New_York', open: [9, 30], close: [16, 0], currency: 'USD', label: 'US market' },
  ASX: { tz: 'Australia/Sydney', open: [10, 0], close: [16, 0], currency: 'AUD', label: 'ASX' },
};
const LIST = [
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['TSLA', 'Tesla'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet (Google)'], ['META', 'Meta Platforms'],
  ['AMD', 'AMD'], ['NFLX', 'Netflix'], ['PLTR', 'Palantir'], ['COIN', 'Coinbase'], ['MSTR', 'Strategy (MicroStrategy)'], ['AVGO', 'Broadcom'], ['TSM', 'TSMC'],
  ['ARM', 'Arm Holdings'], ['MU', 'Micron'], ['INTC', 'Intel'], ['SMCI', 'Super Micro Computer'], ['ORCL', 'Oracle'], ['CRM', 'Salesforce'], ['ADBE', 'Adobe'],
  ['UBER', 'Uber'], ['SHOP', 'Shopify'], ['HOOD', 'Robinhood'], ['SOFI', 'SoFi'], ['RIVN', 'Rivian'], ['BABA', 'Alibaba'], ['DIS', 'Disney'], ['JPM', 'JPMorgan Chase'],
  ['V', 'Visa'], ['WMT', 'Walmart'], ['KO', 'Coca-Cola'], ['BRK-B', 'Berkshire Hathaway B'], ['GME', 'GameStop'],
  ['SPY', 'S&P 500 ETF'], ['QQQ', 'Nasdaq 100 ETF'], ['DIA', 'Dow Jones ETF'], ['IWM', 'Russell 2000 ETF'], ['GLD', 'Gold ETF'], ['TLT', '20+ Year Treasury ETF'],
  ['ARKK', 'ARK Innovation ETF'], ['IBIT', 'iShares Bitcoin ETF'],
  ['BHP.AX', 'BHP'], ['CBA.AX', 'Commonwealth Bank'], ['CSL.AX', 'CSL'], ['NAB.AX', 'NAB'], ['WBC.AX', 'Westpac'], ['ANZ.AX', 'ANZ'], ['RIO.AX', 'Rio Tinto'],
  ['FMG.AX', 'Fortescue'], ['MQG.AX', 'Macquarie'], ['WES.AX', 'Wesfarmers'], ['WOW.AX', 'Woolworths'], ['TLS.AX', 'Telstra'], ['XRO.AX', 'Xero'], ['PLS.AX', 'Pilbara Minerals'],
].map(([symbol, name]) => ({ symbol, name, market: symbol.endsWith('.AX') ? 'ASX' : 'US', currency: symbol.endsWith('.AX') ? 'AUD' : 'USD' }));

const cleanSym = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const validSym = s => /^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(s);
const marketOfSym = s => (s.endsWith('.AX') ? 'ASX' : /\./.test(s) ? null : 'US');

// ---------- time zones and market hours (pure, unit tested) ----------
function zoneParts(tz, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
// epoch ms of a wall-clock time in a time zone
function zoned(tz, y, m, d, h, min) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess;
  for (let i = 0; i < 3; i++) { const p = zoneParts(tz, t); const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - t; t = guess - off; }
  return t;
}
// Weekday session [open, close] for the local date containing ms (null on weekends).
function sessionOn(market, ms) {
  const M = MARKETS[market], p = zoneParts(M.tz, ms);
  if (p.wd === 0 || p.wd === 6) return null;
  return { open: zoned(M.tz, p.y, p.m, p.d, M.open[0], M.open[1]), close: zoned(M.tz, p.y, p.m, p.d, M.close[0], M.close[1]) };
}
// { open, opensAt, closesAt }. ctp = Yahoo's currentTradingPeriod.regular ({ start, end } in seconds), which knows holidays
// and early closes; used when we have it, otherwise the plain weekday calendar.
function marketState(market, now = Date.now(), ctp = null) {
  if (ctp && ctp.start && ctp.end) {
    const s = ctp.start * 1000, e = ctp.end * 1000;
    if (now >= s && now < e) return { open: true, opensAt: s, closesAt: e, source: 'yahoo' };
    if (now < s && s - now < 4 * 86400e3) return { open: false, opensAt: s, closesAt: e, source: 'yahoo' };
    // the period has ended: fall through to the calendar for the next one
  }
  const today = sessionOn(market, now);
  if (today && now >= today.open && now < today.close && !(ctp && ctp.end && ctp.end * 1000 <= now && ctp.end * 1000 > today.open)) return { open: true, opensAt: today.open, closesAt: today.close, source: 'calendar' };
  for (let i = 0; i < 8; i++) {
    const s = sessionOn(market, now + i * 86400e3);
    if (s && s.open > now) return { open: false, opensAt: s.open, closesAt: s.close, source: 'calendar' };
  }
  return { open: false, opensAt: null, closesAt: null, source: 'calendar' };
}
// Number of local 4 pm closes in (from, to], every calendar day (weekend nights count, like CFD financing).
function nightsBetween(market, from, to) {
  if (!(to > from)) return 0;
  const M = MARKETS[market]; let n = 0;
  const p = zoneParts(M.tz, from);
  for (let i = 0; i < 400; i++) {
    const c = zoned(M.tz, p.y, p.m, p.d + i, M.close[0], M.close[1]); // Date.UTC rolls the day over months
    if (c > to) break;
    if (c > from) n++;
  }
  return n;
}

// "1:30 am Wed 25 Nov" in Sydney time (Mike's time zone), for messages from the server.
function sydney(ms) {
  if (!ms) return 'the next trading day';
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms)) + ' Sydney time';
}

// ---------- Yahoo Finance quotes ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
function parseChart(sym, j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.meta) { const e = new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'no data'); e.notFound = true; throw e; }
  const m = r.meta, tz = m.exchangeTimezoneName;
  const market = tz === 'America/New_York' ? 'US' : tz === 'Australia/Sydney' ? 'ASX' : null;
  return { symbol: sym, name: m.shortName || m.longName || sym, longName: m.longName || null, price: +m.regularMarketPrice, at: (m.regularMarketTime || 0) * 1000,
    currency: m.currency, market, type: m.instrumentType, exchange: m.fullExchangeName || m.exchangeName, prevClose: m.chartPreviousClose || m.previousClose || null,
    ctp: m.currentTradingPeriod && m.currentTradingPeriod.regular ? { start: m.currentTradingPeriod.regular.start, end: m.currentTradingPeriod.regular.end } : null };
}
function createQuotes({ fetchImpl, now } = {}) {
  const clock = now || (() => Date.now());
  const cache = new Map(); // sym -> { q, fetchedAt } or { err, fetchedAt }
  let host = HOSTS[0], lastErr = null;
  const fetchJ = fetchImpl || (async url => {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': UA, accept: 'application/json' } });
    if (r.status === 404) return r.json(); // Yahoo answers unknown tickers with 404 + a JSON error
    if (!r.ok) { const e = new Error('Yahoo HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  });
  async function fetchOne(sym) {
    let err;
    for (const h of [host, ...HOSTS.filter(x => x !== host)]) {
      try { const q = parseChart(sym, await fetchJ(h + '/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1m&range=1d')); host = h; return q; }
      catch (e) { err = e; if (e.notFound) throw e; }
    }
    // last resort: Yahoo's batched spark endpoint (price and time only)
    try {
      const j = await fetchJ(HOSTS[1] + '/v8/finance/spark?symbols=' + encodeURIComponent(sym) + '&range=1d&interval=5m');
      const s = j && j[sym];
      if (s && s.close && s.close.length) { const i = s.close.length - 1; return { symbol: sym, name: sym, price: +s.close[i], at: s.timestamp[i] * 1000, market: marketOfSym(sym), currency: marketOfSym(sym) === 'ASX' ? 'AUD' : 'USD', type: null, ctp: null, source: 'spark' }; }
    } catch (e) {}
    throw err;
  }
  // Quotes for a few symbols, each cached 12 s. A few in parallel at a time, to be gentle.
  async function get(syms, force) {
    const out = {}, need = [];
    for (const s of new Set(syms)) {
      const c = cache.get(s);
      if (c && !force && clock() - c.fetchedAt < STK.cacheMs) out[s] = c; else need.push(s);
    }
    for (let i = 0; i < need.length; i += 4) {
      await Promise.all(need.slice(i, i + 4).map(async s => {
        try { const q = await fetchOne(s); const c = { q, fetchedAt: clock() }; cache.set(s, c); out[s] = c; lastErr = null; }
        catch (e) { const old = cache.get(s); const c = { q: old && old.q, err: e.message, notFound: !!e.notFound, fetchedAt: old ? old.fetchedAt : 0 }; if (!e.notFound) lastErr = e.message; out[s] = c; if (e.notFound) cache.set(s, { err: e.message, notFound: true, fetchedAt: clock() }); }
      }));
    }
    return out;
  }
  const peek = s => cache.get(s) || null;
  return { get, peek, get error() { return lastErr; } };
}
// Is this quote usable for a trade right now? Returns null if fine, else the reason.
function quoteProblem(c, now = Date.now()) {
  if (!c || !c.q || !(c.q.price > 0)) return c && c.notFound ? 'Unknown ticker' : 'No price yet';
  if (!c.q.market) return 'Only US and ASX listings are supported';
  if (now - c.fetchedAt > STK.fetchedStaleMs) return 'Price is out of date';
  const st = marketState(c.q.market, now, c.q.ctp);
  if (!st.open) return 'Market closed';
  if (c.q.at < st.opensAt) return 'Waiting for the first price of today\'s session';
  if (now - c.q.at > STK.maxDataAgeMs[c.q.market]) return 'Price is out of date';
  return null;
}

module.exports = { sydney, STK, MARKETS, LIST, cleanSym, validSym, marketOfSym, zoneParts, zoned, sessionOn, marketState, nightsBetween, parseChart, createQuotes, quoteProblem };
