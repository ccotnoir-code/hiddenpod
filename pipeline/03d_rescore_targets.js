#!/usr/bin/env node
// pipeline/03d_rescore_targets.js
//
// Re-scores specific shows through the LLM using the current (fixed) SYSTEM_PROMPT.
// Used to correct shows that were scored before a rubric update.
//
// Run with a comma-separated list of feedIds:
//   ANTHROPIC_API_KEY=xxx node 03d_rescore_targets.js 1471052,48182,2203459,7794076,4463176
//
// Or edit TARGET_FEED_IDS below and run with no args.

'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { sleep } = require('./utils/podcast_index');

const ANT_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANT_KEY) { console.error('ERROR: Set ANTHROPIC_API_KEY.'); process.exit(1); }

const client = new Anthropic.default({ apiKey: ANT_KEY });

const SCORED_PATH = path.join(__dirname, 'scored_shows.json');
const WEIGHTS = { quality:0.18, structure:0.20, relevance:0.22, clipability:0.16, consistency:0.16, vitality:0.08 };

// Edit this list or pass feedIds as CLI args
const TARGET_FEED_IDS = new Set(
  (process.argv[2] ? process.argv[2].split(',') : [
    '1471052',  // The Neutral Corner boxing podcast
    '48182',    // Open Floor: SI's NBA Show
    '2203459',  // OneLegUpAlex Sports
    '7794076',  // What In The Wide World Of Sports?
    '4463176',  // AG Bull (commodity markets)
  ]).map(id => String(id).trim())
);

// Must match 03_score.js and 05_refresh.js — keep in sync
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
    "reason": "<12-15 word personalization stub, e.g. 'Because this episode covers the week\\'s biggest political story'>"
  }
}`;

function getCS(show) {
  return (show.episodeScores||[])[0]?.contentScore || {};
}

function getScore(show, k) {
  const cs = getCS(show);
  const slp = show.showLevelProduction || {};
  switch (k) {
    case 'quality':     return cs.bitrateQuality || 0;
    case 'structure':   return typeof cs.contentStructure === 'object' ? (cs.contentStructure.score||0) : (cs.contentStructure||0);
    case 'relevance':   return typeof cs.topicRelevance === 'object' ? (cs.topicRelevance.score||0) : (cs.topicRelevance||0);
    case 'clipability': return typeof cs.clipAbility === 'object' ? (cs.clipAbility.score||0) : (cs.clipAbility||0);
    case 'consistency': return slp.consistency || 0;
    case 'vitality':    return slp.vitality || 0;
    default: return 0;
  }
}

async function rescore(show) {
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

async function main() {
  console.log('=== HiddenPod — Targeted Re-Score (Step 3d) ===\n');
  console.log('Target feedIds:', [...TARGET_FEED_IDS].join(', '), '\n');

  const data = JSON.parse(fs.readFileSync(SCORED_PATH, 'utf8'));

  for (let i = 0; i < data.scored.length; i++) {
    const show = data.scored[i];
    if (!TARGET_FEED_IDS.has(String(show.feedId))) continue;

    const oldRel   = getScore(show, 'relevance');
    const oldTotal = getCS(show).totalScore;

    console.log(`Re-scoring: ${show.feedTitle}`);
    console.log(`  Before — rel:${oldRel}  total:${oldTotal}`);

    let llm;
    try {
      llm = await rescore(show);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      continue;
    }

    // Patch LLM-scored dimensions into episodeScores[0].contentScore
    const cs = getCS(show);
    if (cs.topicRelevance && typeof cs.topicRelevance === 'object') {
      cs.topicRelevance.score     = llm.topic_relevance.score;
      cs.topicRelevance.rationale = llm.topic_relevance.rationale;
    } else {
      cs.topicRelevance = { score: llm.topic_relevance.score, rationale: llm.topic_relevance.rationale };
    }
    if (cs.contentStructure && typeof cs.contentStructure === 'object') {
      cs.contentStructure.score     = llm.content_structure.score;
      cs.contentStructure.rationale = llm.content_structure.rationale;
    } else {
      cs.contentStructure = { score: llm.content_structure.score, rationale: llm.content_structure.rationale };
    }
    if (cs.clipAbility && typeof cs.clipAbility === 'object') {
      cs.clipAbility.score     = llm.clip_ability.score;
      cs.clipAbility.rationale = llm.clip_ability.rationale;
    } else {
      cs.clipAbility = { score: llm.clip_ability.score, rationale: llm.clip_ability.rationale };
    }

    // Update card copy
    show.card = llm.card;
    cs.scoredAt = new Date().toISOString();

    // Recompute total
    cs.totalScore = Math.round(
      Object.keys(WEIGHTS).reduce((t, k) => t + getScore(show, k) * WEIGHTS[k], 0)
    );

    console.log(`  After  — rel:${llm.topic_relevance.score}  total:${cs.totalScore}`);
    console.log(`  Rationale: ${llm.topic_relevance.rationale}`);

    fs.writeFileSync(SCORED_PATH, JSON.stringify(data, null, 2));
    await sleep(500);
  }

  console.log('\nDone. Run 04_assemble.js to update data/shows.json.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
