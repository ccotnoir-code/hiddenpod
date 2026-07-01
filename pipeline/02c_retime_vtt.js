#!/usr/bin/env node
// pipeline/02c_retime_vtt.js
//
// Re-ingests only the VTT and SRT shows to get accurate clip timestamps.
// Patches ingested_shows.json and scored_shows.json in place (clip timing only).
// Does NOT re-run LLM scoring. Run 04_assemble.js afterward to update shows.json.
//
// Usage:
//   node 02c_retime_vtt.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { sleep } = require('./utils/podcast_index');
const { fetchTranscript, parseSRTWithTimestamps, parseVTTWithTimestamps } = require('./utils/transcript_parser');

const CLIP_WORDS = 110;

function stripHtml(html) {
  return html
    .replace(/<cite>[^<]*<\/cite>/gi, '')
    .replace(/<time>[^<]*<\/time>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\s{2,}/g, ' ').trim();
}

function wordIndexToSeconds(wordIdx, totalWords, durationSeconds) {
  if (!totalWords || !durationSeconds) return 300;
  return Math.round((wordIdx / totalWords) * durationSeconds);
}

function findClipWindow(plainText, durationSeconds) {
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

async function retimeShow(show) {
  const type = show.transcript.type;
  if (type !== 'text/vtt' && type !== 'application/srt') return null; // skip non-VTT/SRT

  let rawText;
  try {
    rawText = await fetchTranscript(show.transcript.url);
  } catch (e) {
    console.error(`  FETCH FAILED: ${show.feedTitle} — ${e.message}`);
    return null;
  }

  const looksHtml = /<[a-z][\s\S]*>/i.test(rawText.slice(0, 200));
  const plainText = looksHtml ? stripHtml(rawText) : rawText;
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;

  const dur  = show.latestEpisode.durationSeconds || 1800;
  const clip = findClipWindow(plainText, dur);

  // Extract real timestamps from VTT/SRT
  let clipStartSec = wordIndexToSeconds(clip.startWord, wordCount, dur);
  try {
    const cues = type === 'text/vtt'
      ? parseVTTWithTimestamps(rawText)
      : parseSRTWithTimestamps(rawText);
    if (cues.length > 0) {
      let wordIdx = 0;
      for (const cue of cues) {
        const cueWords = cue.text.split(/\s+/).filter(Boolean);
        if (wordIdx + cueWords.length > clip.startWord) {
          clipStartSec = Math.round(cue.startSeconds);
          break;
        }
        wordIdx += cueWords.length;
      }
    }
  } catch (e) {
    console.error(`  TIMESTAMP PARSE FAILED: ${show.feedTitle} — ${e.message}`);
  }

  const clipDurSec = Math.round((CLIP_WORDS / wordCount) * dur);
  const clampedDur = Math.min(Math.max(clipDurSec, 25), 55);

  return { clipStartSec, clampedDur, clipText: clip.text };
}

async function main() {
  console.log('=== HiddenPod — VTT Re-timing (Step 2c) ===\n');

  const ingestPath = path.join(__dirname, 'ingested_shows.json');
  const scoredPath = path.join(__dirname, 'scored_shows.json');

  if (!fs.existsSync(ingestPath)) { console.error('Run 02_ingest.js first.'); process.exit(1); }

  const ingestData = JSON.parse(fs.readFileSync(ingestPath, 'utf8'));
  const scoredData = fs.existsSync(scoredPath) ? JSON.parse(fs.readFileSync(scoredPath, 'utf8')) : null;

  const vttShows = ingestData.ingested.filter(s =>
    s.transcript.type === 'text/vtt' || s.transcript.type === 'application/srt'
  );
  console.log(`Found ${vttShows.length} VTT/SRT shows to retime.\n`);

  let updated = 0;
  for (let i = 0; i < vttShows.length; i++) {
    const show = vttShows[i];
    const result = await retimeShow(show);
    if (!result) {
      process.stdout.write(`  ${i+1}/${vttShows.length} — SKIP ${show.feedTitle.slice(0,40)}\n`);
      continue;
    }

    const oldStart = show.clip.startSeconds;
    // Patch ingested_shows.json in memory
    const ingestIdx = ingestData.ingested.findIndex(s => s.feedId === show.feedId);
    if (ingestIdx >= 0) {
      ingestData.ingested[ingestIdx].clip.startSeconds    = result.clipStartSec;
      ingestData.ingested[ingestIdx].clip.durationSeconds = result.clampedDur;
      ingestData.ingested[ingestIdx].clip.text            = result.clipText;
    }

    // Patch scored_shows.json in memory if it exists
    if (scoredData) {
      const scoredIdx = scoredData.scored.findIndex(s => s.feedId === show.feedId);
      if (scoredIdx >= 0) {
        scoredData.scored[scoredIdx].clip.startSeconds    = result.clipStartSec;
        scoredData.scored[scoredIdx].clip.durationSeconds = result.clampedDur;
        scoredData.scored[scoredIdx].clip.text            = result.clipText;
      }
    }

    updated++;
    process.stdout.write(`  ${i+1}/${vttShows.length} — ${oldStart}s → ${result.clipStartSec}s | ${show.feedTitle.slice(0,40)}\n`);
    await sleep(200);
  }

  fs.writeFileSync(ingestPath, JSON.stringify(ingestData, null, 2));
  if (scoredData) fs.writeFileSync(scoredPath, JSON.stringify(scoredData, null, 2));

  console.log(`\nRetimed ${updated}/${vttShows.length} VTT/SRT shows.`);
  console.log('Run 04_assemble.js to update data/shows.json.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
