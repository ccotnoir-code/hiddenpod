'use strict';

// Parse SRT, VTT, or JSON transcript files into plain text.
// Returns { plainText, wordCount, format } or throws on unrecognized format.

async function fetchTranscript(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HiddenPodPipeline/1.0' }
  });
  if (!res.ok) throw new Error(`Failed to fetch transcript (${res.status}): ${url}`);
  return res.text();
}

// Parse H:MM:SS,mmm or HH:MM:SS,mmm or HH:MM:SS.mmm to fractional seconds
// Handles single-digit hours (e.g. Omny WebVTT uses "0:00:00.240")
function parseTimestampSec(ts) {
  const m = ts.match(/(\d{1,2}):(\d{2}):(\d{2})[,\.](\d{3})/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
}

function parseSRT(text) {
  // Strip sequence numbers, timestamps, HTML tags; join cue text.
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cues = [];
  let inCue = false;
  const timestampRe = /^\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->/;
  for (const line of lines) {
    if (timestampRe.test(line)) { inCue = true; continue; }
    if (inCue) {
      if (line.trim() === '') { inCue = false; continue; }
      cues.push(line.replace(/<[^>]+>/g, '').trim());
    }
  }
  return cues.filter(Boolean).join(' ');
}

// Parse SRT/VTT keeping timestamps: returns [{startSeconds, text}]
function parseSRTWithTimestamps(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cues = [];
  // Allow 1 or 2 digit hours (e.g. Omny uses "0:00:00.240")
  const timestampRe = /^(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})\s*-->/;
  let currentStart = null;
  let currentText = [];
  for (const line of lines) {
    const m = line.match(timestampRe);
    if (m) {
      if (currentStart !== null && currentText.length) {
        cues.push({ startSeconds: currentStart, text: currentText.join(' ') });
      }
      currentStart = parseTimestampSec(m[1]);
      currentText = [];
      continue;
    }
    if (currentStart !== null) {
      if (line.trim() === '') {
        if (currentText.length) {
          cues.push({ startSeconds: currentStart, text: currentText.join(' ') });
          currentStart = null;
          currentText = [];
        }
        continue;
      }
      const clean = line.replace(/<[^>]+>/g, '').trim();
      if (clean) currentText.push(clean);
    }
  }
  if (currentStart !== null && currentText.length) {
    cues.push({ startSeconds: currentStart, text: currentText.join(' ') });
  }
  return cues;
}

function parseVTT(text) {
  // Like SRT but starts with WEBVTT header.
  const withoutHeader = text.replace(/^WEBVTT.*\n+/, '');
  return parseSRT(withoutHeader);
}

// Parse VTT/SRT keeping timestamps — strips WEBVTT header first
function parseVTTWithTimestamps(text) {
  const withoutHeader = text.replace(/^WEBVTT[^\n]*\n+/, '');
  return parseSRTWithTimestamps(withoutHeader);
}

function parseJSON(text) {
  const data = JSON.parse(text);

  // Podcast Index / Spotify format: { segments: [{body: "..."}] }
  if (Array.isArray(data.segments)) {
    return data.segments.map(s => s.body || s.text || '').join(' ');
  }
  // Descript / generic format: { transcript: [{text: "..."}] }
  if (Array.isArray(data.transcript)) {
    return data.transcript.map(s => s.text || s.body || '').join(' ');
  }
  // Whisper JSON: { text: "..." }
  if (typeof data.text === 'string') return data.text;
  // Array of word objects: [{word: "...", start: N}]
  if (Array.isArray(data) && data[0] && 'word' in data[0]) {
    return data.map(w => w.word || '').join(' ');
  }
  throw new Error('Unrecognized JSON transcript shape');
}

function detectFormat(url, rawText) {
  const lower = url.toLowerCase();
  if (lower.includes('.srt') || lower.endsWith('srt')) return 'srt';
  if (lower.includes('.vtt') || lower.endsWith('vtt')) return 'vtt';
  if (lower.includes('.json') || lower.endsWith('json')) return 'json';
  // Sniff content
  const head = rawText.slice(0, 50).trim();
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (/^\d+\s*\n/.test(head)) return 'srt';
  return 'unknown';
}

function toPlainText(url, rawText) {
  const fmt = detectFormat(url, rawText);
  switch (fmt) {
    case 'srt':  return { plainText: parseSRT(rawText),  format: 'srt' };
    case 'vtt':  return { plainText: parseVTT(rawText),  format: 'vtt' };
    case 'json': return { plainText: parseJSON(rawText), format: 'json' };
    default:     throw new Error(`Cannot parse transcript format from: ${url}`);
  }
}

// Pull a ~1500-3000 word window around targetSeconds from the full transcript.
// Since we're working with plain text (no timestamps), we use a word-count window
// centered roughly at the fraction (targetSeconds / totalDurationSeconds) through the text.
function extractWindow(plainText, targetSeconds, totalDurationSeconds, windowWords = 2000) {
  const words = plainText.trim().split(/\s+/);
  const totalWords = words.length;
  if (totalWords === 0) return plainText;

  const fraction = totalDurationSeconds > 0 ? Math.min(targetSeconds / totalDurationSeconds, 1) : 0.25;
  const centerWord = Math.floor(fraction * totalWords);
  const halfWindow = Math.floor(windowWords / 2);
  const start = Math.max(0, centerWord - halfWindow);
  const end   = Math.min(totalWords, centerWord + halfWindow);

  return words.slice(start, end).join(' ');
}

module.exports = { fetchTranscript, toPlainText, extractWindow, parseSRTWithTimestamps, parseVTTWithTimestamps };
