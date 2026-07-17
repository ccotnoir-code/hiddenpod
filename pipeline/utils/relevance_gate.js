'use strict';

// Category Resolver — replaces the per-category allowlist gate.
//
// Primary signal: Apple primaryGenreName → apple_genre_category_map.json lookup.
// Fallback: LLM classification (which category?) for shows Apple doesn't cover.
//
// Returns: { category: string, signal: 'apple'|'llm-stale-itunes'|'llm-no-itunes'|'llm-error' }
// category is a HiddenPod category name or "unsupported".

const path = require('path');
const fs   = require('fs');

const GENRE_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'apple_genre_category_map.json'), 'utf8')
);

// Live set of HiddenPod categories — derived from map values, deduped, insertion order.
const LIVE_CATEGORIES = [...new Set(Object.values(GENRE_MAP).filter(Boolean))];

const ITUNES_BATCH_SIZE = 200;
const ITUNES_DELAY_MS   = 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Batch-fetch primaryGenreName for a list of itunesIds.
// Returns Map<itunesId, string|null> where:
//   string  — Apple resolved the ID; value is primaryGenreName
//   null    — ID was queried but Apple returned no result (stale/delisted)
//   absent  — ID was never queried (show had no itunesId)
async function fetchAppleGenres(itunesIds) {
  const result = new Map();
  const ids = [...new Set(itunesIds.filter(Boolean).map(String))];
  if (!ids.length) return result;

  for (let i = 0; i < ids.length; i += ITUNES_BATCH_SIZE) {
    const batch = ids.slice(i, i + ITUNES_BATCH_SIZE);
    for (const id of batch) result.set(id, null); // pre-seed as stale sentinel

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

// LLM classification fallback: returns which live category fits best, or "unsupported".
async function llmClassify(show, anthropic, signal) {
  const cats = LIVE_CATEGORIES.join(', ');
  const prompt =
    `You are classifying a podcast into one of these HiddenPod categories: ${cats}\n\n` +
    `Show title: ${show.feedTitle || show.title || ''}\n` +
    `Author: ${show.author || ''}\n` +
    `Description: ${(show.description || '').slice(0, 400)}\n` +
    `Self-declared tags: ${Object.values(show.categories || {}).join(', ') || 'none'}\n\n` +
    `Which single category best fits this podcast? Reply with ONLY the exact category name from the list above, or "none" if it does not fit any. No explanation.`;

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 20,
      temperature: 0,
      messages:   [{ role: 'user', content: prompt }],
    });
    const raw = (msg.content[0]?.text || '').trim();
    if (raw === 'none') return { category: 'unsupported', signal };
    if (LIVE_CATEGORIES.includes(raw)) return { category: raw, signal };
    // Model returned something that isn't a valid category — fail closed.
    return { category: 'unsupported', signal: 'llm-error' };
  } catch (e) {
    // Fail-closed on LLM error: uncertain shows don't get surfaced.
    return { category: 'unsupported', signal: 'llm-error' };
  }
}

// Resolve a single show to a HiddenPod category (or "unsupported").
//
// appleGenreMap: Map<itunesId, primaryGenreName> pre-fetched for the batch (pass null to skip).
// anthropic: Anthropic client instance (or null to disable LLM fallback).
async function resolveCategory(show, appleGenreMap, anthropic) {
  const itunesId = show.itunesId ? String(show.itunesId) : null;
  const inMap    = itunesId && appleGenreMap ? appleGenreMap.has(itunesId) : false;
  const genre    = inMap ? appleGenreMap.get(itunesId) : undefined;

  // Apple resolved the ID and returned a genre — check the map.
  if (genre) {
    const mapped = GENRE_MAP[genre];
    if (mapped) {
      if (show.discoveryCats && !show.discoveryCats.includes(mapped)) {
        console.warn(
          `[category_resolver] mismatch: feedId=${show.feedId} "${show.feedTitle}" ` +
          `discovered under [${show.discoveryCats.join(', ')}] but Apple genre="${genre}" → "${mapped}"`
        );
      }
      return { category: mapped, signal: 'apple', genre };
    }
    // Genre exists but isn't in our map — fall through to LLM.
    if (anthropic) return llmClassify(show, anthropic, 'llm-stale-itunes');
    return { category: 'unsupported', signal: 'llm-stale-itunes' };
  }

  // itunesId was queried but Apple returned null (stale/delisted) — LLM fallback.
  if (inMap && genre === null) {
    if (anthropic) return llmClassify(show, anthropic, 'llm-stale-itunes');
    return { category: 'unsupported', signal: 'llm-stale-itunes' };
  }

  // No itunesId — no Apple data at all.
  if (anthropic) return llmClassify(show, anthropic, 'llm-no-itunes');
  return { category: 'unsupported', signal: 'llm-no-itunes' };
}

// Resolve a batch of shows, fetching Apple genres in one pass.
// Returns array of { feedId, feedTitle, category, signal, genre? } in input order.
async function resolveBatch(shows, anthropic) {
  const itunesIds    = [...new Set(shows.map(s => s.itunesId).filter(Boolean).map(String))];
  const appleGenreMap = itunesIds.length ? await fetchAppleGenres(itunesIds) : new Map();

  console.log(`  Apple genre lookup: ${[...appleGenreMap.values()].filter(Boolean).length}/${itunesIds.length} itunesIds resolved`);

  const results = [];
  for (const show of shows) {
    const r = await resolveCategory(show, appleGenreMap, anthropic);
    results.push({ feedId: show.feedId, feedTitle: show.feedTitle, ...r });
  }
  return results;
}

module.exports = { resolveCategory, resolveBatch, fetchAppleGenres, GENRE_MAP, LIVE_CATEGORIES };
