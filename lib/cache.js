import NodeCache from 'node-cache';

// stdTTL in seconds. Different data moves at different speeds, so callers
// pass their own TTL per key rather than relying on one global default.
export const cache = new NodeCache({ stdTTL: 20, checkperiod: 30 });

/**
 * Fetch-with-cache-and-fallback.
 * - Serves cached data instantly if still fresh.
 * - On a fresh fetch failure, serves the last known good value (marked stale)
 *   instead of throwing - so the UI never shows a dead "blocked" error for
 *   something that worked five minutes ago.
 */
export async function cachedFetch(key, ttlSeconds, fetcher) {
  const fresh = cache.get(key);
  // cache.getTtl(key) returns the entry's EXPIRY timestamp, not when it was
  // fetched - using it as "fetchedAt" made cache hits report a time in the
  // future instead of the actual last-fetch time. lastgood:time is the real
  // fetch timestamp (it's set every time we actually hit the upstream API),
  // so use that instead.
  if (fresh) return { data: fresh, stale: false, fetchedAt: cache.get(key + ':lastgood:time') ?? Date.now() };

  try {
    const data = await fetcher();
    cache.set(key, data, ttlSeconds);
    cache.set(key + ':lastgood', data, 0); // 0 = never expires, used only as fallback
    cache.set(key + ':lastgood:time', Date.now(), 0);
    return { data, stale: false, fetchedAt: Date.now() };
  } catch (err) {
    const lastGood = cache.get(key + ':lastgood');
    if (lastGood) {
      return {
        data: lastGood,
        stale: true,
        fetchedAt: cache.get(key + ':lastgood:time'),
        error: err.message,
      };
    }
    throw err;
  }
}
