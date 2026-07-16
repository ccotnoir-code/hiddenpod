#!/usr/bin/env node
// pipeline/05_refresh.js
//
// Incremental weekly refresh — updates existing pool without full re-discovery.
// Fixed pool: re-checks all shows in scored_shows.json for new episodes.
//
//   New episode found → re-fetches transcript, extracts new clip, re-scores (LLM)
//   No new episode   → skips LLM, only updates Vitality (time-decay, free)
//   Dead feeds       → flagged inactive after DEAD_THRESHOLD consecutive API failures
//
// Writes scored_shows.json atomically (tmp → rename) so a mid-run crash can't
// corrupt the file. Then runs 04_assemble.js to regenerate data/shows.json.
//
// Usage (local):
//   ANTHROPIC_API_KEY=xxx PODCASTINDEX_API_KEY=yyy PODCASTINDEX_API_SECRET=zzz node 05_refresh.js
//
// In GitHub Actions: secrets are injected via the workflow env block.

'use strict';

const fs           = require('fs');
const path         = require('path');
const http         = require('http');
const https        = require('https');
const { execSync } = require('child_process');
const Anthropic    = require('@anthropic-ai/sdk');
const { piGet, sleep }           = require('./utils/podcast_index');
const { fetchTranscript, extractWindow,
        parseSRTWithTimestamps, parseVTTWithTimestamps } = require('./utils/transcript_parser');

const PI_KEY    = process.env.PODCASTINDEX_API_KEY;
const PI_SECRET = process.env.PODCASTINDEX_API_SECRET;
const ANT_KEY   = process.env.ANTHROPIC_API_KEY;

if (!PI_KEY || !PI_SECRET) { console.error('ERROR: Set PODCASTINDEX_API_KEY + PODCASTINDEX_API_SECRET.'); process.exit(1); }
if (!ANT_KEY)              { console.error('ERROR: Set ANTHROPIC_API_KEY.'); process.exit(1); }

const client = new Anthropic.default({ apiKey: ANT_KEY });

const SCORED_PATH         = path.join(__dirname, 'scored_shows.json');
const SCORED_TMP          = SCORED_PATH + '.tmp';
const ALGORITHM_VERSION   = 'v1.2';
const DEAD_THRESHOLD      = 3;   // consecutive API failures before marking feed inactive
const EPISODE_SCORES_CAP  = 26;  // max episodeScores entries per show (~6 months weekly)
const WEIGHTS             = { quality:0.18, structure:0.20, relevance:0.22, clipability:0.16, consistency:0.16, vitality:0.08 };
const MIN_WORDS           = 150;
const CLIP_WORDS          = 110;
const PI_DELAY            = 1200; // ms between Podcast Index calls
const CHECKPOINT_EVERY    = 20;

const EN_WORDS = new Set(['the','and','is','in','to','of','a','that','it','was','he','she','for','on','are','with','as','at','be','this','from','or','by','an','they','we','his','her','have','were','been','has','had','not','but','what','which','when','their','there','so','if','about','up','out','who','would','can','will','said','all','some','more','one','do','into','no','our','i','you','your','just','like','also']);

// ── Scoring helpers (mirrored from 03_score.js) ──────────────────────────────

function scoreVitality(pubDateUnix) {
  if (!pubDateUnix) return 40;
  const ageDays = (Date.now() - pubDateUnix * 1000) / (1000 * 60 * 60 * 24);
  if (ageDays <= 3)  return Math.round(90 + Math.random() * 8);
  if (ageDays <= 7)  return Math.round(78 + Math.random() * 7);
  if (ageDays <= 14) return Math.round(68 + Math.random() * 7);
  if (ageDays <= 30) return Math.round(58 + Math.random() * 7);
  if (ageDays <= 60) return Math.round(45 + Math.random() * 8);
  return Math.round(30 + Math.random() * 10);
}

function scoreAudioQuality(bytes, dur) {
  if (!bytes || !dur) return 65;
  const kbps = (bytes * 8) / dur / 1000;
  if (kbps >= 256) return Math.round(85 + Math.min(10, (kbps - 256) / 32));
  if (kbps >= 192) return Math.round(75 + (kbps - 192) / 6.4);
  if (kbps >= 128) return Math.round(60 + (kbps - 128) / 4);
  if (kbps >= 64)  return Math.round(40 + (kbps - 64) / 3.2);
  return Math.max(20, Math.round(kbps / 3));
}

