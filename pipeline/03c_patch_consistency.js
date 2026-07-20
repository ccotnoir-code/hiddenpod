#!/usr/bin/env node
// pipeline/03c_patch_consistency.js
//
// Recomputes Consistency scores from last10EpisodeDates populated by
// 02b_episode_history.js. Patches scored_shows.json in place — no LLM calls.
// Run 04_assemble.js afterward to update data/shows.json.
//
// Usage:
//   node 03c_patch_consistency.js

'use strict';

const fs   = require('fs');
const path = require('path');

const INGEST_PATH = path.join(__dirname, 'ingested_shows.json');
const SCORED_PATH = path.join(__dirname, 'scored_shows.json');
const WEIGHTS = {quality:0.18, structure:0.20, relevance:0.22, clipability:0.16, consistency:0.16, vitality:0.08};

function scoreConsistency(last10Dates) {
  if (!last10Dates || last10Dates.length < 2) return 50;

  const timestamps = last10Dates
    .map(d => new Date(d).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => b - a);

  if (timestamps.length < 2) return 50;

  const gaps = [];
  for (let i = 0; i + 1 < timestamps.length; i++) {
    gaps.push((timestamps[i] - timestamps[i + 1]) / (1000 * 60 * 60 * 24));
  }

  const daysOfWeek = timestamps.map(t => new Date(t).getDay());
  const weekendEps = daysOfWeek.filter(d => d === 0 || d === 6).length;
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap  = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const isWeekdayShow = weekendEps === 0 && timestamps.length >= 4 && medianGap < 2;

  const scoringGaps   = isWeekdayShow ? gaps.filter(g => g < 3) : gaps;
  const effectiveGaps = scoringGaps.length >= 2 ? scoringGaps : gaps;

  const mean     = effectiveGaps.reduce((s, g) => s + g, 0) / effectiveGaps.length;
  const variance = effectiveGaps.reduce((s, g) => s + Math.pow(g - mean, 2), 0) / effectiveGaps.length;
  const stddev   = Math.sqrt(variance);
  const cv       = mean > 0 ? stddev / mean : 0;

  return Math.max(10, Math.min(100, Math.round(100 - cv * 60)));
}

function main() {
  console.log('=== HiddenPod — Consistency Patch (Step 3c) ===\n');

  const ingestData = JSON.parse(fs.readFileSync(INGEST_PATH, 'utf8'));
  const scoredData = fs.existsSync(SCORED_PATH) ? JSON.parse(fs.readFileSync(SCORED_PATH, 'utf8')) : null;
  if (!scoredData) { console.error('Run 03_score.js first.'); process.exit(1); }

  // Build feedId → ingested index for episode history lookup
  const ingestMap = {};
  ingestData.ingested.forEach((s, i) => { ingestMap[s.feedId] = i; });

  let updated = 0, noHistory = 0;

  scoredData.scored.forEach((s, si) => {
    const ingestIdx = ingestMap[s.feedId];
    const dates = ingestIdx !== undefined
      ? (ingestData.ingested[ingestIdx].publishHistory?.last10EpisodeDates || [])
      : [];

    const slp = scoredData.scored[si].showLevelProduction || {};
    const oldScore = slp.consistency || 50;

    if (dates.length < 2) {
      noHistory++;
      process.stdout.write(`  NO HISTORY (50): ${s.feedTitle.slice(0, 45)}\n`);
      return;
    }

    const newScore = scoreConsistency(dates);
    if (scoredData.scored[si].showLevelProduction) {
      scoredData.scored[si].showLevelProduction.consistency = newScore;
    }

    // Recompute totalScore from episodeScores + showLevelProduction fields
    const cs = (scoredData.scored[si].episodeScores||[])[0]?.contentScore || {};
    const slpNow = scoredData.scored[si].showLevelProduction || {};
    const get = (k) => {
      switch (k) {
        case 'quality':     return cs.bitrateQuality || 0;
        case 'structure':   return typeof cs.contentStructure === 'object' ? (cs.contentStructure.score||0) : (cs.contentStructure||0);
        case 'relevance':   return typeof cs.topicRelevance === 'object' ? (cs.topicRelevance.score||0) : (cs.topicRelevance||0);
        case 'clipability': return typeof cs.clipAbility === 'object' ? (cs.clipAbility.score||0) : (cs.clipAbility||0);
        case 'consistency': return slpNow.consistency || 0;
        case 'vitality':    return slpNow.vitality || 0;
        default: return 0;
      }
    };
    const cs2 = (scoredData.scored[si].episodeScores||[])[0]?.contentScore;
    if (cs2) {
      cs2.totalScore = Math.round(Object.keys(WEIGHTS).reduce((t, k) => t + get(k) * WEIGHTS[k], 0));
    }

    updated++;
    process.stdout.write(`  ${oldScore}→${newScore} (${dates.length} eps) | ${s.feedTitle.slice(0, 45)}\n`);
  });

  fs.writeFileSync(SCORED_PATH, JSON.stringify(scoredData, null, 2));

  console.log(`\nPatched consistency scores: ${updated} shows`);
  console.log(`No history (kept 50):       ${noHistory} shows`);
  console.log('Run 04_assemble.js to update data/shows.json.');
}

main();
