#!/usr/bin/env node
// pipeline/check_category_resolver.js
//
// Regression check: verify the category resolver correctly classifies shows
// in scored_shows.json.
//
// Three outcome buckets:
//   correct           — resolves to a category in discoveryCats (expected)
//   reclassified      — resolves to a different mapped category (expected correct behavior:
//                        Apple overrides a Podcast Index tag that was too broad)
//   potential-drift   — reclassified AND relevance score ≥ DRIFT_REL_THRESHOLD (worth
//                        human review: same profile as TribCast, where Apple was wrong)
//   unsupported       — no Apple data and LLM fallback not enabled
//
// ✗ exits non-zero only if potential-drift cases are found.
//
// Usage:
//   node check_category_resolver.js           # Apple signal only
//   node check_category_resolver.js --llm     # Enable LLM fallback for unsupported shows

'use strict';

const fs   = require('fs');
const path = require('path');
const { resolveCategory, fetchAppleGenres, LIVE_CATEGORIES } = require('./utils/relevance_gate');

const SCORED_PATH = path.join(__dirname, 'scored_shows.json');

// Reclassified shows with relevance ≥ this threshold are flagged for human review.
// Calibrated against TribCast (rel=82, Apple wrong) vs highest confirmed-correct
// reclassification (Talkin' Bout Infosec rel=62, Apple right). Gap is sufficient.
const DRIFT_REL_THRESHOLD = 65;

function getRelevance(show) {
  const ep0 = (show.episodeScores || [])[0];
  const rel  = ep0?.contentScore?.topicRelevance;
  return typeof rel === 'object' ? (rel.score || 0) : (rel || 0);
}

