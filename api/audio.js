const RSS_FEEDS = {
  1:  'https://feeds.acast.com/public/shows/lawfare',
  2:  'https://feeds.acast.com/public/shows/all-politics-is-local',
  3:  'https://podcasts.files.bbci.co.uk/p02nq0gn.rss',
  4:  null,
  5:  'https://rss.art19.com/sway',
  6:  null,
  7:  null,
  8:  'https://feeds.simplecast.com/EmVW7VGp',
  9:  null,
  10: null,
  11: 'https://www.revealnews.org/feed/podcast/',
  12: 'https://feeds.npr.org/510318/podcast.xml',
  13: 'https://feeds.buzzsprout.com/208666.rss',
  14: null,
  15: 'https://www.nhpr.org/podcast/document/rss.xml',
  16: 'https://feeds.simplecast.com/54nAGcIl',
};

const cache = {};
const CACHE_TTL = 3600 * 1000;

async function getAudioUrl(showId) {
  const now = Date.now();
  if (cache[showId] && (now - cache[showId].ts) < CACHE_TTL) {
    return cache[showId].url;
  }

  const feedUrl = RSS_FEEDS[showId];
  if (!feedUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HiddenPod/1.0 (podcast discovery prototype)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    });

    if (!res.ok) return null;
    const text = await res.text();

    const match = text.match(/<enclosure[^>]+url="([^"]+)"/);
    if (!match) return null;

    const url = match[1];
    cache[showId] = { url, ts: now };
    return url;

  } catch (e) {
    console.error(`Feed fetch error for show ${showId}:`, e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
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
    console.error('Handler error:', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
