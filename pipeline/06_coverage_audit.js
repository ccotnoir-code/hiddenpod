#!/usr/bin/env node
// pipeline/06_coverage_audit.js
//
// Measures transcript coverage in the active News/Politics corpus on Podcast Index.
// Produces two numbers that matter for HiddenPod's addressable market:
//   (a) what fraction of active News/Politics shows expose a transcript tag
//   (b) what fraction of those tags actually resolve to real content
// Cross-tabulated by hosting platform so we can track Buzzsprout's rollout separately.
//
// Designed for monthly re-runs. Each run appends a dated row to coverage_history.json.
//
// Usage:
//   cd pipeline
//   PODCASTINDEX_API_KEY=xxx PODCASTINDEX_API_SECRET=yyy node 06_coverage_audit.js
//
// Options:
//   --sample N   verify N randomly-sampled transcript URLs (default 250)
//   --no-verify  skip URL verification entirely (faster, tag-presence only)
//   --dry-run    report to console only, do not write history

'use strict';

const fs   = require('fs');
const path = require('path');
const { piGet, sleep } = require('./utils/podcast_index');

const PI_KEY    = process.env.PODCASTINDEX_API_KEY;
const PI_SECRET = process.env.PODCASTINDEX_API_SECRET;
if (!PI_KEY || !PI_SECRET) {
  console.error('ERROR: Set PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET.');
  process.exit(1);
}

const api = (ep, params) => piGet(PI_KEY, PI_SECRET, ep, params);

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const SAMPLE_SIZE = parseInt(args[args.indexOf('--sample') + 1] || '250', 10) || 250;
const NO_VERIFY   = args.includes('--no-verify');
const DRY_RUN     = args.includes('--dry-run');

const HISTORY_PATH = path.join(__dirname, 'coverage_history.json');
const LATEST_PATH  = path.join(__dirname, 'coverage_latest.json');

// 90 days expressed in seconds (Unix timestamp threshold)
const NINETY_DAYS_AGO = Math.floor(Date.now() / 1000) - 90 * 24 * 3600;

// ── Host detection ────────────────────────────────────────────────────────────
// Order matters: more-specific patterns first.
const HOST_PATTERNS = [
  { name: 'Buzzsprout',  re: /buzzsprout\.com/i },
  { name: 'Spreaker',    re: /spreaker\.com/i },
  { name: 'Omny',        re: /omny(content|studio)?\.fm|omnycontent\.com/i },
  { name: 'Transistor',  re: /transistor\.fm/i },
  { name: 'Captivate',   re: /captivate\.fm/i },
  { name: 'Megaphone',   re: /megaphone\.fm/i },
  { name: 'Simplecast',  re: /simplecast\.(com|fm)/i },
  { name: 'Libsyn',      re: /libsyn\.com|libsynpro\.com/i },
  { name: 'Podbean',     re: /podbean\.com/i },
  { name: 'RSS.com',     re: /\brss\.com\b/i },
  { name: 'Podhome',     re: /podhome\.fm/i },
  { name: 'Anchor/Spotify', re: /anchor\.fm|podcastservices\.spotify\.com/i },
  { name: 'Acast',       re: /acast\.com/i },
  { name: 'iHeartRadio', re: /iheart(radio)?\.com/i },
  { name: 'SoundCloud',  re: /soundcloud\.com/i },
  { name: 'Castos',      re: /castos\.com/i },
  { name: 'Podcastics',  re: /podcastics\.com/i },
  { name: 'Podvine',     re: /podvine\.com/i },
];

function detectHost(feedUrl, audioUrl) {
  for (const { name, re } of HOST_PATTERNS) {
    if ((feedUrl && re.test(feedUrl)) || (audioUrl && re.test(audioUrl))) return name;
  }
  return 'Other/Unknown';
}

// ── Category feed enumeration ─────────────────────────────────────────────────
async function fetchCategoryFeeds(catNames) {
  const feedMap = new Map();
  for (const cat of catNames) {
    for (const endpoint of ['/recent/feeds', '/podcasts/trending']) {
      try {
        process.stdout.write(`  ${endpoint} cat=${cat} ... `);
        const data = await api(endpoint, { cat, max: 1000 });
        const feeds = data.feeds || data.items || [];
        process.stdout.write(`${feeds.length} feeds\n`);
        for (const f of feeds) {
          if (!feedMap.has(f.id)) feedMap.set(f.id, f);
        }
      } catch (e) {
        process.stdout.write(`ERROR: ${e.message}\n`);
      }
      await sleep(300);
    }
  }
  return Array.from(feedMap.values());
}

