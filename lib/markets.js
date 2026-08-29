import { cachedFetch } from './cache.js';
import { fetchStooqQuote } from './stooq.js';

// We talk to Yahoo Finance's own chart endpoint directly with plain fetch(),
// rather than depending on the yahoo-finance2 npm package. That package's
// method names/shape have changed across versions (the exact bug that broke
// this dashboard) - going straight to the HTTP endpoint means we only depend
// on Yahoo's JSON response shape, which is far more stable, and we get both
// a live quote AND historical candles from ONE endpoint.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchYahooChart(symbol, range = '5d', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Yahoo Finance HTTP ${r.status} for ${symbol}`);
  const json = await r.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance: ${json?.chart?.error?.description || 'no data'} for ${symbol}`);
  return result;
}

function metaToQuote(result) {
  const m = result.meta;
  const price = m.regularMarketPrice ?? null;
  const prevClose = m.chartPreviousClose ?? m.previousClose ?? null;
  const change = price != null && prevClose != null ? price - prevClose : null;
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;
  return {
    symbol: m.symbol,
    price, change, changePct,
    prevClose,
    dayHigh: m.regularMarketDayHigh ?? null,
    dayLow: m.regularMarketDayLow ?? null,
    marketState: m.marketState ?? null,
    currency: m.currency ?? null,
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
  };
}

async function quoteOne(symbol) {
  const result = await fetchYahooChart(symbol, '5d', '1d');
  const q = metaToQuote(result);
  if (q.price == null) throw new Error(`No live price in Yahoo response for ${symbol}`);
  return q;
}

async function quoteMany(symbols) {
  const settled = await Promise.allSettled(symbols.map(quoteOne));
  const items = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(r.value);
    else failures.push(`${symbols[i]}: ${r.reason?.message || 'failed'}`);
  });
  if (failures.length) console.warn('quoteMany partial failures:', failures.join(' | '));
  return { items, failures };
}

export const SYMBOLS = {
  indicesIndia: {
    '^NSEI': 'NIFTY 50',
    '^BSESN': 'SENSEX',
    '^NSEBANK': 'NIFTY BANK',
    '^CNXIT': 'NIFTY IT',
    '^INDIAVIX': 'INDIA VIX',
    '^CNXFMCG': 'NIFTY FMCG',
    '^CNXPHARMA': 'NIFTY PHARMA',
    '^CNXAUTO': 'NIFTY AUTO',
    '^CNXENERGY': 'NIFTY ENERGY',
    '^CNXMETAL': 'NIFTY METAL',
    '^CNXPSE': 'NIFTY PSE',
    '^CNXREALTY': 'NIFTY REALTY',
  },
  indicesGlobal: {
    '^GSPC': 'S&P 500',
    '^IXIC': 'NASDAQ Composite',
    '^FTSE': 'FTSE 100',
    '^N225': 'NIKKEI 225',
    '^HSI': 'HANG SENG',
    '^GDAXI': 'DAX',
    '^FCHI': 'CAC 40',
    '000001.SS': 'SHANGHAI COMPOSITE',
  },
  commodities: {
    'GC=F': { name: 'Gold Futures (COMEX)', unit: 'USD/troy oz' },
    'SI=F': { name: 'Silver Futures (COMEX)', unit: 'USD/troy oz' },
    'HG=F': { name: 'Copper Futures (COMEX)', unit: 'USD/lb' },
    'PL=F': { name: 'Platinum Futures (NYMEX)', unit: 'USD/troy oz' },
    'CL=F': { name: 'WTI Crude Oil', unit: 'USD/bbl' },
    'BZ=F': { name: 'Brent Crude Oil', unit: 'USD/bbl' },
  },
  // Global index FUTURES (not spot/cash) - these carry a real, live futures basis
  // (contango/backwardation vs the cash index) the way NIFTY/BANKNIFTY futures
  // would on NSE. NSE's own futures aren't available via any free source (see
  // README), so these stand in as the genuine, live futures data this dashboard
  // can actually get for free, and feed directly into Worker 1/2's prompts.
  indexFutures: {
    'ES=F': 'S&P 500 Futures', 'NQ=F': 'Nasdaq 100 Futures', 'YM=F': 'Dow Futures', 'RTY=F': 'Russell 2000 Futures',
  },
  fx: {
    'USDINR=X': 'USD/INR', 'EURINR=X': 'EUR/INR', 'GBPINR=X': 'GBP/INR',
    'JPYINR=X': 'JPY/INR', 'AUDINR=X': 'AUD/INR', 'CADINR=X': 'CAD/INR',
    'CHFINR=X': 'CHF/INR', 'CNYINR=X': 'CNY/INR', 'SGDINR=X': 'SGD/INR',
    'AEDINR=X': 'AED/INR',
  },
};

export async function getIndexFutures() { return getQuotes(SYMBOLS.indexFutures); }

/**
 * NIFTY futures FAIR VALUE via the standard cost-of-carry formula:
 *   Fair Value = Spot x (1 + (r - d) x t/365)
 * where r = short-term risk-free rate (approximated), d = dividend yield
 * (approximated), t = days to the near-month NSE F&O expiry (last Thursday
 * of the current month, approximated here).
 * This is a THEORETICAL value, not the live traded NSE futures price
 * (which needs a broker API - see README) - labeled as such everywhere it's used.
 */
export function niftyFuturesFairValue(spot, asOfDate = new Date()) {
  const ASSUMED_RATE = 0.065; // approx short-term INR risk-free rate - update if it materially changes
  const ASSUMED_DIVIDEND_YIELD = 0.012; // approx NIFTY 50 dividend yield
  const d = new Date(asOfDate);
  let lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  while (lastDay.getDay() !== 4) lastDay.setDate(lastDay.getDate() - 1); // last Thursday
  if (lastDay < d) { lastDay = new Date(d.getFullYear(), d.getMonth() + 2, 0); while (lastDay.getDay() !== 4) lastDay.setDate(lastDay.getDate() - 1); }
  const daysToExpiry = Math.max(1, Math.round((lastDay - d) / 86400000));
  const fairValue = spot * (1 + (ASSUMED_RATE - ASSUMED_DIVIDEND_YIELD) * daysToExpiry / 365);
  return { fairValue, daysToExpiry, expiryDate: lastDay.toISOString().slice(0, 10), assumedRate: ASSUMED_RATE, assumedDividendYield: ASSUMED_DIVIDEND_YIELD };
}

export async function getQuotes(symbolMap) {
  const symbols = Object.keys(symbolMap);
  const key = 'quotes:' + symbols.join(',');
  const { data, stale, fetchedAt } = await cachedFetch(key, 10, async () => {
    const { items, failures } = await quoteMany(symbols);
    if (items.length === 0) throw new Error(`Yahoo Finance returned no data for any symbol. First failure: ${failures[0] || 'unknown'}`);
    return items;
  });
  const enriched = data.map(d => ({ ...d, name: symbolMap[d.symbol] || d.symbol }));
  return { items: enriched, stale, fetchedAt };
}

export async function getIndicesIndia() { return getQuotes(SYMBOLS.indicesIndia); }
export async function getIndicesGlobal() { return getQuotes(SYMBOLS.indicesGlobal); }

export async function getFx() {
  const raw = await getQuotes(SYMBOLS.fx);
  if (!raw.items.some(i => i.symbol === 'USDINR=X')) {
    try {
      const s = await fetchStooqQuote('USDINR');
      raw.items.push({ symbol: 'USDINR=X', name: 'USD/INR', price: s.price, change: null, changePct: null, asOf: new Date().toISOString(), source: 'stooq-fallback' });
    } catch (e) { console.warn('Stooq USDINR fallback also failed:', e.message); }
  }
  return raw;
}

export async function getCommodities() {
  const symbols = Object.keys(SYMBOLS.commodities);
  const key = 'commodities:' + symbols.join(',');
  const { data, stale, fetchedAt } = await cachedFetch(key, 10, async () => {
    const { items, failures } = await quoteMany(symbols);
    if (items.length === 0 && failures.length === symbols.length) {
      throw new Error(`Yahoo Finance returned no commodity data. First failure: ${failures[0]}`);
    }
    return items;
  });
  let items = data.map(d => ({ ...d, ...SYMBOLS.commodities[d.symbol] }));

  // Fallback: if Yahoo specifically dropped gold or silver, backfill from Stooq spot.
  if (!items.some(i => i.symbol === 'GC=F')) {
    try {
      const s = await fetchStooqQuote('XAUUSD');
      items.push({ symbol: 'GC=F', name: 'Gold Spot (Stooq fallback)', unit: 'USD/troy oz', price: s.price, changePct: null, asOf: new Date().toISOString(), source: 'stooq-fallback' });
    } catch (e) { console.warn('Stooq gold fallback also failed:', e.message); }
  }
  if (!items.some(i => i.symbol === 'SI=F')) {
    try {
      const s = await fetchStooqQuote('XAGUSD');
      items.push({ symbol: 'SI=F', name: 'Silver Spot (Stooq fallback)', unit: 'USD/troy oz', price: s.price, changePct: null, asOf: new Date().toISOString(), source: 'stooq-fallback' });
    } catch (e) { console.warn('Stooq silver fallback also failed:', e.message); }
  }
  if (items.length === 0) throw new Error('Both Yahoo Finance and the Stooq fallback failed for all commodities.');
  return { items, stale, fetchedAt };
}

/**
 * India retail gold/silver rates are DERIVED, transparently, from the live
 * gold/silver USD price x live USD/INR, plus documented duty/GST/premium -
 * never a hardcoded number pretending to be live. If either source fails,
 * this whole calculation fails loudly rather than showing a stale guess as
 * if it were current.
 */
export async function getIndiaBullion() {
  const [commodities, fx] = await Promise.all([getCommodities(), getFx()]);
  const gold = commodities.items.find(i => i.symbol === 'GC=F');
  const silver = commodities.items.find(i => i.symbol === 'SI=F');
  const copper = commodities.items.find(i => i.symbol === 'HG=F');
  const platinum = commodities.items.find(i => i.symbol === 'PL=F');
  const usdinr = fx.items.find(i => i.symbol === 'USDINR=X');
  if (!gold?.price || !silver?.price || !usdinr?.price) {
    throw new Error('Live gold/silver/USDINR feed unavailable right now (both Yahoo and the Stooq fallback failed)');
  }
  const TROY_OZ_G = 31.1035;
  const LB_KG = 0.453592;
  const DUTY_GST_PRECIOUS = 0.18; // 15% import duty + 3% GST on gold/silver/platinum, per current Indian customs policy - update if policy changes
  const DUTY_GST_BASE_METAL = 0.08; // approximate local premium for base metals like copper - adjust if you have a more precise figure
  const toTenGram = (usdPerOz) => (usdPerOz * usdinr.price / TROY_OZ_G) * 10;

  const gold24k = toTenGram(gold.price) * (1 + DUTY_GST_PRECIOUS);
  const rows = [
    { label: '24K Gold', purity: '999.9', per: '10g', inr: gold24k, asOf: gold.asOf },
    { label: '22K Gold', purity: '916 Hallmark', per: '10g', inr: gold24k * 22 / 24, asOf: gold.asOf },
    { label: '18K Gold', purity: '750', per: '10g', inr: gold24k * 18 / 24, asOf: gold.asOf },
    { label: 'Silver', purity: '999', per: '1kg', inr: (silver.price * usdinr.price / TROY_OZ_G) * 1000 * (1 + DUTY_GST_PRECIOUS), asOf: silver.asOf },
  ];
  if (platinum?.price) rows.push({ label: 'Platinum', purity: '999', per: '10g', inr: toTenGram(platinum.price) * (1 + DUTY_GST_PRECIOUS), asOf: platinum.asOf });
  if (copper?.price) rows.push({ label: 'Copper', purity: 'LME/COMEX grade', per: '1kg', inr: (copper.price / LB_KG) * usdinr.price * (1 + DUTY_GST_BASE_METAL), asOf: copper.asOf });

  return {
    rows,
    basis: {
      goldUsdOz: gold.price, silverUsdOz: silver.price, usdinr: usdinr.price, dutyGstPct: DUTY_GST_PRECIOUS * 100,
      sources: { gold: gold.source || 'yahoo', silver: silver.source || 'yahoo', usdinr: usdinr.source || 'yahoo' },
      asOf: { gold: gold.asOf, silver: silver.asOf, usdinr: usdinr.asOf },
    },
    stale: commodities.stale || fx.stale,
    fetchedAt: Math.min(commodities.fetchedAt, fx.fetchedAt),
  };
}

export async function getQuote(symbol) { return quoteOne(symbol); }

export async function searchSymbols(query) {
  const key = 'search:' + query.toLowerCase();
  const { data } = await cachedFetch(key, 300, async () => {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Yahoo search HTTP ${r.status}`);
    const json = await r.json();
    return (json.quotes || [])
      .filter(q => q.symbol)
      .map(q => ({ symbol: q.symbol, name: q.shortname || q.longname || q.symbol, exch: q.exchange || '', type: q.quoteType || '' }));
  });
  return data;
}

