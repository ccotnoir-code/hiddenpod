#!/usr/bin/env node
// pipeline/02_ingest.js
//
// Step 2: Per-show ingestion — downloads & parses transcripts, extracts clip
// windows. Uses data already in eligible_shows.json where possible.
// A separate pass (02b_episode_history.js) fetches last-10-ep dates when
// the Podcast Index rate limit has reset.
//
// Usage:
//   node 02_ingest.js        (no API key needed — fetches transcripts only)

'use strict';

const fs   = require('fs');
const path = require('path');
const { sleep } = require('./utils/podcast_index');
const { fetchTranscript, toPlainText, extractWindow } = require('./utils/transcript_parser');

const CONCURRENCY  = 6;    // transcript fetches — no API rate limit
const BATCH_DELAY  = 100;  // ms between transcript batches
const MIN_WORDS    = 150;
const CLIP_WORDS   = 110;

// Prefer clean machine-readable formats over HTML
const FORMAT_RANK = { 'application/json': 0, 'text/vtt': 1, 'application/srt': 2, 'text/html': 3, 'unknown': 4 };
function rankFormat(type) { return FORMAT_RANK[type] ?? 5; }

// Rough English stopword density check
const EN_WORDS = new Set(['the','and','is','in','to','of','a','that','it','was','he','she','for','on','are','with','as','at','be','this','from','or','by','an','they','we','his','her','have','were','been','has','had','not','but','what','which','when','their','there','so','if','about','up','out','who','would','can','will','said','all','some','more','one','do','into','no','our','i','you','your','just','like','also','we\'re','i\'m']);
function isEnglish(text) {
  const words = text.toLowerCase().slice(0, 1200).split(/\s+/).filter(Boolean);
  if (words.length < 20) return false;
  const hits = words.filter(w => EN_WORDS.has(w)).length;
  return hits / words.length >= 0.06;
}

// Simple HTML-to-text stripping
function stripHtml(html) {
  return html
    .replace(/<cite>[^<]*<\/cite>/gi, '')
    .replace(/<time>[^<]*<\/time>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\s{2,}/g, ' ').trim();
}

// Estimate clip start (seconds) given word index in transcript
function wordIndexToSeconds(wordIdx, totalWords, durationSeconds) {
  if (!totalWords || !durationSeconds) return 300;
  return Math.round((wordIdx / totalWords) * durationSeconds);
}

// Find a good clip window in plain text
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

async function ingestShow(show) {
  // Fetch and parse transcript (direct HTTP — no API key needed)
  let rawText;
  try {
    rawText = await fetchTranscript(show.transcriptUrl);
  } catch (e) {
    return { ...show, skipped: 'transcript_fetch_failed', errorMsg: e.message };
  }

  const looksHtml = /<[a-z][\s\S]*>/i.test(rawText.slice(0, 200));
  const plainText = looksHtml ? stripHtml(rawText) : rawText;

  if (!isEnglish(plainText)) {
    return { ...show, skipped: 'non_english' };
  }

  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS) {
    return { ...show, skipped: 'too_short', wordCount };
  }

  const dur  = show.episodeDuration || 1800;
  const clip = findClipWindow(plainText, dur);
  const clipStartSec = wordIndexToSeconds(clip.startWord, wordCount, dur);
  const clipDurSec   = Math.round((CLIP_WORDS / wordCount) * dur);
  const clampedDur   = Math.min(Math.max(clipDurSec, 25), 55);
  const scoringWindow = extractWindow(plainText, clipStartSec, dur, 2000);

  return {
    feedId:       show.feedId,
    feedTitle:    show.feedTitle,
    feedUrl:      show.feedUrl,
    imageUrl:     show.imageUrl,
    author:       show.author,
    description:  show.description || '',

    latestEpisode: {
      title:           show.episodeTitle,
      audioUrl:        show.episodeAudioUrl,
      enclosureBytes:  0,  // not in eligible_shows — will estimate AQ score at 65
      pubDateUnix:     show.episodePubDate,
      pubDate:         show.episodePubDate ? new Date(show.episodePubDate * 1000).toISOString() : null,
      durationSeconds: show.episodeDuration || 0,
    },

    clip: {
      startSeconds:       clipStartSec,
      durationSeconds:    clampedDur,
      speechOffsetSeconds: 0,
      text:               clip.text,
    },

    transcript: {
      url:          show.transcriptUrl,
      type:         show.transcriptType,
      wordCount,
      scoringWindow,
    },

    // Placeholder — filled by 02b_episode_history.js if run
    publishHistory: { last10EpisodeDates: [] },
  };
}

async function main() {
  console.log('=== HiddenPod — Ingestion (Step 2) ===\n');

  const eligiblePath = path.join(__dirname, 'eligible_shows.json');
  if (!fs.existsSync(eligiblePath)) {
    console.error('Run 01_discover.js first.'); process.exit(1);
  }

  const eligible = JSON.parse(fs.readFileSync(eligiblePath, 'utf8'));
  const shows = eligible.shows.filter(s => s.hasTranscript);
  console.log(`Fetching transcripts for ${shows.length} shows (no API key required)...\n`);

  const ingested = [];
  const skipped  = [];
  const outPath  = path.join(__dirname, 'ingested_shows.json');

  for (let i = 0; i < shows.length; i += CONCURRENCY) {
    const batch   = shows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(s => ingestShow(s).catch(e => ({
      feedId: s.feedId, feedTitle: s.feedTitle, skipped: 'error', errorMsg: e.message
    }))));

    for (const r of results) {
      if (r.skipped) {
        skipped.push({ feedId: r.feedId, title: r.feedTitle, reason: r.skipped, error: r.errorMsg });
      } else {
        ingested.push(r);
      }
    }

    const done = Math.min(i + CONCURRENCY, shows.length);
    process.stdout.write(`  ${done}/${shows.length} (${ingested.length} ok, ${skipped.length} skipped)...\r`);
    fs.writeFileSync(outPath, JSON.stringify({ ingested, skipped, savedAt: new Date().toISOString() }, null, 2));

    if (i + CONCURRENCY < shows.length) await sleep(BATCH_DELAY);
  }

  process.stdout.write('\n');

  const skipReasons = {};
  for (const s of skipped) skipReasons[s.reason] = (skipReasons[s.reason] || 0) + 1;

  console.log('\n=== INGESTION RESULTS ===');
  console.log(`  Successfully ingested: ${ingested.length}`);
  console.log(`  Skipped:               ${skipped.length}`);
  if (Object.keys(skipReasons).length) {
    console.log('\nSkip reasons:');
    Object.entries(skipReasons).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k.padEnd(30)} ${v}`));
  }
  console.log(`\nSaved to pipeline/ingested_shows.json`);
  console.log('Run 03_score.js next (ANTHROPIC_API_KEY required).');
  console.log('Optionally run 02b_episode_history.js first to enrich Consistency scores.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
