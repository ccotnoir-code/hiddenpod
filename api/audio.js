const fs   = require('fs');
const path = require('path');

// Legacy RSS feeds for original hand-verified shows (fetched fresh each hour for URL freshness)
const RSS_FEEDS = {
  1:  'https://feeds.acast.com/public/shows/lawfare',
  3:  'https://podcasts.files.bbci.co.uk/p02nq0gn.rss',
  5:  'https://podcasts.files.bbci.co.uk/b006qnmr.rss',
  7:  'https://feeds.simplecast.com/l2i9YnTd',
  12: 'https://feeds.simplecast.com/82FI35Px',
  13: 'https://feeds.buzzsprout.com/208666.rss',
  16: 'https://feeds.simplecast.com/54nAGcIl',
};

// Cache to avoid refetching on every request
const cache = {};
const CACHE_TTL = 3600 * 1000; // 1 hour

// Lookup table built from data/shows.json — populated on first request
let showsUrlMap = null;

function buildShowsUrlMap() {
  if (showsUrlMap) return showsUrlMap;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'shows.json'), 'utf8');
    const data = JSON.parse(raw);
    showsUrlMap = {};
    (data.shows || []).forEach(function(s) {
      if (s._meta && s._meta.audioUrl) {
        showsUrlMap[s.id] = s._meta.audioUrl;
      }
    });
  } catch (e) {
    console.error('shows.json load error:', e.message);
    showsUrlMap = {};
  }
  return showsUrlMap;
}

async function getAudioUrlFromRss(showId) {
  const now = Date.now();
  if (cache[showId] && (now - cache[showId].ts) < CACHE_TTL) {
    return cache[showId].url;
  }

  const feedUrl = RSS_FEEDS[showId];
  if (!feedUrl) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'HiddenPod/1.0 (podcast discovery prototype)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const text = await res.text();

    let match = text.match(/<enclosure[^>]+url="([^"]+)"/i);
    if (!match) match = text.match(/<enclosure[^>]+url='([^']+)'/i);
    if (!match) match = text.match(/<media:content[^>]+url="([^"]+)"/i);
    if (!match) match = text.match(/<media:content[^>]+url='([^']+)'/i);
    if (!match) return null;

    const url = match[1].replace(/&amp;/g, '&');
    cache[showId] = { url, ts: now };
    return url;

  } catch (e) {
    console.error(`Feed fetch error for show ${showId}:`, e.message);
    return null;
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
  if (!showId || showId < 1) {
    return res.status(400).json({ error: 'Invalid show ID' });
  }

  try {
    // For legacy shows, fetch fresh URL from RSS
    if (RSS_FEEDS[showId]) {
      const audioUrl = await getAudioUrlFromRss(showId);
      if (audioUrl) return res.status(200).json({ url: audioUrl });
    }

    // For pipeline shows, serve audioUrl stored in shows.json
    const urlMap = buildShowsUrlMap();
    const audioUrl = urlMap[showId];
    if (audioUrl) return res.status(200).json({ url: audioUrl });

    return res.status(404).json({ error: 'Audio URL not found' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
};
