#!/usr/bin/env node
// pipeline/02f_retime_remaining.js
//
// Third and final retime pass — upgrades Buzzsprout and Omny shows from
// proportional word-time estimation to exact VTT cue timestamps.
//
// After 02d_retime_spreaker.js fixed 64 Spreaker shows, 41 non-Spreaker
// "text/html" shows remained on proportional estimation. Probing their
// transcript hosts revealed:
//   Buzzsprout (17): /transcript → /transcript.vtt (VTT available)
//   Omny (13):       ?format=TextWithTimestamps → ?format=WebVTT (VTT available)
//   Transistor (7):  .txt only, .vtt returns 404 — no fix possible
//   Captivate/other (4): transcript URLs return 404 — no fix possible
//
// Usage:
//   node 02f_retime_remaining.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { sleep } = require('./utils/podcast_index');
const { fetchTranscript, parseVTTWithTimestamps } = require('./utils/transcript_parser');

const INGEST_PATH = path.join(__dirname, 'ingested_shows.json');
const SCORED_PATH = path.join(__dirname, 'scored_shows.json');

// ── VTT URL derivation ────────────────────────────────────────────────────────

function getVttUrl(transcriptUrl) {
  if (!transcriptUrl) return null;

  // Buzzsprout: /transcript → /transcript.vtt
  if (transcriptUrl.includes('buzzsprout.com') && transcriptUrl.endsWith('/transcript')) {
    return transcriptUrl + '.vtt';
  }

  // Omny: ?format=TextWithTimestamps → ?format=WebVTT (fresh t= timestamp)
  if (transcriptUrl.includes('omny.fm') && transcriptUrl.includes('format=TextWithTimestamps')) {
    return transcriptUrl.replace('format=TextWithTimestamps', 'format=WebVTT');
  }

  return null; // No VTT upgrade available for this host
}

// ── Resolve clip start by matching clip text against VTT cues ────────────────
//
// clip.startWord is not persisted in the pipeline intermediates, so we can't
// do a word-index lookup. Instead, search for the first N words of clip.text
// inside the cue sequence — these come from the same transcript, so they match.

function resolveStartFromCues(cues, clipText) {
  if (!clipText) return null;

  // Normalize a word for comparison: lowercase, strip non-alphanumeric
  const norm = w => w.toLowerCase().replace(/[^a-z0-9]/g, '');

  const needleWords = clipText.trim().split(/\s+/).slice(0, 8).map(norm).filter(Boolean);
  if (needleWords.length < 3) return null;

  // Build a flat list of {word, startSeconds} from all cues
  const allWords = [];
  for (const cue of cues) {
    const cueWords = cue.text.split(/\s+/).filter(Boolean);
    for (const w of cueWords) {
      allWords.push({ word: norm(w), startSeconds: cue.startSeconds });
    }
  }

  // Sliding window: find first position where needle words match
  const n = needleWords.length;
  for (let i = 0; i <= allWords.length - n; i++) {
    let matches = 0;
    for (let j = 0; j < n; j++) {
      if (allWords[i + j].word === needleWords[j]) matches++;
    }
    // Require ≥6 of 8 words to match (allows minor transcription differences)
    if (matches >= Math.min(6, n)) {
      return Math.round(allWords[i].startSeconds);
    }
  }

  return null; // clip text not found in cue sequence
}

// ── Per-show retiming ─────────────────────────────────────────────────────────

