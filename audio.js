const fetch = require('node-fetch');

// RSS feeds for all 16 shows
const RSS_FEEDS = {
  1:  'https://feeds.acast.com/public/shows/lawfare',
  2:  'https://feeds.buzzsprout.com/1906302.rss',
  3:  'https://podcasts.files.bbci.co.uk/p02nq0gn.rss',
  4:  'https://feeds.buzzsprout.com/1879213.rss',
  5:  'https://feeds.simplecast.com/uP-3JNpd',
  6:  'https://feeds.buzzsprout.com/1056213.rss',
  7:  'https://feeds.acast.com/public/shows/in-the-dark',
  8:  'https://feeds.wnyc.org/radiolab',
  9:  'https://feeds.buzzsprout.com/1538936.rss',
  10: 'https://feeds.simplecast.com/E9S5H3FM',
  11: 'https://feeds.publicradio.org/public_feeds/reveal/rss/rss',
  12: 'https://feeds.npr.org/910369609/podcast.xml',
  13: 'https://feeds.buzzsprout.com/208666.rss',
  14: 'https://feeds.simplecast.com/0yJSBwD4',
  15: 'https://feeds.feedburner.com/nhpr-document',
  16: 'https://feeds.simplecast.com/54nAGcIl',
};

// Cache to avoid refetching on every request
const cache = {};
const CACHE_TTL = 3600 * 1000; // 1 hour

async function getAudioUrl(showId) {
  const now = Date.now();
  if (cache[showId] && (now - cache[showId].ts) < CACHE_TTL) {
    return cache[showId].url;
  }

  const feedUrl = RSS_FEEDS[showId];
  if (!feedUrl) return null;

  try {
    const res = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'HiddenPod/1.0 (podcast discovery prototype)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      timeout: 8000
    });

    if (!res.ok) return null;
    const text = await res.text();

    // Extract first enclosure URL from RSS
    const match = text.match(/<enclosure[^>]+url="([^"]+)"/);
    if (!match) return null;

    const url = match[1];
    cache[showId] = { url, ts: now };
    return url;

  } catch (e) {
    console.error(`Feed fetch error for show ${showId}:`, e.message);
    return null;
  }
}

module.exports = async (req, res) => {
  // CORS headers — allow any origin for prototype
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const showId = parseInt(req.query.show, 10);
  if (!showId || showId < 1 || showId > 16) {
    return res.status(400).json({ error: 'Invalid show ID' });
  }

  try {
    const audioUrl = await getAudioUrl(showId);
    if (!audioUrl) {
      return res.status(404).json({ error: 'Audio URL not found' });
    }
    return res.status(200).json({ url: audioUrl });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
};
