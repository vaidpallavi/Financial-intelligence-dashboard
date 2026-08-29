import { cachedFetch } from './cache.js';

// Stooq publishes free, no-key CSV quotes. Used ONLY as a fallback when Yahoo
// fails for these three specific values, since those are the ones most
// likely to feed directly into a number you're showing someone (gold/silver
// retail rate, and the USD/INR rate that rate is built on).
const STOOQ_TICKER = {
  XAUUSD: 'xauusd', // gold spot, USD/oz
  XAGUSD: 'xagusd', // silver spot, USD/oz
  USDINR: 'usdinr',
};

export async function fetchStooqQuote(key) {
  const ticker = STOOQ_TICKER[key];
  if (!ticker) throw new Error(`No Stooq mapping configured for ${key}`);
  const cacheKey = 'stooq:' + ticker;
  const { data } = await cachedFetch(cacheKey, 30, async () => {
    const url = `https://stooq.com/q/l/?s=${ticker}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Stooq HTTP ${r.status} for ${ticker}`);
    const text = (await r.text()).trim();
    const lines = text.split('\n');
    if (lines.length < 2) throw new Error(`Stooq: no data row for ${ticker}`);
    // Header: Symbol,Date,Time,Open,High,Low,Close,Volume
    const cols = lines[1].split(',');
    const close = parseFloat(cols[6]);
    if (!close || Number.isNaN(close)) throw new Error(`Stooq: could not parse a price for ${ticker}`);
    return { price: close, date: cols[1] };
  });
  return data;
}