async function retimeShow(ingestShow, scoredShow) {
  // Always derive the VTT URL from scoredShow — ingested_shows.json may have
  // been partially patched by a prior run and its URLs aren't reliable.
  const txUrl = scoredShow.transcript?.url;
  const vttUrl = getVttUrl(txUrl);

  if (!vttUrl) return { status: 'no_vtt_available' };

  let rawVtt;
  try {
    rawVtt = await fetchTranscript(vttUrl);
  } catch (e) {
    return { status: 'fetch_failed', error: e.message };
  }

  if (!rawVtt || !rawVtt.includes('WEBVTT')) {
    return { status: 'not_vtt', preview: rawVtt?.slice(0, 60) };
  }

  let cues;
  try {
    cues = parseVTTWithTimestamps(rawVtt);
  } catch (e) {
    return { status: 'parse_failed', error: e.message };
  }

  if (!cues || cues.length === 0) {
    return { status: 'no_cues' };
  }

  // Match clip text against cue sequence to find the right timestamp
  const clipText = scoredShow.clip?.text || ingestShow.clip?.text || '';
  const resolved = resolveStartFromCues(cues, clipText);

  if (resolved === null) {
    return { status: 'clip_text_not_found_in_cues', cueCount: cues.length };
  }

  // Sanity check: reject if resolved timestamp exceeds episode duration.
  // This catches cases where the transcript VTT belongs to a different (longer)
  // episode than the audio URL — the timestamps would be out of range.
  const dur = scoredShow.latestEpisode?.durationSeconds || 0;
  if (dur > 0 && resolved > dur) {
    return { status: 'timestamp_exceeds_duration', resolved, dur };
  }

  const oldSeconds = scoredShow.clip?.startSeconds ?? '?';

  // Patch both stores
  if (ingestShow.transcript) {
    ingestShow.transcript.url  = vttUrl;
    ingestShow.transcript.type = 'text/vtt';
  }
  if (ingestShow.clip) ingestShow.clip.startSeconds = resolved;

  if (scoredShow.transcript) {
    scoredShow.transcript.url  = vttUrl;
    scoredShow.transcript.type = 'text/vtt';
  }
  if (scoredShow.clip) scoredShow.clip.startSeconds = resolved;

  return { status: 'retimed', oldSeconds, newSeconds: resolved, cueCount: cues.length, vttUrl };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== HiddenPod — Retime Buzzsprout + Omny (Step 2f) ===\n');

  const ingestData = JSON.parse(fs.readFileSync(INGEST_PATH, 'utf8'));
  const scoredData = JSON.parse(fs.readFileSync(SCORED_PATH, 'utf8'));

  // Index ingested shows by feedId
  const ingestMap = {};
  ingestData.ingested.forEach((s, i) => { ingestMap[s.feedId] = i; });

  // Identify candidate shows: text/html transcript type AND a supported host URL
  const candidates = scoredData.scored.filter(s => {
    const url = s.transcript?.url || '';
    return getVttUrl(url) !== null;
  });

  console.log(`Candidates: ${candidates.length} shows (Buzzsprout/Omny with text/html type)\n`);

  const counts = { retimed: 0, no_vtt_available: 0, fetch_failed: 0, other: 0 };

  for (let i = 0; i < candidates.length; i++) {
    const scored = candidates[i];
    const ingestIdx = ingestMap[scored.feedId];
    const ingested  = ingestIdx !== undefined ? ingestData.ingested[ingestIdx] : scored;

    const result = await retimeShow(ingested, scored);

    if (result.status === 'retimed') {
      counts.retimed++;
      console.log(`  ✓ ${result.oldSeconds}s→${result.newSeconds}s (${result.cueCount} cues) | ${scored.feedTitle.slice(0, 45)}`);
    } else if (result.status === 'no_vtt_available') {
      counts.no_vtt_available++;
      process.stdout.write(`  - no VTT: ${scored.feedTitle.slice(0, 50)}\n`);
    } else {
      counts.other++;
      console.log(`  ✗ ${result.status}${result.error ? ': ' + result.error.slice(0, 50) : ''} | ${scored.feedTitle.slice(0, 40)}`);
    }

    await sleep(200);
  }

  fs.writeFileSync(INGEST_PATH, JSON.stringify(ingestData, null, 2));
  fs.writeFileSync(SCORED_PATH, JSON.stringify(scoredData, null, 2));

  console.log(`\n=== RESULTS ===`);
  console.log(`  Retimed:          ${counts.retimed}`);
  console.log(`  No VTT available: ${counts.no_vtt_available}`);
  console.log(`  Failed:           ${counts.other}`);
  console.log('\nRun 04_assemble.js to update data/shows.json.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
