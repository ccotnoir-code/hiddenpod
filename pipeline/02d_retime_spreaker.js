#!/usr/bin/env node
// pipeline/02d_retime_spreaker.js
//
// Upgrades Spreaker .txt transcript URLs to .vtt, then re-times those clips
// using real cue timestamps. Patches ingested_shows.json + scored_shows.json.
// Run 04_assemble.js afterward to update data/shows.json.
//
// Usage:
//   node 02d_retime_spreaker.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { sleep } = require('./utils/podcast_index');
const { fetchTranscript, parseVTTWithTimestamps } = require('./utils/transcript_parser');

const CLIP_WORDS = 110;

function findClipWindow(plainText) {
  const words = plainText.trim().split(/\s+/);
  const total = words.length;
  if (total < CLIP_WORDS) return { text: words.join(' '), startWord: 0, endWord: total };

  const zoneStart = Math.floor(total * 0.20);
  const zoneEnd   = Math.floor(total * 0.65) - CLIP_WORDS;
  if (zoneEnd <= zoneStart) return { text: words.slice(0, CLIP_WORDS).join(' '), startWord: 0, endWord: CLIP_WORDS };

  let bestStart = zoneStart;
  let bestScore = -1;
  const step = Math.max(1, Math.floor((zoneEnd - zoneStart) / 20));

  for (let i = zoneStart; i < zoneEnd; i += step) {
    const chunk = words.slice(i, i + CLIP_WORDS).join(' ');
    const avgLen = chunk.split(/\s+/).reduce((s, w) => s + w.length, 0) / CLIP_WORDS;
    const questionBonus = (chunk.match(/\?/g) || []).length * 2;
    const score = avgLen + questionBonus;
    if (score > bestScore) { bestScore = score; bestStart = i; }
  }

  return {
    text:      words.slice(bestStart, bestStart + CLIP_WORDS).join(' '),
    startWord: bestStart,
    endWord:   bestStart + CLIP_WORDS
  };
}

function resolveStartFromCues(cues, startWord) {
  let wordIdx = 0;
  for (const cue of cues) {
    const cueWords = cue.text.split(/\s+/).filter(Boolean);
    if (wordIdx + cueWords.length > startWord) {
      return Math.round(cue.startSeconds);
    }
    wordIdx += cueWords.length;
  }
  return null;
}

async function retimeSpreaker(show) {
  const txtUrl = show.transcript.url;
  const vttUrl = txtUrl.replace(/\.txt$/, '.vtt');

  let rawVtt;
  try {
    rawVtt = await fetchTranscript(vttUrl);
  } catch (e) {
    return { status: 'fetch_failed', error: e.message };
  }

  if (!rawVtt.trimStart().startsWith('WEBVTT')) {
    return { status: 'not_vtt' };
  }

  let cues;
  try {
    cues = parseVTTWithTimestamps(rawVtt);
  } catch (e) {
    return { status: 'parse_failed', error: e.message };
  }

  if (!cues.length) return { status: 'no_cues' };

  // Rebuild plain text from cues (same words as .txt but verified against VTT)
  const plainText = cues.map(c => c.text).join(' ');
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 50) return { status: 'too_short' };

  const clip = findClipWindow(plainText);
  const resolvedStart = resolveStartFromCues(cues, clip.startWord);
  if (resolvedStart === null) return { status: 'no_cue_match' };

  const dur = show.latestEpisode.durationSeconds || 1800;
  const clipDurSec = Math.round((CLIP_WORDS / wordCount) * dur);
  const clampedDur = Math.min(Math.max(clipDurSec, 25), 55);

  return {
    status: 'ok',
    vttUrl,
    clipStartSec: resolvedStart,
    clampedDur,
    clipText: clip.text,
    wordCount,
  };
}

async function main() {
  console.log('=== HiddenPod — Spreaker VTT Upgrade (Step 2d) ===\n');

  const ingestPath = path.join(__dirname, 'ingested_shows.json');
  const scoredPath = path.join(__dirname, 'scored_shows.json');

  if (!fs.existsSync(ingestPath)) { console.error('Run 02_ingest.js first.'); process.exit(1); }

  const ingestData = JSON.parse(fs.readFileSync(ingestPath, 'utf8'));
  const scoredData = fs.existsSync(scoredPath) ? JSON.parse(fs.readFileSync(scoredPath, 'utf8')) : null;

  const spreaker = ingestData.ingested.filter(s =>
    s.transcript.url &&
    s.transcript.url.includes('transcription.spreaker.com') &&
    s.transcript.url.endsWith('.txt')
  );
  console.log(`Found ${spreaker.length} Spreaker .txt shows to upgrade.\n`);

  const stats = { ok: 0, skipped: 0 };

  for (let i = 0; i < spreaker.length; i++) {
    const show = spreaker[i];
    const result = await retimeSpreaker(show);

    const label = `${i+1}/${spreaker.length}`;
    const title = show.feedTitle.slice(0, 40);

    if (result.status !== 'ok') {
      process.stdout.write(`  ${label} — SKIP (${result.status}) ${title}\n`);
      stats.skipped++;
      await sleep(100);
      continue;
    }

    const oldStart = show.clip.startSeconds;

    // Patch ingested_shows.json
    const ingestIdx = ingestData.ingested.findIndex(s => s.feedId === show.feedId);
    if (ingestIdx >= 0) {
      ingestData.ingested[ingestIdx].transcript.url  = result.vttUrl;
      ingestData.ingested[ingestIdx].transcript.type = 'text/vtt';
      ingestData.ingested[ingestIdx].transcript.wordCount = result.wordCount;
      ingestData.ingested[ingestIdx].clip.startSeconds    = result.clipStartSec;
      ingestData.ingested[ingestIdx].clip.durationSeconds = result.clampedDur;
      ingestData.ingested[ingestIdx].clip.text            = result.clipText;
    }

    // Patch scored_shows.json
    if (scoredData) {
      const scoredIdx = scoredData.scored.findIndex(s => s.feedId === show.feedId);
      if (scoredIdx >= 0) {
        scoredData.scored[scoredIdx].clip.startSeconds    = result.clipStartSec;
        scoredData.scored[scoredIdx].clip.durationSeconds = result.clampedDur;
        scoredData.scored[scoredIdx].clip.text            = result.clipText;
      }
    }

    stats.ok++;
    process.stdout.write(`  ${label} — ${oldStart}s → ${result.clipStartSec}s | ${title}\n`);
    await sleep(150);

    // Checkpoint every 20 shows
    if (stats.ok % 20 === 0) {
      fs.writeFileSync(ingestPath, JSON.stringify(ingestData, null, 2));
      if (scoredData) fs.writeFileSync(scoredPath, JSON.stringify(scoredData, null, 2));
      process.stdout.write(`  [checkpoint saved]\n`);
    }
  }

  fs.writeFileSync(ingestPath, JSON.stringify(ingestData, null, 2));
  if (scoredData) fs.writeFileSync(scoredPath, JSON.stringify(scoredData, null, 2));

  console.log(`\nUpgraded ${stats.ok}/${spreaker.length} Spreaker shows to VTT timing.`);
  console.log(`Skipped:  ${stats.skipped}`);
  console.log('Run 04_assemble.js to update data/shows.json.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
