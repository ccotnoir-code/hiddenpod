#!/usr/bin/env node
// pipeline/03b_patch_quality.js
//
// Fetches Content-Length via HTTP HEAD on each show's audio URL, updates
// latestEpisode.enclosureBytes in ingested_shows.json, then patches the
// quality score in scored_shows.json — no LLM calls, no API keys needed.
//
// Run 04_assemble.js afterward to update data/shows.json.
//
// Usage:
//   node 03b_patch_quality.js

'use strict';

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const { sleep } = require('./utils/podcast_index');

const INGEST_PATH = path.join(__dirname, 'ingested_shows.json');
const SCORED_PATH = path.join(__dirname, 'scored_shows.json');

function getContentLength(url, redirectsLeft = 6) {
  return new Promise((resolve) => {
    if (redirectsLeft <= 0) return resolve(null);
    let timedOut = false;
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method: 'HEAD', headers: { 'User-Agent': 'HiddenPodPipeline/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        // Resolve relative redirects
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(getContentLength(next, redirectsLeft - 1));
      }
      const cl = res.headers['content-length'];
      resolve(cl ? parseInt(cl, 10) : null);
      req.destroy();
    });
    req.setTimeout(8000, () => {
      timedOut = true;
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function scoreAudioQuality(enclosureBytes, durationSeconds) {
  if (!enclosureBytes || !durationSeconds) return 65;
  const bitrate = (enclosureBytes * 8) / durationSeconds;
  const kbps = bitrate / 1000;
  if (kbps >= 256) return Math.round(85 + Math.min(10, (kbps - 256) / 32));
  if (kbps >= 192) return Math.round(75 + (kbps - 192) / 6.4);
  if (kbps >= 128) return Math.round(60 + (kbps - 128) / 4);
  if (kbps >= 64)  return Math.round(40 + (kbps - 64) / 3.2);
  return Math.max(20, Math.round(kbps / 3));
}

async function main() {
  console.log('=== HiddenPod — Audio Quality Patch (Step 3b) ===\n');

  const ingestData = JSON.parse(fs.readFileSync(INGEST_PATH, 'utf8'));
  const scoredData = fs.existsSync(SCORED_PATH) ? JSON.parse(fs.readFileSync(SCORED_PATH, 'utf8')) : null;
  if (!scoredData) { console.error('Run 03_score.js first.'); process.exit(1); }

  // Build feedId → scored index map
  const scoredIdx = {};
  (scoredData.scored || []).forEach((s, i) => { scoredIdx[s.feedId] = i; });

  const shows = ingestData.ingested;
  console.log(`Fetching Content-Length for ${shows.length} audio URLs...\n`);

  let updated = 0, fallback = 0;

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    const audioUrl = show.latestEpisode && show.latestEpisode.audioUrl
      ? show.latestEpisode.audioUrl
      : (show._meta && show._meta.audioUrl ? show._meta.audioUrl : '');

    if (!audioUrl) {
      process.stdout.write(`  ${i+1}/${shows.length} — NO URL: ${show.feedTitle.slice(0,40)}\n`);
      fallback++;
      continue;
    }

    const bytes = await getContentLength(audioUrl);
    const dur   = show.latestEpisode && show.latestEpisode.durationSeconds ? show.latestEpisode.durationSeconds : 0;

    if (!bytes) {
      process.stdout.write(`  ${i+1}/${shows.length} — NO CL (fallback 65): ${show.feedTitle.slice(0,40)}\n`);
      fallback++;
      await sleep(100);
      continue;
    }

    // Patch ingested_shows.json
    ingestData.ingested[i].latestEpisode.enclosureBytes = bytes;

    // Patch scored_shows.json
    const si = scoredIdx[show.feedId];
    if (si !== undefined) {
      const newScore = scoreAudioQuality(bytes, dur);
      const cs = (scoredData.scored[si].episodeScores||[])[0]?.contentScore;
      if (!cs) {
        process.stdout.write(`  ${i+1}/${shows.length} — NO CONTENT SCORE: ${show.feedTitle.slice(0,35)}\n`);
        fallback++;
        continue;
      }
      const oldScore = cs.bitrateQuality || 65;
      cs.bitrateQuality = newScore;

      // Recompute totalScore from episodeScores + showLevelProduction fields
      const WEIGHTS = {quality:0.18, structure:0.20, relevance:0.22, clipability:0.16, consistency:0.16, vitality:0.08};
      const slp = scoredData.scored[si].showLevelProduction || {};
      const getW = (k) => {
        switch (k) {
          case 'quality':     return cs.bitrateQuality || 0;
          case 'structure':   return typeof cs.contentStructure === 'object' ? (cs.contentStructure.score||0) : (cs.contentStructure||0);
          case 'relevance':   return typeof cs.topicRelevance === 'object' ? (cs.topicRelevance.score||0) : (cs.topicRelevance||0);
          case 'clipability': return typeof cs.clipAbility === 'object' ? (cs.clipAbility.score||0) : (cs.clipAbility||0);
          case 'consistency': return slp.consistency || 0;
          case 'vitality':    return slp.vitality || 0;
          default: return 0;
        }
      };
      const newTotal = Math.round(Object.keys(WEIGHTS).reduce((t,k) => t + getW(k)*WEIGHTS[k], 0));
      cs.totalScore = newTotal;

      const kbps = Math.round((bytes * 8) / dur / 1000);
      process.stdout.write(`  ${i+1}/${shows.length} — ${kbps}kbps → quality ${oldScore}→${newScore} | ${show.feedTitle.slice(0,35)}\n`);
      updated++;
    }

    await sleep(120);

    // Checkpoint every 25
    if ((i+1) % 25 === 0) {
      fs.writeFileSync(INGEST_PATH, JSON.stringify(ingestData, null, 2));
      fs.writeFileSync(SCORED_PATH, JSON.stringify(scoredData, null, 2));
      process.stdout.write(`  [checkpoint saved at ${i+1}]\n`);
    }
  }

  fs.writeFileSync(INGEST_PATH, JSON.stringify(ingestData, null, 2));
  fs.writeFileSync(SCORED_PATH, JSON.stringify(scoredData, null, 2));

  console.log(`\nPatched quality scores: ${updated} shows`);
  console.log(`Fallback (65):          ${fallback} shows`);
  console.log('Run 04_assemble.js to update data/shows.json.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
