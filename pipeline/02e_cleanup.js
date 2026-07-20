#!/usr/bin/env node
// pipeline/02e_cleanup.js
//
// Removes two categories of bad entries from ingested_shows.json + scored_shows.json:
//   1. Non-audio enclosures (vigilante.tv HLS/mp4 — unplayable in <audio>)
//   2. Duplicate audio URLs — same episode ingested under multiple feed IDs.
//      Keeps the entry with the higher totalScore (or feedId order if tied).
//
// Run 04_assemble.js afterward to update data/shows.json.

'use strict';

const fs   = require('fs');
const path = require('path');

const INGEST_PATH = path.join(__dirname, 'ingested_shows.json');
const SCORED_PATH = path.join(__dirname, 'scored_shows.json');

function isUnplayable(audioUrl) {
  if (!audioUrl) return true;
  // HLS fragmented video streams and raw mp4 files won't play in <audio>
  return audioUrl.includes('vigilante.tv') ||
         (audioUrl.endsWith('.mp4') && !audioUrl.includes('.mp3'));
}

function cleanShows(shows, scoreMap) {
  const removed = [];

  // Pass 1 — remove unplayable formats
  const playable = shows.filter(s => {
    const url = (s.latestEpisode && s.latestEpisode.audioUrl) || s.audioUrl || '';
    if (isUnplayable(url)) {
      removed.push({ reason: 'non_audio_format', feedId: s.feedId, title: s.feedTitle || s.show });
      return false;
    }
    return true;
  });

  // Pass 2 — deduplicate by audio URL, keeping highest score
  const urlSeen = {};
  const deduped = playable.filter(s => {
    const url = (s.latestEpisode && s.latestEpisode.audioUrl) || s.audioUrl || '';
    if (!url) return true; // no URL to dedupe on
    const totalScore = scoreMap[s.feedId] || 0;
    if (!urlSeen[url]) {
      urlSeen[url] = { feedId: s.feedId, score: totalScore };
      return true;
    }
    // Compare scores — keep whichever is higher
    if (totalScore > urlSeen[url].score) {
      // New entry beats the one we kept — swap
      removed.push({ reason: 'duplicate_url_lower_score', feedId: urlSeen[url].feedId, title: '(prior entry)' });
      urlSeen[url] = { feedId: s.feedId, score: totalScore };
      return true;
    }
    removed.push({ reason: 'duplicate_url_lower_score', feedId: s.feedId, title: s.feedTitle || s.show });
    return false;
  });

  // Second pass to remove swapped-out winners
  const keepIds = new Set(Object.values(urlSeen).map(v => v.feedId));
  const final = deduped.filter(s => {
    if (!keepIds.has(s.feedId)) {
      // was swapped out
      removed.push({ reason: 'duplicate_url_superseded', feedId: s.feedId, title: s.feedTitle || s.show });
      return false;
    }
    return true;
  });

  return { final, removed };
}

function main() {
  console.log('=== HiddenPod — Cleanup (Step 2e) ===\n');

  const ingestData = JSON.parse(fs.readFileSync(INGEST_PATH, 'utf8'));
  const scoredData = fs.existsSync(SCORED_PATH) ? JSON.parse(fs.readFileSync(SCORED_PATH, 'utf8')) : null;

  // Build score lookup from scored_shows.json
  const scoreMap = {};
  if (scoredData) {
    (scoredData.scored || []).forEach(s => {
      const totalScore = (s.episodeScores||[])[0]?.contentScore?.totalScore;
      if (totalScore != null) {
        scoreMap[s.feedId] = totalScore;
      }
    });
  }

  // Clean ingested_shows.json
  const ingestBefore = ingestData.ingested.length;
  const ingestResult = cleanShows(ingestData.ingested, scoreMap);
  ingestData.ingested = ingestResult.final;
  fs.writeFileSync(INGEST_PATH, JSON.stringify(ingestData, null, 2));
  console.log('ingested_shows.json: ' + ingestBefore + ' → ' + ingestResult.final.length + ' shows');

  // Clean scored_shows.json
  if (scoredData) {
    const scoredBefore = scoredData.scored.length;
    const scoredResult = cleanShows(scoredData.scored, scoreMap);
    scoredData.scored = scoredResult.final;
    fs.writeFileSync(SCORED_PATH, JSON.stringify(scoredData, null, 2));
    console.log('scored_shows.json:  ' + scoredBefore + ' → ' + scoredResult.final.length + ' shows');

    console.log('\nRemoved (' + scoredResult.removed.length + '):');
    scoredResult.removed.forEach(r => {
      console.log('  [' + r.reason + '] feedId=' + r.feedId + ' ' + r.title);
    });
  }

  console.log('\nRun 04_assemble.js to update data/shows.json.');
}

main();
