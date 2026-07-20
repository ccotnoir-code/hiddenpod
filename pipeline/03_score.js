#!/usr/bin/env node
// pipeline/03_score.js
//
// Step 3: Score each ingested show.
// A. Metadata-computed: Consistency, Episode Vitality, Audio Quality
// B. LLM-scored (Claude): Topic Relevance, Content Structure, Clip-ability
//    + card copy (tagline, description, tags, reason)
//
// Usage:
//   ANTHROPIC_API_KEY=xxx PODCASTINDEX_API_KEY=yyy PODCASTINDEX_API_SECRET=zzz node 03_score.js

'use strict';

const fs   = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { sleep } = require('./utils/podcast_index');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) { console.error('ERROR: Set ANTHROPIC_API_KEY.'); process.exit(1); }

const client = new Anthropic.default({ apiKey: ANTHROPIC_KEY });

// PodSignal v1.2 weights
const WEIGHTS = { quality: 0.18, structure: 0.20, relevance: 0.22, clipability: 0.16, consistency: 0.16, vitality: 0.08 };

const SYSTEM_PROMPT = `You are a podcast quality analyst scoring episodes for PodSignal, a third-party credentialing system for independent podcasts. Your scores must be objective, consistent, and defensible — this is the same rubric applied to every show in the database, so calibration matters more than generosity.

Score the episode on three dimensions, 0-100 each, using these definitions:

TOPIC RELEVANCE (how well the episode delivers on a News/Politics listener's expectation of timely, substantive coverage):
- 0-20: Off-topic or no clear connection to current news/political events. Sports, entertainment, lifestyle, home improvement, and commercial content score here regardless of production quality or analytical depth — subject matter gates this dimension first. A well-produced boxing or sports analysis still scores 0-20 here.
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
    "reason": "<12-15 word personalization stub, e.g. 'Because this episode covers the week\\'s biggest political story'>
  }
}`;

// ── Metadata-computed scores ────────────────────────────────────────────────

function scoreConsistency(last10Dates) {
  if (!last10Dates || last10Dates.length < 2) return 50;

  const timestamps = last10Dates
    .map(d => new Date(d).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => b - a);

  if (timestamps.length < 2) return 50;

  // Gaps between consecutive episodes in days
  const gaps = [];
  for (let i = 0; i + 1 < timestamps.length; i++) {
    gaps.push((timestamps[i] - timestamps[i + 1]) / (1000 * 60 * 60 * 24));
  }

  // Detect weekday-only schedule: all episodes land Mon–Fri and median gap ≤ 2 days.
  // For these shows, the 3-day Fri→Mon gap is structural, not irregular — scoring it
  // as variance would wrongly penalize shows like The Daily.
  const daysOfWeek  = timestamps.map(t => new Date(t).getDay());
  const weekendEps  = daysOfWeek.filter(d => d === 0 || d === 6).length;
  const sortedGaps  = [...gaps].sort((a, b) => a - b);
  const medianGap   = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const isWeekdayShow = weekendEps === 0 && timestamps.length >= 4 && medianGap < 2;

  // For weekday-only shows, exclude the weekend-crossing gaps from variance calc
  const scoringGaps = isWeekdayShow ? gaps.filter(g => g < 3) : gaps;
  const effectiveGaps = scoringGaps.length >= 2 ? scoringGaps : gaps;

  const mean = effectiveGaps.reduce((s, g) => s + g, 0) / effectiveGaps.length;
  const variance = effectiveGaps.reduce((s, g) => s + Math.pow(g - mean, 2), 0) / effectiveGaps.length;
  const stddev = Math.sqrt(variance);

  // CV (coefficient of variation): lower = more consistent
  const cv = mean > 0 ? stddev / mean : 0;

  // Score: cv=0 → 100, cv=0.5 → 70, cv=1 → 40, cv≥2 → 10
  return Math.max(10, Math.min(100, Math.round(100 - cv * 60)));
}

function scoreVitality(pubDateUnix) {
  if (!pubDateUnix) return 40;
  const ageMs   = Date.now() - pubDateUnix * 1000;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Very recent (< 3 days) = 90-100; week = 75-85; month = 55-70; older = lower
  if (ageDays <= 3)  return Math.round(90 + Math.random() * 8);
  if (ageDays <= 7)  return Math.round(78 + Math.random() * 7);
  if (ageDays <= 14) return Math.round(68 + Math.random() * 7);
  if (ageDays <= 30) return Math.round(58 + Math.random() * 7);
  if (ageDays <= 60) return Math.round(45 + Math.random() * 8);
  return Math.round(30 + Math.random() * 10);
}

function scoreAudioQuality(enclosureBytes, durationSeconds) {
  if (!enclosureBytes || !durationSeconds) return 65; // default when bitrate unavailable
  const bitrate = (enclosureBytes * 8) / durationSeconds; // bits per second
  const kbps = bitrate / 1000;

  // Scoring rubric: 128kbps=fair, 192kbps=good, 256kbps=very good, 320kbps+=excellent
  if (kbps >= 256) return Math.round(85 + Math.min(10, (kbps - 256) / 32));
  if (kbps >= 192) return Math.round(75 + (kbps - 192) / 6.4);
  if (kbps >= 128) return Math.round(60 + (kbps - 128) / 4);
  if (kbps >= 64)  return Math.round(40 + (kbps - 64) / 3.2);
  return Math.max(20, Math.round(kbps / 3));
}

// ── LLM scoring ─────────────────────────────────────────────────────────────

