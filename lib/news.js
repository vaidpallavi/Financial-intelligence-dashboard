import Parser from 'rss-parser';
import { cachedFetch } from './cache.js';

const parser = new Parser({ timeout: 8000 });

// Bloomberg discontinued its public RSS feeds, so it cannot be pulled this
// way without a paid Bloomberg Terminal/API license - that's a real
// constraint, not a shortcut. The feeds below are genuinely live and public.
const FEEDS = [
  { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', source: 'Economic Times Markets' },
  { url: 'https://www.livemint.com/rss/markets', source: 'LiveMint Markets' },
  { url: 'https://www.business-standard.com/rss/markets-106.rss', source: 'Business Standard' },
  { url: 'https://www.moneycontrol.com/rss/marketreports.xml', source: 'Moneycontrol' },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', source: 'WSJ Markets' },
];

export async function getNews() {
  const { data, stale, fetchedAt } = await cachedFetch('news:all', 120, async () => {
    const settled = await Promise.allSettled(
      FEEDS.map(async f => {
        const feed = await parser.parseURL(f.url);
        return (feed.items || []).slice(0, 5).map(item => ({
          title: item.title,
          link: item.link,
          pubDate: item.pubDate || item.isoDate || null,
          source: f.source,
          summary: (item.contentSnippet || item.summary || '').slice(0, 160),
        }));
      })
    );
    const items = settled.filter(s => s.status === 'fulfilled').flatMap(s => s.value);
    const failedSources = settled
      .map((s, i) => (s.status === 'rejected' ? FEEDS[i].source : null))
      .filter(Boolean);
    items.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
    if (items.length === 0) throw new Error('All news feeds failed: ' + failedSources.join(', '));
    return { items, failedSources };
  });
  return { ...data, stale, fetchedAt };
}
