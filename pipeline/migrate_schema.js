#!/usr/bin/env node
// pipeline/migrate_schema.js
//
// One-time migration: convert scored_shows.json from flat scores/productionScore
// to the episode-history schema (showLevelProduction + episodeScores[]).
//
// Creates a backup at scored_shows.json.bak before writing.
// Safe to re-run: already-migrated shows (has episodeScores) are skipped.

'use strict';

const fs   = require('fs');
const path = require('path');

const SCORED_PATH  = path.join(__dirname, 'scored_shows.json');
const BACKUP_PATH  = SCORED_PATH + '.bak';

function deriveEpisodeId(show) {
  const pubDate = show.latestEpisode?.pubDate;
  const dateStr = pubDate ? pubDate.slice(0, 10).replace(/-/g, '') : 'unknown';
  return `ep_${dateStr}_${show.feedId}`;
}

function getOldScore(val) {
  return typeof val === 'object' ? (val?.score || 0) : (val || 0);
}

function migrateShow(show) {
  if (Array.isArray(show.episodeScores)) return show;  // already migrated

  const sc = show.scores || {};
  const ps = show.productionScore || null;
  const ep = show.latestEpisode || {};
  const episodeId = deriveEpisodeId(show);

  const episodeScore = {
    episodeId,
    episodeTitle: ep.title || null,
    pubDate:      ep.pubDate || null,
    pubDateUnix:  ep.pubDateUnix || null,
    audioUrl:     ep.audioUrl || null,
    durationSeconds: ep.durationSeconds || null,
    guid:         null,  // not available for pre-migration episodes
    contentScore: {
      bitrateQuality:  getOldScore(sc.quality),
      topicRelevance:  sc.relevance   || null,
      contentStructure: sc.structure  || null,
      clipAbility:     sc.clipability || null,
      totalScore:      sc.totalScore  || 0,
      tier:            sc.tier        || 'below_threshold',
      algorithmVersion: sc.algorithmVersion || 'v1.2',
      scoredAt:        sc.scoredAt    || null,
    },
    productionAudio: ps ? {
      loudnessCompliance: ps.loudnessCompliance  ?? null,
      recordingQuality:   ps.recordingQuality    ?? null,
      audioTechnicalScore: ps.audioTechnical     ?? null,
      pacingFlow:         ps.pacingFlow          ?? null,
      slicesFetched:      ps.slicesFetched       ?? null,
      algorithmVersion:   ps.algorithmVersion    || null,
      scoredAt:           ps.scoredAt            || null,
    } : null,
    appleEpisodeId:  null,
    appleEpisodeUrl: null,
  };

  const showLevelProduction = {
    consistency:         getOldScore(sc.consistency),
    vitality:            getOldScore(sc.vitality),
    metadataCompleteness: ps?.metadataComplete   ?? null,
    feedCompliance:      ps?.feedCompliance      ?? null,
    computedAt:          ps?.scoredAt || sc.scoredAt || new Date().toISOString(),
  };

  const migrated = {
    feedId:           show.feedId,
    feedTitle:        show.feedTitle,
    feedUrl:          show.feedUrl,
    imageUrl:         show.imageUrl,
    author:           show.author,
    description:      show.description,
    discoveryCats:    show.discoveryCats    || null,
    itunesId:         show.itunesId         || null,
    latestEpisodeId:  episodeId,
    showLevelProduction,
    episodeScores:    [episodeScore],
    // Runtime fields kept for pipeline use
    latestEpisode:    show.latestEpisode,
    clip:             show.clip,
    transcript:       show.transcript,
    publishHistory:   show.publishHistory,
    card:             show.card,
    _refreshMeta:     show._refreshMeta,
  };

  return migrated;
}

function main() {
  if (!fs.existsSync(SCORED_PATH)) {
    console.error('scored_shows.json not found.');
    process.exit(1);
  }

  const data  = JSON.parse(fs.readFileSync(SCORED_PATH, 'utf8'));
  const shows = data.scored;

  const alreadyMigrated = shows.filter(s => Array.isArray(s.episodeScores)).length;
  const toMigrate       = shows.length - alreadyMigrated;

  if (toMigrate === 0) {
    console.log(`All ${shows.length} shows already on new schema. Nothing to do.`);
    return;
  }

  // Backup before writing
  fs.copyFileSync(SCORED_PATH, BACKUP_PATH);
  console.log(`Backup → scored_shows.json.bak`);

  const migrated = shows.map(migrateShow);

  const out = {
    ...data,
    scored:    migrated,
    migratedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SCORED_PATH, JSON.stringify(out, null, 2));

  console.log(`Migrated ${toMigrate} shows (${alreadyMigrated} already done).`);
  console.log(`Run node 04_assemble.js to regenerate data/shows.json.`);
}

main();