function buildUserPrompt(show) {
  const ep = show.latestEpisode;
  const pubDate = ep.pubDate ? ep.pubDate.slice(0, 10) : 'unknown';
  return `Show: ${show.feedTitle}
Episode: ${ep.title}
Published: ${pubDate}

Transcript excerpt:
${show.transcript.scoringWindow}`;
}

async function llmScore(show, attempt = 1) {
  try {
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 800,
      temperature: 0,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: buildUserPrompt(show) }]
    });

    let raw = msg.content[0].text.trim();
    // Strip code fences if present (prompt forbids them but models add them anyway)
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

    return JSON.parse(raw);
  } catch (e) {
    if (attempt < 2) {
      await sleep(1000);
      return llmScore(show, attempt + 1);
    }
    console.error(`\n  LLM failed for ${show.feedTitle}: ${e.message}`);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== HiddenPod — Scoring (Step 3) ===\n');

  const inPath = path.join(__dirname, 'ingested_shows.json');
  if (!fs.existsSync(inPath)) {
    console.error('Run 02_ingest.js first.');
    process.exit(1);
  }

  const { ingested } = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  console.log(`Scoring ${ingested.length} ingested shows...\n`);

  const scored   = [];
  const failed   = [];
  const outPath  = path.join(__dirname, 'scored_shows.json');

  for (let i = 0; i < ingested.length; i++) {
    const show = ingested[i];

    // A. Metadata scores
    const quality     = scoreAudioQuality(show.latestEpisode.enclosureBytes, show.latestEpisode.durationSeconds);
    const consistency = scoreConsistency(show.publishHistory?.last10EpisodeDates);
    const vitality    = scoreVitality(show.latestEpisode.pubDateUnix);

    // B. LLM scores + card copy
    const llm = await llmScore(show);

    if (!llm) {
      failed.push({ feedId: show.feedId, title: show.feedTitle });
      process.stdout.write(`  ${i + 1}/${ingested.length} — FAILED LLM: ${show.feedTitle}\n`);
      continue;
    }

    const relevance  = llm.topic_relevance.score;
    const structure  = llm.content_structure.score;
    const clipability = llm.clip_ability.score;

    // C. Weighted total
    const totalScore = Math.round(
      quality      * WEIGHTS.quality     +
      structure    * WEIGHTS.structure   +
      relevance    * WEIGHTS.relevance   +
      clipability  * WEIGHTS.clipability +
      consistency  * WEIGHTS.consistency +
      vitality     * WEIGHTS.vitality
    );

    const tier = totalScore >= 85 ? 'exceptional' : totalScore >= 70 ? 'strong' : totalScore >= 40 ? 'average' : 'below_threshold';
    const scoredAt = new Date().toISOString();
    const ep = show.latestEpisode;
    const episodeId = `ep_${(ep.pubDate || '').slice(0,10).replace(/-/g,'')||'unknown'}_${show.feedId}`;

    scored.push({
      ...show,
      itunesId:        show.itunesId || null,
      discoveryCats:   show.discoveryCats || null,
      latestEpisodeId: episodeId,
      showLevelProduction: {
        consistency,
        vitality,
        metadataCompleteness: null,  // set by 07_production_score.py
        feedCompliance:       null,  // set by 07_production_score.py
        computedAt:           scoredAt,
      },
      episodeScores: [{
        episodeId,
        episodeTitle:    ep.title,
        pubDate:         ep.pubDate,
        pubDateUnix:     ep.pubDateUnix,
        audioUrl:        ep.audioUrl,
        durationSeconds: ep.durationSeconds,
        guid:            ep.guid || null,
        contentScore: {
          bitrateQuality:   quality,
          topicRelevance:   { score: relevance,    rationale: llm.topic_relevance.rationale },
          contentStructure: { score: structure,    rationale: llm.content_structure.rationale },
          clipAbility:      { score: clipability,  rationale: llm.clip_ability.rationale },
          totalScore,
          tier,
          algorithmVersion: 'v1.2',
          scoredAt,
        },
        productionAudio:  null,  // set by 07_production_score.py
        appleEpisodeId:   null,
        appleEpisodeUrl:  null,
      }],
      card: llm.card,
    });

    process.stdout.write(`  ${i + 1}/${ingested.length} — [${totalScore}] ${show.feedTitle}\n`);

    // Save after every show (LLM calls are the expensive part)
    fs.writeFileSync(outPath, JSON.stringify({ scored, failed, savedAt: new Date().toISOString() }, null, 2));

    await sleep(150); // gentle rate limiting between Claude calls
  }

  console.log('\n=== SCORING RESULTS ===');
  console.log(`  Scored:  ${scored.length}`);
  console.log(`  Failed:  ${failed.length}`);

  const getCS = s => (s.episodeScores||[])[0]?.contentScore || {};
  const aboveThreshold = scored.filter(s => (getCS(s).totalScore||0) >= 40);
  const byTier = {};
  scored.forEach(s => { const t = getCS(s).tier||'unknown'; byTier[t] = (byTier[t] || 0) + 1; });

  console.log('\nScore distribution:');
  Object.entries(byTier).sort().forEach(([t, c]) => console.log(`  ${t.padEnd(18)} ${c}`));
  console.log(`\nAbove 40 threshold (surfaceable): ${aboveThreshold.length}`);
  console.log(`Top 10 scores:`);
  scored.sort((a, b) => (getCS(b).totalScore||0) - (getCS(a).totalScore||0))
    .slice(0, 10)
    .forEach(s => console.log(`  ${String(getCS(s).totalScore||0).padStart(3)}  ${s.feedTitle}`));

  console.log('\nScored shows → pipeline/scored_shows.json');
  console.log('Run 04_assemble.js next.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
