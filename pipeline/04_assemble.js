#!/usr/bin/env node
// pipeline/04_assemble.js
//
// Step 4: Assemble scored_shows.json into data/shows.json in the schema
// expected by index.html (DATA array fields + clip lookup tables).
//
// Usage:
//   node 04_assemble.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { resolveBatch } = require('./utils/relevance_gate');

// Full map from resolver Title Case → internal slug stored in c.cat.
// Shows with a resolver-confirmed category (any) store it here and skip inferCats.
// inferCats runs only when the resolver returns 'unsupported'.
const RESOLVER_TO_SLUG = {
  'News':           'news',
  'Politics':       'politics',
  'Technology':     'technology',
  'Business':       'business',
  'True Crime':     'true-crime',
  'Health & Fitness': 'health-fitness',
  'Sports':         'sports',
};

// Live (pill-browsable) subset.  Expand when discovery targets new genres.
const LIVE_SLUGS = new Set(['news', 'politics']);

const SCORE_FLOOR     = 40;  // below this = not surfaced
const RELEVANCE_FLOOR = 30;  // topic relevance below this = not surfaced (blocks sports/entertainment)

// ── Network affiliation heuristics ──────────────────────────────────────────
// Shows from major networks → tier:'major' (excluded from Discover default tab)
const MAJOR_KEYWORDS = [
  'npr', 'bbc', 'new york times', 'nyt', 'washington post', 'the atlantic',
  'vox media', 'vox', 'msnbc', 'cnn', 'abc news', 'cbs news', 'nbc news',
  'fox news', 'politico', 'bloomberg', 'reuters', 'associated press', 'ap news',
  'the guardian', 'the economist', 'wall street journal', 'wsj', 'slate',
  'the intercept', 'propublica', 'axios', 'the hill', 'daily beast',
  'huffpost', 'huffington post', 'buzzfeed', 'vice', 'pbs', 'c-span',
  'iheartradio', 'iheartmedia', 'audioboom', 'wondery', 'luminary',
  'crooked media', 'crooked', 'pod save', 'barstool', 'pushkin',
];

function isMajor(show) {
  const search = (show.feedTitle + ' ' + show.author + ' ' + show.description).toLowerCase();
  return MAJOR_KEYWORDS.some(kw => search.includes(kw));
}

// ── Display field generation ─────────────────────────────────────────────────

// Deterministic color from feedId
function idToColor(id) {
  const palette = [
    { bg: 'linear-gradient(135deg,#0d2137,#1a4a72)', card: 'linear-gradient(160deg,#0d1f2d,#081018)', ac: '#47b8ff' },
    { bg: 'linear-gradient(135deg,#1a0a08,#402510)', card: 'linear-gradient(160deg,#100806,#060403)', ac: '#ff7a47' },
    { bg: 'linear-gradient(135deg,#0a1a0a,#1a3a1a)', card: 'linear-gradient(160deg,#080e08,#030503)', ac: '#6fcf97' },
    { bg: 'linear-gradient(135deg,#1a0a2d,#3d1a5c)', card: 'linear-gradient(160deg,#110820,#060308)', ac: '#b47fff' },
    { bg: 'linear-gradient(135deg,#0a0a1a,#18183a)', card: 'linear-gradient(160deg,#060610,#020208)', ac: '#8fa8d4' },
    { bg: 'linear-gradient(135deg,#1a1a08,#3a3a10)', card: 'linear-gradient(160deg,#0e0e06,#050503)', ac: '#e8d84a' },
    { bg: 'linear-gradient(135deg,#1a0808,#3a1010)', card: 'linear-gradient(160deg,#0e0606,#050303)', ac: '#ff8a8a' },
    { bg: 'linear-gradient(135deg,#081820,#104038)', card: 'linear-gradient(160deg,#060e14,#030608)', ac: '#47d4c8' },
    { bg: 'linear-gradient(135deg,#0a0a0a,#2a2a2a)', card: 'linear-gradient(160deg,#080808,#030303)', ac: '#c8c8c8' },
    { bg: 'linear-gradient(135deg,#1a1208,#3a2a10)', card: 'linear-gradient(160deg,#0e0a06,#050403)', ac: '#f0a84a' },
  ];
  return palette[id % palette.length];
}

function makeInitials(title) {
  return title.split(/\s+/).slice(0, 3).map(w => w[0] || '').join('').toUpperCase().slice(0, 3) || 'POD';
}

function szFromMajor(major) {
  return major ? 'large' : 'mid';
}

function formatSocialStat(base) {
  if (base >= 10000) return (base / 1000).toFixed(0) + 'K';
  if (base >= 1000)  return (base / 1000).toFixed(1) + 'K';
  return String(base);
}

