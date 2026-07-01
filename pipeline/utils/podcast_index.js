'use strict';

const crypto = require('crypto');

const BASE_URL = 'https://api.podcastindex.org/api/1.0';

function makeHeaders(apiKey, apiSecret) {
  const epoch = Math.floor(Date.now() / 1000);
  const hash  = crypto.createHash('sha1')
    .update(apiKey + apiSecret + epoch)
    .digest('hex');
  return {
    'X-Auth-Date':   String(epoch),
    'X-Auth-Key':    apiKey,
    'Authorization': hash,
    'User-Agent':    'HiddenPodPipeline/1.0 (podcast discovery research)',
    'Accept':        'application/json'
  };
}

async function piGet(apiKey, apiSecret, path, params = {}, attempt = 1) {
  const url = new URL(BASE_URL + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { headers: makeHeaders(apiKey, apiSecret) });

  if (res.status === 429) {
    if (attempt > 5) throw new Error(`Rate limited after ${attempt} retries on ${path}`);
    const waitMs = Math.min(60000, 2000 * Math.pow(2, attempt - 1)); // 2s, 4s, 8s, 16s, 32s
    process.stderr.write(`  429 rate limit — waiting ${waitMs / 1000}s (attempt ${attempt})...\n`);
    await sleep(waitMs);
    return piGet(apiKey, apiSecret, path, params, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Podcast Index API ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { piGet, sleep };
