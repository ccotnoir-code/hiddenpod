#!/usr/bin/env node
// pipeline/02b_episode_history.js
//
// Optional enrichment: fetches last-10-episode dates from Podcast Index API
// to improve Consistency scoring. Run after 02_ingest.js when rate limit reset.
//
// Usage:
//   PODCASTINDEX_API_KEY=xxx PODCASTINDEX_API_SECRET=yyy node 02b_episode_history.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { piGet, sleep } = require('./utils/podcast_index');

const API_KEY    = process.env.PODCASTINDEX_API_KEY;
const API_SECRET = process.env.PODCASTINDEX_API_SECRET;
if (!API_KEY || !API_SECRET) { console.error('Set PODCASTINDEX_API_KEY + PODCASTINDEX_API_SECRET.'); process.exit(1); }

const api = (p, params) => piGet(API_KEY, API_SECRET, p, params);
const DELAY_PER_REQUEST = 1200; // 1.2s between requests — very conservative

async function main() {
  console.log('=== Episode History Enrichment (Step 2b) ===\n');

  const inPath = path.join(__dirname, 'ingested_shows.json');
  if (!fs.existsSync(inPath)) { console.error('Run 02_ingest.js first.'); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const shows = data.ingested;
  console.log(`Enriching ${shows.length} shows with last-10-episode dates...\n`);
  console.log('Rate: 1 request per 1.2s to avoid 429. This will take ~' + Math.ceil(shows.length * 1.2 / 60) + ' minutes.\n');

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    try {
      const epData = await api('/episodes/byfeedid', { id: show.feedId, max: 10 });
      const eps = epData.items || [];
      show.publishHistory = {
        last10EpisodeDates: eps.map(e => new Date(e.datePublished * 1000).toISOString().slice(0, 10))
      };
      if (eps[0]?.enclosureLength) {
        show.latestEpisode.enclosureBytes = eps[0].enclosureLength;
      }
    } catch (e) {
      process.stderr.write(`  WARN: ${show.feedTitle} — ${e.message}\n`);
      show.publishHistory = show.publishHistory || { last10EpisodeDates: [] };
    }

    process.stdout.write(`  ${i + 1}/${shows.length} — ${show.feedTitle}\r`);
    fs.writeFileSync(inPath, JSON.stringify({ ingested: shows, savedAt: new Date().toISOString() }, null, 2));
    if (i + 1 < shows.length) await sleep(DELAY_PER_REQUEST);
  }

  process.stdout.write('\n');
  console.log('\nDone. ingested_shows.json enriched with episode history.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
