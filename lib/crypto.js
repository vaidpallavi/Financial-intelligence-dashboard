import { cachedFetch } from './cache.js';

const COINS = [
  'bitcoin', 'ethereum', 'binancecoin', 'solana', 'ripple',
  'avalanche-2', 'dogecoin', 'polkadot', 'chainlink', 'cardano',
];

export async function getCrypto(vsCurrency = 'usd') {
  const key = 'crypto:' + vsCurrency;
  const { data, stale, fetchedAt } = await cachedFetch(key, 20, async () => {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${vsCurrency}&ids=${COINS.join(',')}&order=market_cap_desc&price_change_percentage=24h`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
    const json = await r.json();
    return json.map(c => ({
      id: c.id,
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      price: c.current_price,
      change24hPct: c.price_change_percentage_24h,
      marketCap: c.market_cap,
      rank: c.market_cap_rank,
    }));
  });
  return { items: data, stale, fetchedAt };
}
