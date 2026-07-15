'use strict';

// Relevance Gate — two-signal hard exclusion filter.
//
// Primary signal: Apple's primaryGenreName via iTunes lookup (free, authoritative).
// Fallback: LLM check against title + description + Podcast Index tags (for shows
// with no Apple Podcasts presence).
//
// Returns: { pass: boolean, signal: 'apple'|'llm'|'no-data', rationale: string }

const path = require('path');
const fs   = require('fs');

const GATE_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'relevance_gate_config.json'), 'utf8')
);

const ITUNES_BATCH_SIZE = 200;
const ITUNES_DELAY_MS   = 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Batch-fetch primaryGenreName for a list of itunesIds.
// Returns Map<itunesId, string|null> where:
//   string  — Apple resolved this ID, value is primaryGenreName
//   null    — Apple was queried but returned no result (stale/delisted ID)
//   absent  — ID was never looked up (show had no itunesId)
// This three-way distinction lets checkOne emit a precise signal for auditing.
async function fetchAppleGenres(itunesIds) {
  const result = new Map();
  const ids = itunesIds.filter(Boolean);
  if (!ids.length) return result;

  for (let i = 0; i < ids.length; i += ITUNES_BATCH_SIZE) {
    const batch = ids.slice(i, i + ITUNES_BATCH_SIZE);
    // Pre-seed all IDs in this batch as null (stale sentinel).
    // Any that resolve will overwrite with their genre string.
    for (const id of batch) result.set(String(id), null);

    const url = 'https://itunes.apple.com/lookup?id=' + batch.join(',') + '&entity=podcast&media=podcast';
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'HiddenPod/1.0' } });
      const j   = await res.json();
      for (const r of (j.results || [])) {
        if (r.collectionId && r.primaryGenreName) {
          result.set(String(r.collectionId), r.primaryGenreName);
        }
      }
    } catch (e) {
      console.warn('iTunes batch lookup failed:', e.message);
    }
    if (i + ITUNES_BATCH_SIZE < ids.length) await sleep(ITUNES_DELAY_MS);
  }
  return result;
}

// Run LLM fallback check for a single show against a category.
// signal: caller-supplied signal tag for audit trail ('llm-no-itunes' or 'llm-stale-itunes').
async function llmFallbackCheck(show, categoryKey, anthropic, signal = 'llm-no-itunes') {
  const config  = GATE_CONFIG[categoryKey];
  const prompt  =
    `You are evaluating whether a podcast belongs in the "${categoryKey}" category on a discovery platform.\n\n` +
    `Show title: ${show.feedTitle || show.title}\n` +
    `Description: ${(show.description || '').slice(0, 500)}\n` +
    `Self-declared tags: ${Object.values(show.categories || {}).join(', ') || 'none'}\n\n` +
    `Does this podcast genuinely fit the "${categoryKey}" category? ` +
    `Answer with exactly: PASS or FAIL, then a single sentence explaining why.`;

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages:   [{ role: 'user', content: prompt }],
    });
    const text   = msg.content[0]?.text?.trim() || '';
    const passes = text.toUpperCase().startsWith('PASS');
    return {
      pass:      passes,
      signal,
      rationale: text,
    };
  } catch (e) {
    // Fail-closed on LLM error: consistent with "under-include over contaminate" philosophy.
    // An unresolvable verdict is uncertainty; uncertain shows don't pass the gate.
    return { pass: false, signal: 'llm-error', rationale: 'LLM error — failing closed: ' + e.message };
  }
}

// Check a single show against a category.
// appleGenreMap: Map<itunesId, primaryGenreName> pre-fetched for the batch.
// anthropic: Anthropic client instance (only used for LLM fallback path).
function checkOne(show, categoryKey, appleGenreMap, anthropic) {
  const config = GATE_CONFIG[categoryKey];
  if (!config) {
    return Promise.resolve({ pass: true, signal: 'no-config', rationale: `No gate config for category "${categoryKey}" — defaulting to pass` });
  }

  const itunesId   = show.itunesId ? String(show.itunesId) : null;
  const inMap      = itunesId ? appleGenreMap.has(itunesId) : false;
  const appleGenre = inMap ? appleGenreMap.get(itunesId) : undefined;

  if (appleGenre) {
    // Apple resolved this ID and returned a genre.
    const passes = config.applePass.includes(appleGenre);
    return Promise.resolve({
      pass:      passes,
      signal:    'apple',
      rationale: `Apple primaryGenreName="${appleGenre}" — ${passes ? 'in pass list' : 'not in pass list for ' + categoryKey}`,
    });
  }

  if (inMap && appleGenre === null) {
    // itunesId was queried but Apple returned no result — stale or delisted ID.
    // Treat as no Apple coverage and fall through to LLM, but flag distinctly for auditing.
    if (anthropic) return llmFallbackCheck(show, categoryKey, anthropic, 'llm-stale-itunes');
  }

  // No itunesId at all — show never had Apple Podcasts presence.
  if (anthropic) return llmFallbackCheck(show, categoryKey, anthropic, 'llm-no-itunes');

  return Promise.resolve({ pass: true, signal: 'no-data', rationale: 'No Apple data and no LLM client — defaulting to pass' });
}

// Check a batch of shows against a single category.
// Shows must have an itunesId field (persisted by 01_discover.js).
// Returns array of { show, pass, signal, rationale } in input order.
async function checkBatch(shows, categoryKey, anthropic) {
  const config = GATE_CONFIG[categoryKey];
  if (!config) {
    console.warn(`relevance_gate: no config for category "${categoryKey}" — all shows pass`);
    return shows.map(show => ({ show, pass: true, signal: 'no-config', rationale: 'no config' }));
  }

  // Batch-fetch Apple genres for all shows that have an itunesId
  const itunesIds   = [...new Set(shows.map(s => s.itunesId).filter(Boolean).map(String))];
  const appleGenres = await fetchAppleGenres(itunesIds);

  console.log(`  Apple genre lookup: ${appleGenres.size}/${itunesIds.length} itunesIds resolved`);

  const results = [];
  for (const show of shows) {
    const verdict = await checkOne(show, categoryKey, appleGenres, anthropic);
    results.push({ show, ...verdict });
  }
  return results;
}

module.exports = { checkBatch, fetchAppleGenres, GATE_CONFIG };
