#!/usr/bin/env node
// pipeline/01_discover.js
//
// Step 1: Query Podcast Index API for News/Politics shows that expose a
// publisher transcript via <podcast:transcript>. Reports eligible count and
// saves pipeline/eligible_shows.json for Step 2 (ingest).
//
// Usage:
//   cd pipeline && npm install
//   PODCASTINDEX_API_KEY=xxx PODCASTINDEX_API_SECRET=yyy node 01_discover.js

'use strict';

const fs = require('fs');
const path = require('path');
const { piGet, sleep } = require('./utils/podcast_index');

const API_KEY    = process.env.PODCASTINDEX_API_KEY;
const API_SECRET = process.env.PODCASTINDEX_API_SECRET;

// Podcast Index category IDs
// 55 = News, 59 = News > Politics, also check adjacent subcategories
const PRIMARY_CATEGORY_IDS   = [55, 59];
const FALLBACK_CATEGORY_IDS  = [99, 109, 131]; // Government, Society & Culture, History

if (!API_KEY || !API_SECRET) {
  console.error('ERROR: PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET must be set.');
  console.error('Get credentials free at https://api.podcastindex.org');
  process.exit(1);
}

const api = (path, params) => piGet(API_KEY, API_SECRET, path, params);

// Check a batch of feedIds concurrently for recent episodes with transcripts.
// Returns Map<feedId, result>
async function checkFeedsForTranscripts(feeds, { batchSize = 15, delayMs = 250 } = {}) {
  const results = new Map();

  for (let i = 0; i < feeds.length; i += batchSize) {
    const batch = feeds.slice(i, i + batchSize);

    await Promise.all(batch.map(async (feed) => {
      try {
        const data = await api('/episodes/byfeedid', { id: feed.id, max: 5 });
        const episodes = data.items || [];

        for (const ep of episodes) {
          const transcripts = ep.transcripts || [];
          const transcriptUrl = ep.transcriptUrl || '';

          if (transcripts.length > 0 || transcriptUrl) {
            const t = transcripts[0] || {};
            results.set(feed.id, {
              feedId:       feed.id,
              feedTitle:    feed.title,
              feedUrl:      feed.url,
              imageUrl:     feed.image || feed.artwork || '',
              author:       feed.author || '',
              description:  feed.description || '',
              link:         feed.link || '',
              hasTranscript: true,
              transcriptUrl:  t.url || transcriptUrl,
              transcriptType: (t.type || 'unknown').toLowerCase(),
              episodeId:      ep.id,
              episodeTitle:   ep.title,
              episodeAudioUrl: ep.enclosureUrl || '',
              episodeDuration: ep.duration || 0,
              episodePubDate:  ep.datePublished || 0,
            });
            return;
          }
        }
        results.set(feed.id, { feedId: feed.id, feedTitle: feed.title, hasTranscript: false });
      } catch (e) {
        results.set(feed.id, {
          feedId: feed.id, feedTitle: feed.title,
          hasTranscript: false, error: e.message
        });
      }
    }));

    const checked = Math.min(i + batchSize, feeds.length);
    process.stdout.write(`  ${checked}/${feeds.length} feeds checked...\r`);
    if (i + batchSize < feeds.length) await sleep(delayMs);
  }

  process.stdout.write('\n');
  return results;
}

async function fetchCategoryFeeds(categoryIds) {
  const feedMap = new Map();

  for (const catId of categoryIds) {
    process.stdout.write(`Fetching category ${catId}...`);
    try {
      const data = await api('/podcasts/bycategoryid', { id: catId, max: 1000, pretty: false });
      const feeds = data.feeds || [];
      process.stdout.write(` ${feeds.length} shows\n`);
      for (const f of feeds) {
        if (!feedMap.has(f.id)) feedMap.set(f.id, f);
      }
    } catch (e) {
      console.error(`\n  ERROR on category ${catId}: ${e.message}`);
    }
    await sleep(400);
  }

  return Array.from(feedMap.values());
}