export const QUICK_PICKS = [
  { symbol: 'GC=F', name: 'Gold' }, { symbol: 'SI=F', name: 'Silver' },
  { symbol: 'CL=F', name: 'Crude Oil (WTI)' }, { symbol: 'HG=F', name: 'Copper' },
  { symbol: 'BTC-USD', name: 'Bitcoin' }, { symbol: 'ETH-USD', name: 'Ethereum' },
  { symbol: '^NSEI', name: 'NIFTY 50' }, { symbol: '^GSPC', name: 'S&P 500' },
];

// Yahoo's options AND quoteSummary (fundamentals) endpoints enforce a
// session-cookie + crumb-token handshake. This fetches and caches both,
// refreshing hourly.
//
// IMPORTANT: a crumb/cookie pair can go bad mid-lifetime (Yahoo invalidates
// it, or it was never actually valid for the endpoint we needed) - if we
// blindly cache it for 55 minutes regardless, EVERY fundamentals/options
// call fails identically for the next hour even though a fresh handshake
// would fix it immediately. So callers that get an auth-related failure
// should call invalidateYahooAuth() before retrying, and getYahooAuth()
// accepts a forceRefresh flag to skip the cache entirely.
let yahooAuth = null, yahooAuthExpiry = 0;
export async function getYahooAuth(forceRefresh = false) {
  if (!forceRefresh && yahooAuth && Date.now() < yahooAuthExpiry) return yahooAuth;
  const cookieRes = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const setCookie = typeof cookieRes.headers.getSetCookie === 'function'
    ? cookieRes.headers.getSetCookie()[0]
    : cookieRes.headers.get('set-cookie');
  const cookie = (setCookie || '').split(';')[0];
  if (!cookie) throw new Error('Could not obtain a Yahoo session cookie (needed for options/fundamentals data)');
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  if (!crumbRes.ok) throw new Error(`Could not obtain a Yahoo crumb token: HTTP ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes('<')) throw new Error('Yahoo returned an invalid crumb token');
  yahooAuth = { cookie, crumb };
  yahooAuthExpiry = Date.now() + 55 * 60 * 1000;
  return yahooAuth;
}

// Drops the cached auth so the next getYahooAuth() call does a fresh
// handshake instead of re-serving a crumb that just failed.
export function invalidateYahooAuth() {
  yahooAuth = null;
  yahooAuthExpiry = 0;
}

export async function getOptionsChain(symbol, expiryUnix) {
  const key = `options:${symbol}:${expiryUnix || 'default'}`;
  const { data } = await cachedFetch(key, 30, async () => {
    const auth = await getYahooAuth();
    const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(auth.crumb)}${expiryUnix ? `&date=${expiryUnix}` : ''}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: auth.cookie } });
    if (!r.ok) throw new Error(`Yahoo options HTTP ${r.status} for ${symbol}`);
    const json = await r.json();
    const result = json?.optionChain?.result?.[0];
    if (!result || !result.options?.length) throw new Error(`No options chain available for ${symbol} (only US-listed stocks/ETFs carry free options data - NSE options need a broker API)`);
    const opt = result.options[0];
    const mapLeg = c => ({ strike: c.strike, lastPrice: c.lastPrice, bid: c.bid, ask: c.ask, openInterest: c.openInterest, volume: c.volume, impliedVol: c.impliedVolatility });
    return {
      symbol, underlyingPrice: result.quote?.regularMarketPrice ?? null,
      expiryDates: (result.expirationDates || []).map(t => new Date(t * 1000).toISOString().slice(0, 10)),
      expiry: new Date(opt.expirationDate * 1000).toISOString().slice(0, 10),
      calls: (opt.calls || []).map(mapLeg), puts: (opt.puts || []).map(mapLeg),
    };
  });
  return data;
}

export async function getHistory(symbol, range = '1mo', interval = '1d') {
  const key = `hist:${symbol}:${range}:${interval}`;
  const { data, stale } = await cachedFetch(key, 60, async () => {
    const result = await fetchYahooChart(symbol, range, interval);
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = ts.map((t, i) => ({
      date: new Date(t * 1000).toISOString(),
      open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i],
    })).filter(c => c.open != null && c.close != null);
    if (!candles.length) throw new Error(`No usable candle data returned for ${symbol}`);
    return candles;
  });
  return { candles: data, stale };
}