// ── Episode/transcript check ──────────────────────────────────────────────────
// For each feed, fetch up to 5 recent episodes and look for a transcript tag.
// Returns Map<feedId, { hasTag, transcriptUrl, transcriptType, audioUrl }>
// batchSize=1 (sequential) is intentional — free PI tier rate-limits at ~2 req/s sustained.
// At 400ms/call this is ~18 min for 2700 shows; fine for a monthly diagnostic.
async function checkFeedsForTranscripts(feeds, { batchSize = 1, delayMs = 400 } = {}) {
  const results = new Map();

  for (let i = 0; i < feeds.length; i += batchSize) {
    const batch = feeds.slice(i, i + batchSize);

    for (const feed of batch) {
      try {
        const data     = await api('/episodes/byfeedid', { id: feed.id, max: 5 });
        const episodes = data.items || [];
        let found = false;

        for (const ep of episodes) {
          const transcripts   = ep.transcripts || [];
          const transcriptUrl = ep.transcriptUrl || '';
          const audioUrl      = ep.enclosureUrl || '';
          if (transcripts.length > 0 || transcriptUrl) {
            const t = transcripts[0] || {};
            results.set(feed.id, {
              feedId:         feed.id,
              feedTitle:      feed.title,
              feedUrl:        feed.url || '',
              audioUrl,
              hasTag:         true,
              transcriptUrl:  t.url || transcriptUrl,
              transcriptType: (t.type || 'unknown').toLowerCase(),
              pubDate:        ep.datePublished || 0,
            });
            found = true;
            break;
          }
        }
        if (!found) {
          const audioUrl = (episodes[0] || {}).enclosureUrl || '';
          results.set(feed.id, {
            feedId: feed.id, feedTitle: feed.title,
            feedUrl: feed.url || '', audioUrl,
            hasTag: false, transcriptUrl: '', transcriptType: '',
          });
        }
      } catch (e) {
        results.set(feed.id, {
          feedId: feed.id, feedTitle: feed.title,
          feedUrl: feed.url || '', audioUrl: '',
          hasTag: false, transcriptUrl: '', transcriptType: '',
          checkError: e.message,
        });
      }
    }

    const checked = Math.min(i + batchSize, feeds.length);
    if (checked % 50 === 0 || checked === feeds.length) {
      process.stdout.write(`  ${checked}/${feeds.length} checked\r`);
    }
    if (i + batchSize < feeds.length) await sleep(delayMs);
  }

  process.stdout.write('\n');
  return results;
}

// ── URL verification ──────────────────────────────────────────────────────────
// HEAD request first; fall back to GET with Range if HEAD is blocked.
// Returns 'ok' | 'broken' | 'empty' | 'html' | 'timeout' | 'error'
async function verifyUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    let res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'HiddenPodPipeline/1.0 (coverage-audit)' },
    });

    // Some servers don't support HEAD — fall back to range GET
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'HiddenPodPipeline/1.0 (coverage-audit)',
          'Range': 'bytes=0-2047',
        },
      });
    }

    clearTimeout(timer);

    if (res.status === 404 || res.status === 410) return 'broken';
    if (res.status === 403 || res.status === 401) return 'auth_required';
    if (!res.ok) return `http_${res.status}`;

    // For GET responses, spot-check the body
    if (res.headers.get('content-type')?.includes('text/html')) return 'html';
    const cl = parseInt(res.headers.get('content-length') || '0', 10);
    if (cl > 0 && cl < 50) return 'empty';

    return 'ok';
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return 'timeout';
    return 'error';
  }
}

async function verifySample(tagPresentShows, sampleSize) {
  if (tagPresentShows.length === 0) return { sampleSize: 0, results: {} };

  // Random shuffle + take N
  const shuffled = [...tagPresentShows].sort(() => Math.random() - 0.5);
  const sample   = shuffled.slice(0, Math.min(sampleSize, shuffled.length));

  console.log(`\nVerifying ${sample.length} transcript URLs (random sample)...`);

  const outcomes = {};
  const BATCH = 20;
  for (let i = 0; i < sample.length; i += BATCH) {
    const batch = sample.slice(i, i + BATCH);
    await Promise.all(batch.map(async (show) => {
      const outcome = await verifyUrl(show.transcriptUrl);
      outcomes[show.feedId] = { feedTitle: show.feedTitle, url: show.transcriptUrl, outcome };
    }));
    process.stdout.write(`  ${Math.min(i + BATCH, sample.length)}/${sample.length} verified\r`);
    if (i + BATCH < sample.length) await sleep(200);
  }
  process.stdout.write('\n');

  // Summarise
  const tally = {};
  for (const { outcome } of Object.values(outcomes)) {
    tally[outcome] = (tally[outcome] || 0) + 1;
  }

  return { sampleSize: sample.length, tally, detail: outcomes };
}