async function main() {
  console.log('=== HiddenPod — Podcast Index Discovery (Step 1) ===\n');

  // 1. Fetch show lists from primary categories
  console.log('Primary categories (News=55, Politics=59):');
  const primaryFeeds = await fetchCategoryFeeds(PRIMARY_CATEGORY_IDS);
  console.log(`\nUnique shows in primary categories: ${primaryFeeds.length}`);

  // 2. Check each show for transcripts
  console.log('\nChecking recent episodes for publisher transcripts...');
  const primaryResults = await checkFeedsForTranscripts(primaryFeeds);
  const primaryEligible = Array.from(primaryResults.values()).filter(r => r.hasTranscript);

  console.log('\n=== PRIMARY CATEGORY RESULTS ===');
  console.log(`  Total checked:       ${primaryFeeds.length}`);
  console.log(`  With transcripts:    ${primaryEligible.length}`);

  let allEligible = primaryEligible;
  let usedFallback = false;

  // 3. If short, run fallback categories
  if (primaryEligible.length < 100) {
    console.log(`\n⚠ Only ${primaryEligible.length} eligible shows in primary categories.`);
    console.log('Running fallback categories (Government, Society & Culture, History)...');

    const fallbackFeeds = await fetchCategoryFeeds(FALLBACK_CATEGORY_IDS);
    // Exclude shows already checked
    const newFeeds = fallbackFeeds.filter(f => !primaryResults.has(f.id));
    console.log(`\nNew unique shows in fallback categories: ${newFeeds.length}`);

    const fallbackResults = await checkFeedsForTranscripts(newFeeds);
    const fallbackEligible = Array.from(fallbackResults.values()).filter(r => r.hasTranscript);

    console.log('\n=== FALLBACK CATEGORY RESULTS ===');
    console.log(`  Additional checked:   ${newFeeds.length}`);
    console.log(`  Additional eligible:  ${fallbackEligible.length}`);

    allEligible = [...primaryEligible, ...fallbackEligible];
    usedFallback = true;
  }

  // 4. Breakdown by transcript type
  const byType = {};
  for (const r of allEligible) {
    byType[r.transcriptType] = (byType[r.transcriptType] || 0) + 1;
  }

  console.log('\n=== FINAL SUMMARY ===');
  console.log(`Total eligible shows: ${allEligible.length}`);
  console.log(`Fallback used:        ${usedFallback ? 'yes' : 'no'}`);
  console.log('\nTranscript types:');
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
    console.log(`  ${type.padEnd(20)} ${count}`);
  });

  // 5. Sample
  console.log('\nFirst 20 eligible shows:');
  allEligible.slice(0, 20).forEach(r => {
    console.log(`  [${r.transcriptType}] ${r.feedTitle}`);
  });

  // 6. Recommendation
  if (allEligible.length >= 100) {
    console.log(`\n✓ Pool confirmed: ${allEligible.length} shows — proceed to Step 2 (ingest).`);
  } else if (allEligible.length >= 50) {
    console.log(`\n⚠ Pool size ${allEligible.length} — below 100 target. Consider widening further or proceeding with smaller set.`);
  } else {
    console.log(`\n✗ Pool size ${allEligible.length} — too small. Must widen categories. Do not proceed until resolved.`);
  }

  // 7. Write eligible_shows.json for Step 2
  const outPath = path.join(__dirname, 'eligible_shows.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt:    new Date().toISOString(),
    totalChecked:   primaryFeeds.length + (usedFallback ? 0 : 0),
    eligibleCount:  allEligible.length,
    usedFallback,
    transcriptTypes: byType,
    shows: allEligible
  }, null, 2));
  console.log(`\nEligible show list → pipeline/eligible_shows.json`);
}

main().catch(e => { console.error('\nFatal error:', e.message); process.exit(1); });