// Plausible fabricated social stats based on score and tier
function makeSocialStats(totalScore, major) {
  const baseLikes = major ? 5000 + totalScore * 400 : 80 + totalScore * 18;
  const lk = Math.round(baseLikes + (Math.random() - 0.5) * baseLikes * 0.2);
  const sh = Math.round(lk * 0.3);
  const sv = Math.round(lk * 0.45);
  return { lk: formatSocialStat(lk), sh: formatSocialStat(sh), sv: formatSocialStat(sv) };
}

// Derive momentum (1-10) from vitality score and consistency
function makeMomentum(vitality, consistency) {
  const raw = (vitality * 0.7 + consistency * 0.3) / 10;
  return Math.min(10, Math.max(1, Math.round(raw)));
}

function formatDur(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Category tags from feed categories or keyword matching
function inferCats(show) {
  const text = (show.feedTitle + ' ' + show.description).toLowerCase();
  const cats = [];
  if (/politic|senate|congress|democrat|republican|election|vote|party|white house|capitol/i.test(text)) cats.push('politics');
  if (/tech|ai|artificial|software|silicon|startup|crypto|cyber/i.test(text)) cats.push('tech');
  if (/world|international|global|foreign|europe|asia|africa|middle east/i.test(text)) cats.push('world');
  if (/local|city|state|municipal|community|regional/i.test(text)) cats.push('local');
  if (/science|health|climate|environment|medical|research/i.test(text)) cats.push('science');
  if (cats.length === 0) cats.push('news');
  return cats;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== HiddenPod — Assembly (Step 4) ===\n');

  const inPath = path.join(__dirname, 'scored_shows.json');
  if (!fs.existsSync(inPath)) { console.error('Run 03_score.js first.'); process.exit(1); }

  const { scored } = JSON.parse(fs.readFileSync(inPath, 'utf8'));

  // 1. Filter below-threshold
  const getLatestCS = s => (s.episodeScores || [])[0]?.contentScore || {};
  const getRelevance = s => {
    const r = getLatestCS(s).topicRelevance;
    return typeof r === 'object' ? (r.score || 0) : (r || 0);
  };
  const surfaceable = scored
    .filter(s => (getLatestCS(s).totalScore || 0) >= SCORE_FLOOR && getRelevance(s) >= RELEVANCE_FLOOR)
    .sort((a, b) => (getLatestCS(b).totalScore || 0) - (getLatestCS(a).totalScore || 0));

  const aboveScore = scored.filter(s => (getLatestCS(s).totalScore || 0) >= SCORE_FLOOR).length;
  console.log(`Scored: ${scored.length} | Total≥${SCORE_FLOOR}: ${aboveScore} | +Relevance≥${RELEVANCE_FLOOR}: ${surfaceable.length} (all surfaced)`);

  // 2. Resolve categories — Apple/LLM signal first, inferCats only for unsupported.
  //    Shows with a resolver-confirmed category (live or not) store that slug directly.
  //    inferCats keyword matching only runs when the resolver returns 'unsupported',
  //    preventing off-topic shows from leaking into News/Politics via catch-all defaults.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let anthropic = null;
  if (anthropicKey) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: anthropicKey });
  }
  console.log(`\nResolving categories (LLM fallback: ${anthropic ? 'enabled' : 'disabled — set ANTHROPIC_API_KEY to classify unsupported shows'})...`);

  const resolverResults = await resolveBatch(surfaceable, anthropic);
  const resolverMap = new Map(resolverResults.map(r => [String(r.feedId), r]));

  const resolverConfirmed   = resolverResults.filter(r => r.category !== 'unsupported');
  const resolverLive        = resolverResults.filter(r => LIVE_SLUGS.has(RESOLVER_TO_SLUG[r.category]));
  const resolverNonLive     = resolverResults.filter(r => r.category !== 'unsupported' && !LIVE_SLUGS.has(RESOLVER_TO_SLUG[r.category]));
  const resolverUnsupported = resolverResults.filter(r => r.category === 'unsupported');

  console.log(`  Resolver-confirmed (live News/Politics):        ${resolverLive.length}/${surfaceable.length}`);
  console.log(`  Resolver-confirmed (non-live, stored as-is):   ${resolverNonLive.length}  (${[...new Set(resolverNonLive.map(r => r.category))].join(', ') || 'none'})`);
  console.log(`  Unsupported (→ inferCats keyword fallback):     ${resolverUnsupported.length}`);

  // 3. Build DATA-compatible show objects
  const shows = surfaceable.map((show, idx) => {
    const id      = show.feedId;
    const major   = isMajor(show);
    const colors  = idToColor(id);
    const latestEp = (show.episodeScores || [])[0] || null;
    const sc      = latestEp?.contentScore || {};
    const slp     = show.showLevelProduction || {};
    const stats   = makeSocialStats(sc.totalScore || 0, major);
    const rr      = resolverMap.get(String(id));
    const cats    = (rr && rr.category !== 'unsupported')
      ? [RESOLVER_TO_SLUG[rr.category] || rr.category.toLowerCase().replace(/\s+/g, '-')]
      : inferCats(show);
    const dur     = show.clip?.durationSeconds || 30;

    return {
      // Core identity
      id,
      tier:    major ? 'major' : 'indie',
      cat:     cats,
      show:    show.feedTitle,
      outlet:  show.author || show.feedTitle,
      init:    makeInitials(show.feedTitle),
      logoBg:  colors.bg,
      cardBg:  colors.card,
      ac:      colors.ac,
      city:    '',          // not available from RSS metadata
      sz:      szFromMajor(major),
      szLbl:   major ? 'Major' : 'Independent',

      // Match/social display (prototype values)
      match: Math.min(99, (sc.totalScore || 0) + Math.round(Math.random() * 5)),
      lk:    stats.lk,
      sh:    stats.sh,
      sv:    stats.sv,

      // Episode
      ep:    show.latestEpisode?.title  || '',
      q:     show.clip?.text            || '',
      ts:    '0:00',
      dur:   '0:' + String(dur).padStart(2, '0'),
      prog:  0,

      // Card copy
      reason: show.card?.reason  || 'Trending in News & Politics',
      dh:     show.card?.tagline || show.feedTitle,
      db:     show.card?.description || show.description?.slice(0, 100) || '',
      dt:     show.card?.tags   || ['News', 'Politics'],

      // Scores (flat object matching current DIM_NAMES keys, no geofit)
      scores: {
        quality:     typeof sc.bitrateQuality === 'number' ? sc.bitrateQuality : 65,
        structure:   typeof sc.contentStructure  === 'object' ? (sc.contentStructure.score  || 0) : (sc.contentStructure  || 0),
        relevance:   typeof sc.topicRelevance    === 'object' ? (sc.topicRelevance.score    || 0) : (sc.topicRelevance    || 0),
        clipability: typeof sc.clipAbility       === 'object' ? (sc.clipAbility.score       || 0) : (sc.clipAbility       || 0),
        consistency: slp.consistency || 0,
        vitality:    slp.vitality    || 0,
      },

      momentum: makeMomentum(slp.vitality || 0, slp.consistency || 0),

      // Clip timing — consumed by CLIP_STARTS/CLIP_DURATIONS in index.html fetch callback
      clip: {
        startSeconds:        show.clip?.startSeconds       || 0,
        durationSeconds:     show.clip?.durationSeconds    || 30,
        speechOffsetSeconds: 0,
      },

      // Audit fields (not used by frontend)
      _meta: {
        feedUrl:          show.feedUrl,
        audioUrl:         show.latestEpisode?.audioUrl    || null,
        transcriptUrl:    show.transcript?.url             || null,
        transcriptType:   show.transcript?.type            || null,
        episodeId:        latestEp?.episodeId              || null,
        episodeTitle:     latestEp?.episodeTitle           || null,
        episodePubDate:   latestEp?.pubDate                || null,
        appleEpisodeUrl:  latestEp?.appleEpisodeUrl        || null,
        itunesId:         show.itunesId                    || null,
        totalScore:       sc.totalScore                    || 0,
        scoreTier:        sc.tier                          || null,
        algorithmVersion: sc.algorithmVersion              || null,
        scoredAt:         sc.scoredAt                      || null,
        productionAudio:  latestEp?.productionAudio        || null,
        showLevelProduction: show.showLevelProduction      || null,
        rationales: {
          relevance:   typeof sc.topicRelevance   === 'object' ? sc.topicRelevance.rationale   : null,
          structure:   typeof sc.contentStructure === 'object' ? sc.contentStructure.rationale : null,
          clipability: typeof sc.clipAbility      === 'object' ? sc.clipAbility.rationale      : null,
        },
        bonusSignals: {
          discoveryMomentum: null,
          breakoutIndex:     null,
          note: 'Not computed — requires 90-day baseline. Back-fill after shows have score history.',
        }
      }
    };
  });

  // 4. Write shows.json
  const outPath = path.join(__dirname, '..', 'data', 'shows.json');
  const output = {
    meta: {
      generatedAt:      new Date().toISOString(),
      algorithmVersion: 'v1.2',
      totalShows:       shows.length,
      sourceCategories: ['News', 'Politics'],
    },
    shows,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  const indieCount = shows.filter(s => s.tier === 'indie').length;
  const majorCount = shows.filter(s => s.tier === 'major').length;

  console.log('\n=== ASSEMBLY RESULTS ===');
  console.log(`  Total shows in shows.json: ${shows.length}`);
  console.log(`  Indie (Discover tab):      ${indieCount}`);
  console.log(`  Major (All Shows tab):     ${majorCount}`);
  console.log('\nTop 15 by score:');
  shows.slice(0, 15).forEach(s => console.log(`  [${s.scores.quality},${s.scores.structure},${s.scores.relevance}] ${s.tier === 'indie' ? '★' : ' '} ${s.show}`));

  console.log(`\ndata/shows.json written (${Math.round(fs.statSync(outPath).size / 1024)}KB)`);
  console.log('Deploy the repo to Vercel — index.html will fetch the new data automatically.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
