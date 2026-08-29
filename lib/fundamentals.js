import { getYahooAuth, invalidateYahooAuth } from './markets.js';
import { cachedFetch } from './cache.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// A curated, fixed watchlist of large, liquid stocks (India + global). Worker 1
// is instructed to only recommend from this evidence-backed pool - this is
// the concrete mechanism behind "evidence-based agents": the model cannot
// cite fundamentals for a stock we never actually fetched real data for.
export const EVIDENCE_WATCHLIST = [
  'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS', 'BHARTIARTL.NS', 'ITC.NS', 'LT.NS',
  'AAPL', 'MSFT', 'GOOGL', 'NVDA', 'AMZN',
];

async function fetchQuoteSummaryOnce(symbol, forceFreshAuth) {
  const { crumb, cookie } = await getYahooAuth(forceFreshAuth);
  const modules = 'defaultKeyStatistics,financialData,summaryDetail,price';
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie } });
  if (!r.ok) {
    // 401/403 almost always means the cached crumb/cookie is no longer valid
    // (Yahoo rotates/invalidates these more aggressively than the 55-minute
    // cache window assumes) - flag it so the caller can force a fresh
    // handshake instead of re-serving the same broken auth for up to an hour.
    const err = new Error(`Yahoo quoteSummary HTTP ${r.status} for ${symbol}`);
    err.authFailure = r.status === 401 || r.status === 403;
    throw err;
  }
  const json = await r.json();
  const result = json?.quoteSummary?.result?.[0];
  if (!result) throw new Error(`No fundamentals data for ${symbol}`);
  const fd = result.financialData || {}, dks = result.defaultKeyStatistics || {}, sd = result.summaryDetail || {}, price = result.price || {};
  // Yahoo's quoteSummary fields are USUALLY {raw, fmt} objects, but not
  // reliably - depending on the field and the exact response, a value can
  // come back as a bare number, a numeric string, or an object missing
  // `raw` entirely (e.g. just {fmt}). The previous version assumed anything
  // that wasn't a {raw:...} object was already a safe number and passed it
  // straight through, which is exactly how a value like debtToEquity could
  // end up as a non-numeric type later handed to .toFixed() and crash the
  // whole worker. Coerce to Number and validate here instead, once, so every
  // field downstream is guaranteed to be either a finite number or null.
  const raw = v => {
    if (v == null) return null; // Number(null) is 0, not NaN - must be excluded explicitly or a genuinely missing field silently becomes a fake "0"
    const val = (typeof v === 'object' && 'raw' in v) ? v.raw : v;
    if (val == null) return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };
  return {
    symbol,
    name: price.longName || price.shortName || symbol,
    currentPrice: raw(price.regularMarketPrice),
    trailingPE: raw(sd.trailingPE), forwardPE: raw(sd.forwardPE),
    priceToBook: raw(dks.priceToBook),
    revenueGrowthPct: raw(fd.revenueGrowth) != null ? raw(fd.revenueGrowth) * 100 : null,
    earningsGrowthPct: raw(fd.earningsGrowth) != null ? raw(fd.earningsGrowth) * 100 : null,
    profitMarginPct: raw(fd.profitMargins) != null ? raw(fd.profitMargins) * 100 : null,
    returnOnEquityPct: raw(fd.returnOnEquity) != null ? raw(fd.returnOnEquity) * 100 : null,
    debtToEquity: raw(fd.debtToEquity),
    recommendationKey: fd.recommendationKey || null,
    targetMeanPrice: raw(fd.targetMeanPrice),
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchQuoteSummary(symbol) {
  const key = `fundamentals:${symbol}`;
  const { data } = await cachedFetch(key, 3600, async () => {
    try {
      return await fetchQuoteSummaryOnce(symbol, false);
    } catch (err) {
      if (!err.authFailure) throw err;
      // The crumb/cookie we had cached is dead - drop it and do exactly one
      // retry with a completely fresh handshake before giving up on this
      // symbol. Without this, one bad crumb silently kills Worker 1's entire
      // evidence pool (and therefore Worker 1 itself) for up to 55 minutes.
      invalidateYahooAuth();
      return await fetchQuoteSummaryOnce(symbol, true);
    }
  });
  return data;
}

export async function getEvidencePool(symbols = EVIDENCE_WATCHLIST) {
  const settled = await Promise.allSettled(symbols.map(fetchQuoteSummary));
  const items = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(r.value);
    else failures.push(symbols[i]);
  });
  return { items, failures };
}

/**
 * Formats the evidence pool as plain text for injection into a worker's
 * prompt - every number here is real, fetched moments ago (or served from a
 * 1-hour cache), never invented by the model.
 */
export function formatEvidenceForPrompt(pool) {
  if (!pool.items.length) return 'No fundamentals data could be fetched right now - do not invent any P/E, revenue growth, or margin figures; say "data unavailable" instead.';
  // Never call .toFixed() on a field straight from Yahoo's response, even
  // though fetchQuoteSummaryOnce's raw() now validates numbers at the
  // source - a single malformed field here previously crashed the entire
  // route (and therefore the whole worker) with a raw TypeError. num()
  // guarantees a formatted string or nothing, never a throw.
  const num = (v, decimals) => Number.isFinite(v) ? v.toFixed(decimals) : null;
  const lines = pool.items.map(f => {
    const parts = [`${f.name} (${f.symbol})`];
    if (Number.isFinite(f.currentPrice)) parts.push(`price ${f.currentPrice}`);
    if (num(f.trailingPE, 1) != null) parts.push(`P/E ${num(f.trailingPE, 1)}`);
    if (num(f.revenueGrowthPct, 1) != null) parts.push(`rev growth ${num(f.revenueGrowthPct, 1)}%`);
    if (num(f.profitMarginPct, 1) != null) parts.push(`profit margin ${num(f.profitMarginPct, 1)}%`);
    if (num(f.returnOnEquityPct, 1) != null) parts.push(`ROE ${num(f.returnOnEquityPct, 1)}%`);
    if (num(f.debtToEquity, 2) != null) parts.push(`D/E ${num(f.debtToEquity, 2)}`);
    if (Number.isFinite(f.targetMeanPrice)) parts.push(`analyst target ${f.targetMeanPrice}`);
    parts.push(`[as of ${f.fetchedAt}]`);
    return '- ' + parts.join(', ');
  });
  if (pool.failures.length) lines.push(`(Fundamentals unavailable right now for: ${pool.failures.join(', ')} - do not recommend these or invent numbers for them.)`);
  return lines.join('\n');
}
