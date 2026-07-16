#!/usr/bin/env node
// pipeline/backfill_apple_links.js
//
// One-time backfill: look up itunesId and Apple episode links for all existing
// shows in scored_shows.json that don't already have them.
//
// Existing episodeScores[0] entries were migrated with guid: null, so guid-based
// exact matching isn't available. Falls back to date-within-48h + title-Jaccard≥0.3.
//
// Rate strategy: 500ms between iTunes calls, 1s between show batches.
// Expected runtime: ~3-5 minutes for 198 shows.
//
// Usage:
//   node backfill_apple_links.js [--dry-run] [--feed-id ID]

'use strict';

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

const SCORED_PATH = path.join(__dirname, 'scored_shows.json');
const SCORED_TMP  = SCORED_PATH + '.tmp';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    let body = '';
    const req = lib.get(url, { headers: { 'User-Agent': 'HiddenPodPipeline/1.0' } }, (res) => {
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function titleSimilarity(a, b) {
  const wa = new Set(a.split(/\W+/).filter(Boolean));
  const wb = new Set(b.split(/\W+/).filter(Boolean));
  if (wa.size === 0 && wb.size === 0) return 1;
  const intersection = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}

async function lookupItunesId(feedTitle) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(feedTitle)}&media=podcast&limit=5`;
    const body = await httpGet(url);
    const results = JSON.parse(body).results || [];
    const titleLow = feedTitle.toLowerCase();
    for (const r of results) {
      if ((r.collectionName || '').toLowerCase() === titleLow) return r.collectionId;
    }
    if (results.length > 0) {
      const sim = titleSimilarity(titleLow, (results[0].collectionName || '').toLowerCase());
      if (sim >= 0.7) return results[0].collectionId;
    }
    return null;
  } catch (_) { return null; }
}

async function matchAppleEpisode(itunesId, guid, pubDateUnix, episodeTitle) {
  try {
    const url = `https://itunes.apple.com/lookup?id=${itunesId}&entity=podcastEpisode&limit=200`;
    const body = await httpGet(url);
    const episodes = JSON.parse(body).results.filter(r => r.kind === 'podcast-episode');

    // Primary: exact RSS guid (only works if guid was stored)
    if (guid) {
      const exact = episodes.find(e => e.episodeGuid === guid);
      if (exact) {
        return { trackId: exact.trackId, url: exact.trackViewUrl.replace('&uo=4', ''), method: 'guid' };
      }
    }

    // Fallback: date within 48h AND title Jaccard ≥ 0.3
    if (!pubDateUnix) return null;
    const titleLow = (episodeTitle || '').toLowerCase();
    for (const e of episodes) {
      const epUnix = Math.floor(new Date(e.releaseDate).getTime() / 1000);
      if (Math.abs(epUnix - pubDateUnix) <= 172800) {
        const sim = titleSimilarity((e.trackName || '').toLowerCase(), titleLow);
        if (sim >= 0.3) {
          return { trackId: e.trackId, url: e.trackViewUrl.replace('&uo=4', ''), method: `date+title(${sim.toFixed(2)})` };
        }
      }
    }
    return null;
  } catch (_) { return null; }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun  = process.argv.includes('--dry-run');
  const feedArg = process.argv.indexOf('--feed-id');
  const feedId  = feedArg !== -1 ? parseInt(process.argv[feedArg + 1]) : null;

  if (!fs.existsSync(SCORED_PATH)) {
    console.error('scored_shows.json not found.');
    process.exit(1);
  }

  const data  = JSON.parse(fs.readFileSync(SCORED_PATH, 'utf8'));
  let shows   = data.scored;

  if (feedId) {
    shows = shows.filter(s => s.feedId === feedId);
    if (!shows.length) { console.error(`feedId ${feedId} not found.`); process.exit(1); }
  }

  const needsId    = shows.filter(s => !s.itunesId).length;
  const needsLink  = shows.filter(s => !(s.episodeScores || [])[0]?.appleEpisodeUrl).length;
  console.log(`=== HiddenPod — Apple Backfill ===`);
  console.log(`Pool: ${shows.length} shows | need itunesId: ${needsId} | need apple link: ${needsLink}`);
  if (dryRun) console.log('DRY RUN — no writes\n');
  else console.log();

  const counts = { itunesFound: 0, itunesMissed: 0, linkFound: 0, linkMissed: 0, skipped: 0 };

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    const ep0  = (show.episodeScores || [])[0];
    const line = `[${i+1}/${shows.length}] ${show.feedTitle.slice(0, 45).padEnd(46)}`;

    // Step 1: itunesId — resolve locally so Step 2 can use it even in dry-run
    let resolvedItunesId = show.itunesId;
    if (!resolvedItunesId) {
      resolvedItunesId = await lookupItunesId(show.feedTitle);
      await sleep(500);
      if (resolvedItunesId) {
        if (!dryRun) show.itunesId = resolvedItunesId;
        counts.itunesFound++;
        process.stdout.write(`${line} itunesId=${resolvedItunesId}`);
      } else {
        counts.itunesMissed++;
        process.stdout.write(`${line} itunesId=null`);
      }
    } else {
      process.stdout.write(`${line} itunesId=${resolvedItunesId}(existing)`);
    }

    // Step 2: Apple episode link
    const itunesId = resolvedItunesId;
    if (!ep0) {
      process.stdout.write(' | no episodeScores\n');
      counts.skipped++;
      continue;
    }

    if (ep0.appleEpisodeUrl) {
      process.stdout.write(' | link=existing\n');
      counts.skipped++;
      continue;
    }

    if (!itunesId) {
      process.stdout.write(' | link=skip(no itunesId)\n');
      counts.linkMissed++;
      continue;
    }

    const match = await matchAppleEpisode(itunesId, ep0.guid, ep0.pubDateUnix, ep0.episodeTitle);
    await sleep(500);

    if (match) {
      if (!dryRun) {
        ep0.appleEpisodeId  = match.trackId;
        ep0.appleEpisodeUrl = match.url;
      }
      counts.linkFound++;
      process.stdout.write(` | link=${match.method} ✓\n`);
    } else {
      counts.linkMissed++;
      process.stdout.write(' | link=no_match\n');
    }

    // Gentle pacing between shows
    if (i < shows.length - 1) await sleep(200);
  }

  console.log(`\n=== BACKFILL RESULTS ===`);
  console.log(`  itunesId found:     ${counts.itunesFound}`);
  console.log(`  itunesId missed:    ${counts.itunesMissed}`);
  console.log(`  Apple link found:   ${counts.linkFound}`);
  console.log(`  Apple link missed:  ${counts.linkMissed}`);
  console.log(`  Skipped:            ${counts.skipped}`);

  if (!dryRun) {
    fs.writeFileSync(SCORED_TMP, JSON.stringify(data, null, 2));
    fs.renameSync(SCORED_TMP, SCORED_PATH);
    console.log('\nscored_shows.json updated. Run node 04_assemble.js next.');
  }
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