// ── Per-host cross-tab ────────────────────────────────────────────────────────
function buildHostTable(allShows, tagPresent, verifyOutcomes) {
  const hosts = {};

  const ensure = (h) => {
    if (!hosts[h]) hosts[h] = { total: 0, withTag: 0, verified_ok: 0, verified_broken: 0, verified_other: 0, verifiedSampleN: 0 };
    return hosts[h];
  };

  for (const show of allShows) {
    const h = detectHost(show.feedUrl, show.audioUrl);
    ensure(h).total++;
    if (show.hasTag) ensure(h).withTag++;
  }

  // Layer in verification outcomes
  for (const [feedId, v] of Object.entries(verifyOutcomes || {})) {
    const show = tagPresent.find(s => String(s.feedId) === String(feedId));
    if (!show) continue;
    const h = detectHost(show.feedUrl, show.audioUrl);
    ensure(h).verifiedSampleN++;
    if (v.outcome === 'ok') ensure(h).verified_ok++;
    else if (v.outcome === 'broken') ensure(h).verified_broken++;
    else ensure(h).verified_other++;
  }

  // Compute rates
  const table = {};
  for (const [host, d] of Object.entries(hosts)) {
    table[host] = {
      total:           d.total,
      withTag:         d.withTag,
      tagCoverageRate: d.total > 0 ? +(d.withTag / d.total).toFixed(3) : 0,
      verifiedSampleN: d.verifiedSampleN,
      verifiedOkRate:  d.verifiedSampleN > 0
        ? +(d.verified_ok / d.verifiedSampleN).toFixed(3) : null,
    };
  }

  return table;
}

