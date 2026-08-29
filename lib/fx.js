import { cachedFetch } from './cache.js';

// Frankfurter tracks the ~30 currencies the European Central Bank publishes
// reference rates for daily. That covers every major and most regional
// currencies (INR, USD, EUR, GBP, JPY, CNY, AED-adjacent via cross-calc,
// SGD, AUD, CAD, CHF, and more) but not every single national currency on
// earth. If you need exotic pairs (e.g. Nepalese Rupee, Kuwaiti Dinar) a
// paid provider like exchangerate-api.com or currencylayer.com covers ~170.
// This is documented here rather than silently pretending otherwise.
export async function getRatesFromINR() {
  const { data, stale, fetchedAt } = await cachedFetch('fx:fromINR', 30, async () => {
    const r = await fetch('https://api.frankfurter.app/latest?from=INR');
    if (!r.ok) throw new Error(`Frankfurter ${r.status}`);
    const json = await r.json();
    return json.rates;
  });
  return { rates: data, stale, fetchedAt };
}
