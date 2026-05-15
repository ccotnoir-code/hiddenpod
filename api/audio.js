// Vercel serverless function — Node 18+ native fetch, no dependencies needed

const RSS_FEEDS = {
  1:  'https://feeds.acast.com/public/shows/lawfare',
  2:  'https://feeds.acast.com/public/shows/all-politics-is-local',
  3:  'https://podcasts.files.bbci.co.uk/p02nq0gn.rss',
  4:  'https://feeds.buzzsprout.com/1879213.rss',
  5:  'https://feeds.simplecast.com/l2i9YnTd',
  6:  'https://feeds.buzzsprout.com/1056213.rss',
  7:  'https://feeds.acast.com/public/shows/in-the-dark',
  8:  'https://feeds.simplecast.com/EmVW7VGp',
  9:  'https://feeds.buzzsprout.com/1538936.rss',
  10: 'https://feeds.simplecast.com/E9S5H3FM',
  11: 'https://feeds.publicradio.org/public_feeds/reveal/rss/rss',
  12: 'https://feeds.npr.org/510355/podcast.xml',
  13: 'https://feeds.buzzsprout.com/208666.rss',
  14: 'https://feeds.simplecast.com/0yJSBwD4',
  15: 'https://feeds.feedburner.com/nhpr-document',
  16: 'https://feeds.simplecast.com/Sl5CSM3S',
};

const cache = {};
const CACHE_MS = 60 * 60 * 1000;

async function getAudioUrl(showId) {
  const now = Date.now();
  if (cache[showId] && (now - cache[showId].ts) < CACHE_MS) {
    return cache[showId].url;
  }

  const feedUrl = RSS_FEEDS[showId];
  if (!feedUrl) throw new Error('Unknown show');

  const res = await fetch(feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HiddenPod/1.0; +https://hiddenpod.vercel.app)',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Feed returned ${res.status}`);

  const text = await res.text();
  let url = null;

  const m1 = text.match(/<enclosure[^>]+url="([^"]+\.mp3[^"]*)"/i);
  if (m1) url = m1[1];

  if (!url) {
    const m2 = text.match(/<enclosure[^>]+url='([^']+\.mp3[^']*)'/i);
    if (m2) url = m2[1];
  }
  if (!url) {
    const m3 = text.match(/<media:content[^>]+url="([^"]+\.mp3[^"]*)"/i);
    if (m3) url = m3[1];
  }
  if (!url) {
    const m4 = text.match(/<enclosure[^>]+url="([^"]+)"/i);
    if (m4) url = m4[1];
  }

  if (!url) throw new Error('No audio URL in feed');

  url = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  cache[showId] = { url, ts: now };
  return url;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, s-maxage=3600');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const showId = parseInt(req.query.show, 10);
  if (!showId || showId < 1 || showId > 16) {
    return res.status(400).json({ error: 'Invalid show ID' });
  }

  try {
    const url = await getAudioUrl(showId);
    return res.status(200).json({ url });
  } catch (e) {
    console.error('Show ' + showId + ' error:', e.message);
    return res.status(502).json({ error: e.message || 'Feed unavailable' });
  }
};