function getScore(s, k) {
  if (k === 'consistency' || k === 'vitality') {
    return s.showLevelProduction?.[k] || 0;
  }
  const cs = (s.episodeScores || [])[0]?.contentScore;
  if (!cs) return 0;
  if (k === 'quality')     return cs.bitrateQuality || 0;
  if (k === 'structure')   return typeof cs.contentStructure  === 'object' ? (cs.contentStructure.score  || 0) : (cs.contentStructure  || 0);
  if (k === 'relevance')   return typeof cs.topicRelevance    === 'object' ? (cs.topicRelevance.score    || 0) : (cs.topicRelevance    || 0);
  if (k === 'clipability') return typeof cs.clipAbility       === 'object' ? (cs.clipAbility.score       || 0) : (cs.clipAbility       || 0);
  return 0;
}

function setScore(s, k, val) {
  if (k === 'consistency' || k === 'vitality') {
    if (!s.showLevelProduction) s.showLevelProduction = {};
    s.showLevelProduction[k] = val;
    return;
  }
  const ep = (s.episodeScores || [])[0];
  if (!ep) return;
  if (!ep.contentScore) ep.contentScore = {};
  const cs = ep.contentScore;
  if (k === 'quality')     { cs.bitrateQuality = val; return; }
  if (k === 'structure')   { if (typeof cs.contentStructure  === 'object') cs.contentStructure.score  = val; else cs.contentStructure  = val; return; }
  if (k === 'relevance')   { if (typeof cs.topicRelevance    === 'object') cs.topicRelevance.score    = val; else cs.topicRelevance    = val; return; }
  if (k === 'clipability') { if (typeof cs.clipAbility       === 'object') cs.clipAbility.score       = val; else cs.clipAbility       = val; return; }
}

function recomputeTotal(s) {
  const ep = (s.episodeScores || [])[0];
  if (!ep || !ep.contentScore) return;
  ep.contentScore.totalScore       = Math.round(Object.keys(WEIGHTS).reduce((t, k) => t + getScore(s, k) * WEIGHTS[k], 0));
  ep.contentScore.algorithmVersion = ALGORITHM_VERSION;
}

// ── Transcript helpers ────────────────────────────────────────────────────────

function isEnglish(text) {
  const words = text.toLowerCase().slice(0, 1200).split(/\s+/).filter(Boolean);
  if (words.length < 20) return false;
  return words.filter(w => EN_WORDS.has(w)).length / words.length >= 0.06;
}