// ── Persistence ───────────────────────────────────────────────────────────────
function appendHistory(row) {
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')).history || []; } catch (_) {}
  }
  history.push(row);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify({ history }, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== HiddenPod — Transcript Coverage Audit (Step 6) ===');
  console.log(`Date: ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Sample size for URL verification: ${NO_VERIFY ? 'SKIPPED' : SAMPLE_SIZE}\n`);

  // 1. Enumerate all News + Politics feeds from Podcast Index
  console.log('1. Fetching News + Politics feeds from Podcast Index...');
  const allFeeds = await fetchCategoryFeeds(['News', 'Politics']);
  console.log(`   Raw unique feeds: ${allFeeds.length}`);

  // 2. Filter to 90-day active
  const activeFeeds = allFeeds.filter(f =>
    (f.newestItemPublishTime || f.lastUpdateTime || 0) >= NINETY_DAYS_AGO
  );
  console.log(`   Active (published ≥90 days): ${activeFeeds.length}`);

  // 3. Check each show for transcript tag presence via episode endpoint
  console.log('\n2. Checking active feeds for transcript tags...');
  const txResults = await checkFeedsForTranscripts(activeFeeds);
  const allResults   = Array.from(txResults.values());
  const tagPresent   = allResults.filter(r => r.hasTag);
  const tagAbsent    = allResults.filter(r => !r.hasTag);
  const errored      = allResults.filter(r => r.checkError);

  const tagCoverageRate = allResults.length > 0
    ? tagPresent.length / allResults.length : 0;

  console.log(`\n   Total checked:       ${allResults.length}`);
  console.log(`   Transcript tag:      ${tagPresent.length} (${(tagCoverageRate * 100).toFixed(1)}%)`);
  console.log(`   No transcript:       ${tagAbsent.length}`);
  console.log(`   API errors:          ${errored.length}`);

  // Breakdown by transcript type
  const byType = {};
  for (const r of tagPresent) {
    byType[r.transcriptType] = (byType[r.transcriptType] || 0) + 1;
  }
  console.log('\n   Tag breakdown by type:');
  Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => {
    console.log(`     ${t.padEnd(22)} ${n}`);
  });

  // 4. Verify a random sample of transcript URLs
  let verifyResult = { sampleSize: 0, tally: {}, detail: {} };
  if (!NO_VERIFY && tagPresent.length > 0) {
    verifyResult = await verifySample(tagPresent, SAMPLE_SIZE);
    const ok      = verifyResult.tally['ok'] || 0;
    const broken  = verifyResult.tally['broken'] || 0;
    const total   = verifyResult.sampleSize;
    const verifiedRate = total > 0 ? ok / total : 0;
    console.log(`\n   URL verification (n=${total}):`);
    Object.entries(verifyResult.tally || {}).sort((a, b) => b[1] - a[1]).forEach(([outcome, n]) => {
      console.log(`     ${outcome.padEnd(18)} ${n} (${(n / total * 100).toFixed(1)}%)`);
    });
    console.log(`\n   ✓ Estimated real-content coverage: ${(verifiedRate * tagCoverageRate * 100).toFixed(1)}% of all active N/P shows`);
  }

  // 5. Detect hosting platform for all shows + cross-tab
  console.log('\n3. Detecting hosting platform + cross-tabulating...');
  const hostTable = buildHostTable(allResults, tagPresent, verifyResult.detail);

  // Print sorted by total desc
  const sortedHosts = Object.entries(hostTable).sort((a, b) => b[1].total - a[1].total);
  console.log('\n   Host                   Total  WithTag  TagRate  VerN  VerOkRate');
  console.log('   ' + '-'.repeat(68));
  for (const [host, d] of sortedHosts) {
    const tagPct  = (d.tagCoverageRate * 100).toFixed(0).padStart(5) + '%';
    const verN    = String(d.verifiedSampleN || 0).padStart(4);
    const verRate = d.verifiedOkRate !== null
      ? (d.verifiedOkRate * 100).toFixed(0).padStart(4) + '%'
      : '   —';
    console.log(
      `   ${host.padEnd(22)} ${String(d.total).padStart(5)}  ${String(d.withTag).padStart(7)}  ${tagPct}  ${verN}  ${verRate}`
    );
  }

  // 6. Build result row for persistence
  const verifiedOkRate = verifyResult.sampleSize > 0
    ? (verifyResult.tally['ok'] || 0) / verifyResult.sampleSize : null;

  const resultRow = {
    date:              new Date().toISOString().slice(0, 10),
    runAt:             new Date().toISOString(),
    totalActiveShows:  allResults.length,
    withTranscriptTag: tagPresent.length,
    tagCoverageRate:   +tagCoverageRate.toFixed(4),
    transcriptTypes:   byType,
    verificationSampleSize: verifyResult.sampleSize,
    verificationTally:      verifyResult.tally,
    verifiedOkRate:         verifiedOkRate !== null ? +verifiedOkRate.toFixed(4) : null,
    effectiveCoverageRate:  verifiedOkRate !== null
      ? +(tagCoverageRate * verifiedOkRate).toFixed(4) : null,
    byHost: hostTable,
  };

  // Print broken URLs from sample for debugging
  const broken = Object.values(verifyResult.detail || {}).filter(v => v.outcome !== 'ok');
  if (broken.length > 0) {
    console.log(`\n   Broken/failed URLs in sample (${broken.length}):`);
    broken.slice(0, 15).forEach(v => {
      console.log(`     [${v.outcome}] ${v.feedTitle?.slice(0, 40)} — ${v.url?.slice(0, 70)}`);
    });
    if (broken.length > 15) console.log(`     ... and ${broken.length - 15} more (see coverage_latest.json)`);
  }

  // 7. Persist
  if (!DRY_RUN) {
    fs.writeFileSync(LATEST_PATH, JSON.stringify(resultRow, null, 2));
    appendHistory(resultRow);
    console.log(`\nResults saved → coverage_latest.json`);
    console.log(`History row appended → coverage_history.json`);
  } else {
    console.log('\n[dry-run] No files written.');
  }

  // 8. Final summary
  console.log('\n=== SUMMARY ===');
  console.log(`  Active News/Politics shows (90d):   ${allResults.length}`);
  console.log(`  Transcript tag present:             ${tagPresent.length} (${(tagCoverageRate * 100).toFixed(1)}%)`);
  if (verifiedOkRate !== null) {
    console.log(`  Of those — URLs actually resolve:   ${(verifiedOkRate * 100).toFixed(1)}% (n=${verifyResult.sampleSize})`);
    console.log(`  Effective verified coverage:        ${(tagCoverageRate * verifiedOkRate * 100).toFixed(1)}% of active N/P shows`);
  }
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