async function main() {
  const useLLM = process.argv.includes('--llm');

  let anthropic = null;
  if (useLLM) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { console.error('Set ANTHROPIC_API_KEY for --llm mode.'); process.exit(1); }
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic.default({ apiKey: key });
  }

  if (!fs.existsSync(SCORED_PATH)) {
    console.error('scored_shows.json not found — run pipeline first.');
    process.exit(1);
  }

  const data  = JSON.parse(fs.readFileSync(SCORED_PATH, 'utf8'));
  const shows = data.scored;

  console.log('=== Category Resolver Regression Check ===');
  console.log(`Pool: ${shows.length} shows`);
  console.log(`Live categories: ${LIVE_CATEGORIES.join(', ')}`);
  console.log(`LLM fallback: ${useLLM ? 'enabled' : 'disabled (pass --llm to enable)'}`);
  console.log(`Drift threshold: rel ≥ ${DRIFT_REL_THRESHOLD} (reclassified shows above this need review)\n`);

  // Pre-fetch Apple genres for all shows that have an itunesId
  const itunesIds = [...new Set(shows.map(s => s.itunesId).filter(Boolean).map(String))];
  console.log(`Fetching Apple genres for ${itunesIds.length} / ${shows.length} shows with itunesId...`);
  const appleGenreMap = await fetchAppleGenres(itunesIds);

  // Genre distribution
  const genreDist = {};
  for (const [, genre] of appleGenreMap) {
    const key = genre || '(null — stale/delisted)';
    genreDist[key] = (genreDist[key] || 0) + 1;
  }
  console.log('\nApple genre distribution across pool:');
  Object.entries(genreDist).sort((a, b) => b[1] - a[1]).forEach(([g, n]) => {
    console.log(`  ${String(n).padStart(3)}  ${g}`);
  });

  // Resolve each show
  console.log('\nResolving categories...');
  const results = [];
  for (let i = 0; i < shows.length; i++) {
    const r = await resolveCategory(shows[i], appleGenreMap, anthropic);
    results.push({ show: shows[i], ...r });
    process.stdout.write(`\r  ${i + 1}/${shows.length}`);
  }
  console.log();

  // ── Bucket each result ───────────────────────────────────────────────────────
  const correct        = [];  // resolves to a category in show's discoveryCats
  const reclassified   = [];  // resolves to a different mapped category (expected)
  const potentialDrift = [];  // reclassified AND high relevance — needs human review
  const unsupported    = [];  // no resolution

  for (const r of results) {
    const discCats = r.show.discoveryCats || [];
    if (r.category === 'unsupported') {
      unsupported.push(r);
    } else if (discCats.includes(r.category)) {
      correct.push(r);
    } else {
      const rel = getRelevance(r.show);
      if (rel >= DRIFT_REL_THRESHOLD) {
        potentialDrift.push({ ...r, rel });
      } else {
        reclassified.push({ ...r, rel });
      }
    }
  }

  const catDist = {};
  for (const r of results) catDist[r.category] = (catDist[r.category] || 0) + 1;

  const signalDist = {};
  for (const r of results) signalDist[r.signal] = (signalDist[r.signal] || 0) + 1;

  // ── Report ───────────────────────────────────────────────────────────────────
  console.log('\n=== RESULTS ===');
  console.log(`  Correct (matches discoveryCats):  ${correct.length}`);
  console.log(`  Reclassified (Apple overrides PI): ${reclassified.length}  ← expected; Apple is correcting a too-broad PI tag`);
  console.log(`  Potential drift (rel ≥ ${DRIFT_REL_THRESHOLD}):      ${potentialDrift.length}  ← needs human review`);
  console.log(`  Unsupported:                      ${unsupported.length}`);

  console.log('\nCategory distribution:');
  Object.entries(catDist).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => {
    console.log(`  ${String(n).padStart(3)}  ${c}`);
  });

  console.log('\nSignal distribution:');
  Object.entries(signalDist).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => {
    console.log(`  ${String(n).padStart(3)}  ${s}`);
  });

  if (reclassified.length > 0) {
    console.log(`\nReclassified shows (${reclassified.length}) — Apple overriding PI tag, all expected:`);
    reclassified.forEach(r => {
      console.log(`  [${r.category}] rel=${r.rel}  genre="${r.genre || 'null'}" | ${r.show.feedTitle}`);
    });
  }

  if (potentialDrift.length > 0) {
    console.log(`\n⚠  POTENTIAL DRIFT — reclassified shows with rel ≥ ${DRIFT_REL_THRESHOLD} (human review needed):`);
    potentialDrift.forEach(r => {
      const ep0 = (r.show.episodeScores || [])[0];
      const rel  = ep0?.contentScore?.topicRelevance;
      const rat  = typeof rel === 'object' ? rel.rationale : '';
      console.log(`  [${r.category}] rel=${r.rel}  genre="${r.genre || 'null'}" | ${r.show.feedTitle}`);
      if (rat) console.log(`    LLM: ${rat}`);
    });
    console.log('\n  → These match the TribCast pattern (high news relevance, Apple genre override).');
    console.log('    Check whether Apple is right (show changed genre) or wrong (show is News/Politics).');
  }

  if (unsupported.length > 0) {
    console.log(`\nUnsupported shows (${unsupported.length}) — no Apple data${useLLM ? '' : '; run with --llm to classify'}:`);
    unsupported.slice(0, 30).forEach(r => {
      const genre = appleGenreMap.get(String(r.show.itunesId));
      const genreLabel = r.show.itunesId
        ? (genre ? `genre="${genre}"` : 'itunesId queried, Apple returned null')
        : 'no itunesId';
      console.log(`  [${r.signal}] ${genreLabel} | ${r.show.feedTitle}`);
    });
    if (unsupported.length > 30) console.log(`  … and ${unsupported.length - 30} more`);
    if (!useLLM) {
      console.log('\n  → Re-run with --llm to see which of these the LLM would rescue (e.g. TribCast pattern).');
    } else {
      console.log('\n  → Add their Apple genre to apple_genre_category_map.json if they are legitimate shows.');
    }
  }

  // ── Exit code ────────────────────────────────────────────────────────────────
  console.log();
  if (potentialDrift.length > 0) {
    console.log(`✗ ${potentialDrift.length} potential-drift show(s) need human review before treating resolver as ready.`);
    process.exit(1);
  } else if (unsupported.length > 0 && !useLLM) {
    const pct = Math.round((correct.length / shows.length) * 100);
    console.log(`⚠  ${correct.length} correct, ${reclassified.length} expected reclassifications, ${unsupported.length} unsupported (run --llm for full picture).`);
    console.log(`   No potential drift detected.`);
  } else {
    console.log(`✓ ${correct.length} correct, ${reclassified.length} expected reclassifications${potentialDrift.length === 0 ? ', no potential drift' : ''}.`);
    if (unsupported.length === 0) console.log('  Category resolver is fully validated for this pool.');
  }
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