function stripHtml(html) {
  return html
    .replace(/<cite>[^<]*<\/cite>/gi, '').replace(/<time>[^<]*<\/time>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#\d+;/g,'')
    .replace(/\s{2,}/g,' ').trim();
}

function wordIndexToSeconds(wordIdx, totalWords, durationSeconds) {
  if (!totalWords || !durationSeconds) return 300;
  return Math.round((wordIdx / totalWords) * durationSeconds);
}

function findClipWindow(plainText, durationSeconds) {
  const words     = plainText.trim().split(/\s+/);
  const total     = words.length;
  if (total < CLIP_WORDS) return { text: words.join(' '), startWord: 0, endWord: total };
  const zoneStart = Math.floor(total * 0.20);
  const zoneEnd   = Math.floor(total * 0.65) - CLIP_WORDS;
  if (zoneEnd <= zoneStart) return { text: words.slice(0, CLIP_WORDS).join(' '), startWord: 0, endWord: CLIP_WORDS };

  let bestStart = zoneStart, bestScore = -1;
  const step = Math.max(1, Math.floor((zoneEnd - zoneStart) / 20));
  for (let i = zoneStart; i < zoneEnd; i += step) {
    const chunk  = words.slice(i, i + CLIP_WORDS).join(' ');
    const avgLen = chunk.split(/\s+/).reduce((s, w) => s + w.length, 0) / CLIP_WORDS;
    const qBonus = (chunk.match(/\?/g) || []).length * 2;
    if (avgLen + qBonus > bestScore) { bestScore = avgLen + qBonus; bestStart = i; }
  }
  return { text: words.slice(bestStart, bestStart + CLIP_WORDS).join(' '), startWord: bestStart, endWord: bestStart + CLIP_WORDS };
}

function getContentLength(url, redirectsLeft = 6) {
  return new Promise((resolve) => {
    if (redirectsLeft <= 0) return resolve(null);
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method: 'HEAD', headers: { 'User-Agent': 'HiddenPodPipeline/1.0' } }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return resolve(getContentLength(next, redirectsLeft - 1));
      }
      const cl = res.headers['content-length'];
      resolve(cl ? parseInt(cl, 10) : null);
      req.destroy();
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── Apple episode link helpers ────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    let body = '';
    const req = lib.get(url, { headers: { 'User-Agent': 'HiddenPodPipeline/1.0' } }, (res) => {
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
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
    // Exact match first
    for (const r of results) {
      if ((r.collectionName || '').toLowerCase() === titleLow) return r.collectionId;
    }
    // Accept best result if similarity is high enough to be unambiguous
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

    // Primary: exact RSS guid match
    if (guid) {
      const exact = episodes.find(e => e.episodeGuid === guid);
      if (exact) return { trackId: exact.trackId, url: exact.trackViewUrl.replace('&uo=4', '') };
    }

    // Fallback: date within 48h AND title Jaccard ≥ 0.3
    const titleLow = (episodeTitle || '').toLowerCase();
    for (const e of episodes) {
      const epUnix = Math.floor(new Date(e.releaseDate).getTime() / 1000);
      if (Math.abs(epUnix - pubDateUnix) <= 172800) {
        if (titleSimilarity((e.trackName || '').toLowerCase(), titleLow) >= 0.3) {
          return { trackId: e.trackId, url: e.trackViewUrl.replace('&uo=4', '') };
        }
      }
    }
    return null;
  } catch (_) { return null; }
}

// ── LLM scoring ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a podcast quality analyst scoring episodes for PodSignal, a third-party credentialing system for independent podcasts. Your scores must be objective, consistent, and defensible — this is the same rubric applied to every show in the database, so calibration matters more than generosity.

Score the episode on three dimensions, 0-100 each, using these definitions:

TOPIC RELEVANCE (how well the episode delivers on a News/Politics listener's expectation of timely, substantive coverage):
- 0-20: Off-topic or no clear connection to current news/political events. Sports, entertainment, lifestyle, home improvement, and commercial content score here regardless of production quality or analytical depth — subject matter gates this dimension first. A well-produced boxing analysis still scores 0-20 here.
- 21-50: Loosely relevant; general political commentary without specific timely hooks. Sports or entertainment content that incidentally references a political angle also scores here.
- 51-75: Clearly on-topic, references specific current events or political developments, reasonably substantive
- 76-100: Sharp, timely, specific — the kind of episode someone would seek out because of what's happening right now. Requires News/Politics subject matter at its core.

NOTE: Sports analysis, boxing, entertainment, lifestyle, home improvement, and commodity/markets content should score 0-20 on Topic Relevance even when analytically specific or well-produced, unless the episode is primarily and substantively about a policy decision, legislation, antitrust case, or direct political development — not merely adjacent to it.

CONTENT STRUCTURE (how well-organized and navigable the episode is):
- 0-20: Rambling, no discernible segments, hard to follow
- 21-50: Loose structure, some organization but inconsistent pacing
- 51-75: Clear segments or throughline, identifiable intro/body/close
- 76-100: Tight structure, deliberate pacing, clear signposting throughout

CLIP-ABILITY (how well a 30-45 second excerpt would work as a standalone preview, without requiring outside context):
- 0-20: No self-contained moments; everything depends on surrounding context
- 21-50: A few usable moments but mostly requires setup
- 51-75: Multiple genuinely self-contained, quotable moments
- 76-100: Dense with hook-worthy, standalone moments that would work as a preview on their own

Also write brief card copy for the show's discovery card in the app. Be specific to this episode — no generic filler.

Return ONLY valid JSON, no markdown, no preamble:
{
  "topic_relevance": {"score": <0-100 integer>, "rationale": "<one sentence>"},
  "content_structure": {"score": <0-100 integer>, "rationale": "<one sentence>"},
  "clip_ability": {"score": <0-100 integer>, "rationale": "<one sentence>"},
  "card": {
    "tagline": "<10-15 word hook that would make a listener tap on this card>",
    "description": "<20-30 word sentence describing what this specific episode reveals or argues>",
    "tags": ["<tag1>", "<tag2>", "<tag3>", "<tag4>"],
    "reason": "<12-15 word personalization stub, e.g. 'Because this episode covers the week\\'s biggest political story'>"
  }
}`;

async function llmScore(show) {
  const ep      = show.latestEpisode;
  const pubDate = ep.pubDate ? ep.pubDate.slice(0, 10) : 'unknown';
  const prompt  = `Show: ${show.feedTitle}\nEpisode: ${ep.title}\nPublished: ${pubDate}\n\nTranscript excerpt:\n${show.transcript.scoringWindow}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 800, temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
      });
      let raw = msg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      return JSON.parse(raw);
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1000);
    }
  }
}

// ── Per-show refresh logic ────────────────────────────────────────────────────

async function refreshShow(show) {
  // Check Podcast Index for latest episode
  let epData;
  try {
    epData = await piGet(PI_KEY, PI_SECRET, '/episodes/byfeedid', { id: show.feedId, max: 1 });
  } catch (e) {
    const deadCount = (show._refreshMeta?.deadCount || 0) + 1;
    show._refreshMeta = { ...(show._refreshMeta || {}), deadCount, lastError: e.message, lastChecked: new Date().toISOString() };
    if (deadCount >= DEAD_THRESHOLD) show._refreshMeta.inactive = true;
    return { status: 'api_error', deadCount };
  }

  // Reset dead counter on successful API response
  show._refreshMeta = { ...(show._refreshMeta || {}), deadCount: 0, lastChecked: new Date().toISOString() };

  const ep = epData?.items?.[0];
  if (!ep) {
    // Feed returned 200 but has no episodes — treat as dark
    show._refreshMeta.inactive = true;
    return { status: 'no_episodes' };
  }

  // Always recompute Vitality (free — just a date math function)
  const newVitality = scoreVitality(ep.datePublished || show.latestEpisode?.pubDateUnix);
  setScore(show, 'vitality', newVitality);
  if (show.showLevelProduction) show.showLevelProduction.computedAt = new Date().toISOString();

  const storedPub = show.latestEpisode?.pubDateUnix || 0;
  if (ep.datePublished <= storedPub) {
    // No new episode — vitality update only
    recomputeTotal(show);
    return { status: 'vitality_only' };
  }

  // ── New episode ────────────────────────────────────────────────────────────

  // Pick best available transcript format
  const transcripts = ep.transcripts || [];
  const PREFER_TYPES = ['text/vtt', 'application/srt', 'text/html'];
  let txEntry = null;
  for (const t of PREFER_TYPES) {
    txEntry = transcripts.find(x => x.type === t);
    if (txEntry) break;
  }
  if (!txEntry && transcripts.length > 0) txEntry = transcripts[0];

  const dur = ep.duration || show.latestEpisode?.durationSeconds || 1800;
  const epPubDate = new Date(ep.datePublished * 1000).toISOString();
  const newEpisodeId = `pi_${ep.id || (String(ep.datePublished) + '_' + show.feedId)}`;
  const epGuid = ep.guid || null;

  // Build the new episode score entry (contentScore will be filled after LLM)
  const newEpScore = {
    episodeId:       newEpisodeId,
    episodeTitle:    ep.title,
    pubDate:         epPubDate,
    pubDateUnix:     ep.datePublished,
    audioUrl:        ep.enclosureUrl,
    durationSeconds: dur,
    guid:            epGuid,
    contentScore: {
      bitrateQuality:   null,
      topicRelevance:   null,
      contentStructure: null,
      clipAbility:      null,
      totalScore:       0,
      tier:             'below_threshold',
      algorithmVersion: ALGORITHM_VERSION,
      scoredAt:         null,
    },
    productionAudio:  null,  // set by 07_production_score.py on next production score run
    appleEpisodeId:   null,
    appleEpisodeUrl:  null,
  };

  // Prepend new episode and cap history
  show.episodeScores = [newEpScore, ...(show.episodeScores || [])].slice(0, EPISODE_SCORES_CAP);
  show.latestEpisodeId = newEpisodeId;

  // Update latestEpisode runtime metadata
  show.latestEpisode = {
    ...(show.latestEpisode || {}),
    title:           ep.title,
    audioUrl:        ep.enclosureUrl,
    enclosureBytes:  ep.enclosureLength || 0,
    pubDateUnix:     ep.datePublished,
    pubDate:         epPubDate,
    durationSeconds: dur,
    guid:            epGuid,
  };

  // Bitrate quality score
  let bitrateQuality = 65;
  if (ep.enclosureLength && dur) {
    bitrateQuality = scoreAudioQuality(ep.enclosureLength, dur);
  } else {
    const bytes = await getContentLength(ep.enclosureUrl);
    if (bytes) bitrateQuality = scoreAudioQuality(bytes, dur);
  }
  newEpScore.contentScore.bitrateQuality = bitrateQuality;

  // Apple episode link (itunesId lookup if not already stored, then episode match)
  if (!show.itunesId) {
    show.itunesId = await lookupItunesId(show.feedTitle);
    await sleep(300);
  }
  if (show.itunesId) {
    const appleMatch = await matchAppleEpisode(show.itunesId, epGuid, ep.datePublished, ep.title);
    await sleep(300);
    if (appleMatch) {
      newEpScore.appleEpisodeId  = appleMatch.trackId;
      newEpScore.appleEpisodeUrl = appleMatch.url;
    }
  }

  if (!txEntry) {
    // No transcript — keep bitrate quality, skip LLM
    recomputeTotal(show);
    return { status: 'new_ep_no_transcript' };
  }

  // Fetch and parse transcript
  let rawText;
  try {
    rawText = await fetchTranscript(txEntry.url);
  } catch (e) {
    recomputeTotal(show);
    return { status: 'transcript_fetch_failed', error: e.message };
  }

  const looksHtml = /<[a-z][\s\S]*>/i.test(rawText.slice(0, 200));
  const plainText = looksHtml ? stripHtml(rawText) : rawText;
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;

  if (!isEnglish(plainText) || wordCount < MIN_WORDS) {
    recomputeTotal(show);
    return { status: 'transcript_unusable' };
  }

  const clip       = findClipWindow(plainText, dur);
  let clipStartSec = wordIndexToSeconds(clip.startWord, wordCount, dur);

  // Use real cue timestamps for VTT/SRT
  if (txEntry.type === 'text/vtt' || txEntry.type === 'application/srt') {
    try {
      const cues = txEntry.type === 'text/vtt' ? parseVTTWithTimestamps(rawText) : parseSRTWithTimestamps(rawText);
      if (cues.length > 0) {
        let wordIdx = 0;
        for (const cue of cues) {
          const cueWords = cue.text.split(/\s+/).filter(Boolean);
          if (wordIdx + cueWords.length > clip.startWord) { clipStartSec = Math.round(cue.startSeconds); break; }
          wordIdx += cueWords.length;
        }
      }
    } catch (_) {}
  }

  const clipDurSec    = Math.min(Math.max(Math.round((CLIP_WORDS / wordCount) * dur), 25), 55);
  const scoringWindow = extractWindow(plainText, clipStartSec, dur, 2000);

  show.clip = {
    startSeconds:        clipStartSec,
    durationSeconds:     clipDurSec,
    speechOffsetSeconds: 0,
    text:                clip.text,
  };
  show.transcript = {
    url:          txEntry.url,
    type:         txEntry.type,
    wordCount,
    scoringWindow,
  };

  // LLM re-score — writes directly into the new episode entry
  let llm;
  try {
    llm = await llmScore(show);
  } catch (e) {
    recomputeTotal(show);
    return { status: 'llm_failed', error: e.message };
  }

  if (llm) {
    const cs = newEpScore.contentScore;
    cs.topicRelevance    = { score: llm.topic_relevance.score,    rationale: llm.topic_relevance.rationale };
    cs.contentStructure  = { score: llm.content_structure.score,  rationale: llm.content_structure.rationale };
    cs.clipAbility       = { score: llm.clip_ability.score,       rationale: llm.clip_ability.rationale };
    cs.scoredAt          = new Date().toISOString();
    show.card            = llm.card;
  }

  recomputeTotal(show);
  return { status: 'fully_refreshed' };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== HiddenPod — Weekly Refresh (Step 5) ===\n');

  if (!fs.existsSync(SCORED_PATH)) {
    console.error('scored_shows.json not found. Run the full pipeline (01→04) first, then commit scored_shows.json.');
    process.exit(1);
  }

  // Warn if local branch is behind origin — a stale local copy + manual run
  // is the most common cause of a scored_shows.json merge conflict on push.
  // Skip check in CI (GITHUB_ACTIONS is set by the runner).
  if (!process.env.GITHUB_ACTIONS) {
    try {
      execSync('git fetch origin main --quiet', { cwd: __dirname, stdio: 'pipe' });
      const behind = execSync('git rev-list HEAD..origin/main --count', { cwd: __dirname, stdio: 'pipe' }).toString().trim();
      if (parseInt(behind) > 0) {
        console.warn(`\n⚠  WARNING: local branch is ${behind} commit(s) behind origin/main.`);
        console.warn('   Run "git pull" before continuing to avoid a push conflict.\n');
        // Not a hard exit — let the user decide. The write is still atomic.
      }
    } catch (_) { /* non-git environment or fetch failed — skip silently */ }
  }

  const data  = JSON.parse(fs.readFileSync(SCORED_PATH, 'utf8'));
  const shows = data.scored;
  console.log(`Pool: ${shows.length} shows\n`);

  const counts = { vitality_only:0, fully_refreshed:0, new_ep_no_transcript:0, api_error:0, dead:0, other:0 };

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];

    if (show._refreshMeta?.inactive) {
      process.stdout.write(`  ${i+1}/${shows.length} SKIP(dead): ${show.feedTitle.slice(0,40)}\n`);
      counts.dead++;
      continue;
    }

    const outcome = await refreshShow(show);

    if (outcome.status === 'fully_refreshed') {
      counts.fully_refreshed++;
      process.stdout.write(`  ${i+1}/${shows.length} RE-SCORED [${show.scores.totalScore}]: ${show.feedTitle.slice(0,38)}\n`);
      await sleep(150); // breathe after LLM call
    } else if (outcome.status === 'vitality_only') {
      counts.vitality_only++;
      process.stdout.write(`  ${i+1}/${shows.length} vitality: ${show.feedTitle.slice(0,42)}\r`);
    } else if (outcome.status === 'new_ep_no_transcript') {
      counts.new_ep_no_transcript++;
      process.stdout.write(`  ${i+1}/${shows.length} NEW EP/no-tx: ${show.feedTitle.slice(0,38)}\n`);
    } else if (outcome.status === 'api_error') {
      counts.api_error++;
      if (outcome.deadCount >= DEAD_THRESHOLD) {
        counts.dead++;
        process.stdout.write(`  ${i+1}/${shows.length} DEAD FEED (${outcome.deadCount} failures): ${show.feedTitle.slice(0,30)}\n`);
      } else {
        process.stdout.write(`  ${i+1}/${shows.length} api-err (${outcome.deadCount}/${DEAD_THRESHOLD}): ${show.feedTitle.slice(0,32)}\n`);
      }
    } else {
      counts.other++;
      process.stdout.write(`  ${i+1}/${shows.length} ${outcome.status}: ${show.feedTitle.slice(0,38)}\n`);
    }

    // Checkpoint to temp file (not yet replacing real file)
    if ((i + 1) % CHECKPOINT_EVERY === 0) {
      fs.writeFileSync(SCORED_TMP, JSON.stringify({ ...data, scored: shows, refreshedAt: new Date().toISOString() }, null, 2));
      process.stdout.write(`\n  [checkpoint ${i+1}/${shows.length}]\n`);
    }

    await sleep(PI_DELAY);
  }

  // ── Atomic commit of scored_shows.json ───────────────────────────────────
  process.stdout.write('\n');
  const out = { ...data, scored: shows, refreshedAt: new Date().toISOString() };
  fs.writeFileSync(SCORED_TMP, JSON.stringify(out, null, 2));
  fs.renameSync(SCORED_TMP, SCORED_PATH);
  console.log('scored_shows.json updated (atomic rename).');

  // ── Regenerate shows.json ─────────────────────────────────────────────────
  console.log('Running 04_assemble.js...\n');
  execSync('node 04_assemble.js', { cwd: __dirname, stdio: 'inherit' });

  // ── Summary ───────────────────────────────────────────────────────────────
  const activeShows = shows.filter(s => !s._refreshMeta?.inactive).length;
  console.log('\n=== REFRESH SUMMARY ===');
  console.log(`  Fully re-scored:         ${counts.fully_refreshed}`);
  console.log(`  Vitality-only update:    ${counts.vitality_only}`);
  console.log(`  New ep / no transcript:  ${counts.new_ep_no_transcript}`);
  console.log(`  API errors (not dead):   ${counts.api_error}`);
  console.log(`  Dead/inactive:           ${counts.dead}`);
  console.log(`  Other:                   ${counts.other}`);
  console.log(`\n  Active pool: ${activeShows} shows`);
  console.log('\ndata/shows.json updated. Commit + push to deploy.');
}

main().catch(e => {
  if (fs.existsSync(SCORED_TMP)) {
    try { fs.unlinkSync(SCORED_TMP); } catch (_) {}
  }
  console.error('\nFatal:', e.message);
  process.exit(1);
});
