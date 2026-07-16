#!/usr/bin/env python3
# pipeline/07_production_score.py
#
# Production Score v1 — universal show quality signal requiring no transcript.
#
# Six sub-components (draft weights, subject to validation):
#   Audio Technical   30% — LUFS loudness + noise floor (DSP)
#   Consistency       20% — carry from existing PodSignal score
#   Episode Vitality  15% — carry from existing PodSignal score
#   Pacing & Flow     15% — silence ratio + RMS energy variance (DSP)
#   Metadata Complete 12% — description depth + ID3/artwork
#   Feed Compliance    8% — Podcasting 2.0 namespace adoption
#
# Audio sampling: 3 × 30-second slices via ffmpeg (offset ~2min, ~15min, ~30min).
# No full-episode download. DSP runs on slices only.
#
# Usage:
#   pip install -r requirements.txt   (first time)
#   python 07_production_score.py [--dry-run] [--limit N] [--feed-id ID]

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Optional, List, Tuple

# Add static_ffmpeg to PATH if available (local dev fallback; CI installs ffmpeg via apt)
try:
    import static_ffmpeg
    static_ffmpeg.add_paths()
except ImportError:
    pass

# ── Optional DSP imports ─────────────────────────────────────────────────────
try:
    import numpy as np
    import librosa
    import pyloudnorm as pyln
    import soundfile as sf
    HAS_DSP = True
except ImportError:
    HAS_DSP = False
    print("WARNING: librosa/pyloudnorm/soundfile not installed — DSP sub-components will score 0")
    print("         Run: pip install -r requirements.txt")

# ── Optional metadata imports ─────────────────────────────────────────────────
try:
    import feedparser
    from bs4 import BeautifulSoup
    import mutagen
    HAS_META = True
except ImportError:
    HAS_META = False
    print("WARNING: feedparser/beautifulsoup4/mutagen not installed — metadata sub-components will score 0")

# ── Weights (must sum to 1.0) ─────────────────────────────────────────────────
W_AUDIO_TECH   = 0.30
W_CONSISTENCY  = 0.20
W_VITALITY     = 0.15
W_PACING       = 0.15
W_METADATA     = 0.12
W_COMPLIANCE   = 0.08

SLICE_PROPORTIONS = [0.10, 0.50, 0.90]  # 10/50/90% of episode length
SLICE_MIN_OFFSET_S = 30                  # always skip first 30s (cold opens)
SLICE_DURATION_S   = 30
SLICE_MIN_EPISODE_S = 90                 # skip DSP entirely for episodes < 90s
SILENCE_THRESHOLD_DB  = -40.0         # dBFS below which a frame is considered silent
SILENCE_MAX_RATIO     = 0.03          # >3% silence → score penalty
TARGET_LUFS_STEREO    = -16.0
TARGET_LUFS_MONO      = -19.0
LUFS_TOLERANCE        = 2.0           # ±2 LUFS → loudness compliance = 100
LUFS_FLOOR_DELTA      = 12.0         # ±12 LUFS → loudness compliance = 0 (was 6; softened to not hard-zero quiet-but-clean shows)
# Within Audio Technical (30% of total), two sub-signals:
W_AUDIO_LOUDNESS = 0.40   # loudness compliance: distance from broadcast LUFS target
W_AUDIO_QUALITY  = 0.60   # recording quality: noise floor / how clean the capture is

SCORED_PATH   = Path(__file__).parent / 'scored_shows.json'
ALGO_VERSION  = 'production_score_v1'


def clamp(v, lo=0, hi=100):
    return max(lo, min(hi, v))


# ── Audio helpers ─────────────────────────────────────────────────────────────

def compute_slice_offsets(episode_duration_s: int) -> List[int]:
    """Proportional offsets at 10/50/90% of episode length.
    Returns empty list if the episode is too short to sample reliably."""
    if episode_duration_s < SLICE_MIN_EPISODE_S:
        return []
    max_offset = max(0, episode_duration_s - SLICE_DURATION_S - 5)
    offsets = []
    seen: set = set()
    for p in SLICE_PROPORTIONS:
        o = max(SLICE_MIN_OFFSET_S, min(int(episode_duration_s * p), max_offset))
        if o not in seen:
            offsets.append(o)
            seen.add(o)
    return offsets


def fetch_audio_slice(audio_url: str, offset_s: int, duration_s: int, tmp_dir: str) -> Optional[str]:
    """Download a time slice via ffmpeg. Returns path to WAV file or None on failure."""
    out_path = os.path.join(tmp_dir, f'slice_{offset_s}.wav')
    cmd = [
        'ffmpeg', '-y',
        '-ss', str(offset_s),
        '-i', audio_url,
        '-t', str(duration_s),
        '-f', 'wav',
        '-ar', '22050',
        '-ac', '1',           # mono for analysis
        '-loglevel', 'error',
        out_path,
    ]
    try:
        result = subprocess.run(cmd, timeout=45, capture_output=True)
        if result.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
            return out_path
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return None


def score_audio_technical(slices: List[str]) -> Tuple[int, int, int]:
    """Two sub-signals combined into one Audio Technical score (0–100).

    Returns (audio_tech, loudness_compliance, recording_quality) for logging.
    Loudness compliance: distance from broadcast LUFS target (40% weight).
    Recording quality:   noise floor cleanliness (60% weight).
    """
    if not HAS_DSP or not slices:
        return 0, 0, 0

    lufs_vals, noise_floors = [], []
    meter = pyln.Meter(22050)

    for path in slices:
        try:
            y, sr = librosa.load(path, sr=22050, mono=True)
            if len(y) < sr:
                continue

            loud = meter.integrated_loudness(y.astype(np.float64))
            if math.isfinite(loud):
                lufs_vals.append(loud)

            frame_rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
            if len(frame_rms) > 0:
                threshold = np.percentile(frame_rms, 5)
                noise_floors.append(20 * np.log10(max(threshold, 1e-9)))
        except Exception:
            continue

    if not lufs_vals:
        return 0, 0, 0

    # ── Loudness compliance (40% of audio_tech) ───────────────────────────────
    avg_lufs = float(np.mean(lufs_vals))
    delta = abs(avg_lufs - TARGET_LUFS_MONO)
    if delta <= LUFS_TOLERANCE:
        loudness_score = 100
    elif delta >= LUFS_FLOOR_DELTA:
        loudness_score = 0
    else:
        loudness_score = int(100 * (1 - (delta - LUFS_TOLERANCE) / (LUFS_FLOOR_DELTA - LUFS_TOLERANCE)))

    # ── Recording quality / noise floor (60% of audio_tech) ──────────────────
    # -60 dBFS or quieter = 100 (clean studio), -30 dBFS = 0 (noisy).
    # Median across slices: robust to one outlier segment (e.g. phone interview)
    # without ignoring persistent problems (2-of-3 bad slices still gives bad median).
    median_noise = float(np.median(noise_floors)) if noise_floors else -30.0
    quality_score = clamp(int((-30.0 - median_noise) / 30.0 * 100))

    audio_tech = clamp(int(loudness_score * W_AUDIO_LOUDNESS + quality_score * W_AUDIO_QUALITY))
    return audio_tech, loudness_score, quality_score


def score_pacing(slices: List[str]) -> int:
    """Silence ratio + RMS energy variance. Returns 0–100."""
    if not HAS_DSP or not slices:
        return 0

    silence_ratios, rms_vars = [], []

    for path in slices:
        try:
            y, sr = librosa.load(path, sr=22050, mono=True)
            if len(y) < sr:
                continue

            frame_rms  = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
            thresh_lin = 10 ** (SILENCE_THRESHOLD_DB / 20)
            silent     = np.sum(frame_rms < thresh_lin)
            ratio      = float(silent) / len(frame_rms)
            silence_ratios.append(ratio)
            rms_vars.append(float(np.std(frame_rms)))
        except Exception:
            continue

    if not silence_ratios:
        return 0

    avg_silence = float(np.mean(silence_ratios))
    # >3% silence → penalty; 0% → 100; 10%+ → 0
    if avg_silence <= SILENCE_MAX_RATIO:
        silence_score = 100
    elif avg_silence >= 0.10:
        silence_score = 0
    else:
        silence_score = int(100 * (1 - (avg_silence - SILENCE_MAX_RATIO) / (0.10 - SILENCE_MAX_RATIO)))

    # RMS variance: some variance is good (dynamic delivery); very low = monotone risk.
    # Flagged in architecture doc as needing validation against anchor-style shows.
    # Weighted lightly (35%) pending that validation.
    avg_var = float(np.mean(rms_vars)) if rms_vars else 0.0
    # Empirical scale: 0.01 = good variance, 0.001 = low, 0.05+ = high
    var_score = clamp(int(min(avg_var / 0.01, 1.0) * 100))

    return clamp(int(silence_score * 0.65 + var_score * 0.35))


# ── Metadata helpers ──────────────────────────────────────────────────────────

def score_metadata(feed_url: str, audio_url: str) -> int:
    """Show notes depth + ID3/artwork integrity. Returns 0–100."""
    if not HAS_META:
        return 0

    desc_score    = 0
    artwork_score = 0

    try:
        feed = feedparser.parse(feed_url)
        entries = feed.entries
        if entries:
            ep       = entries[0]
            raw_desc = ep.get('summary', '') or ep.get('description', '')
            text     = BeautifulSoup(raw_desc, 'html.parser').get_text()
            links    = len(BeautifulSoup(raw_desc, 'html.parser').find_all('a'))
            if len(text) >= 500:
                desc_score = 70
                desc_score += min(links * 5, 30)   # bonus for links, cap at 30
            else:
                desc_score = clamp(int(len(text) / 500 * 70))
    except Exception:
        pass

    # ID3/artwork: HEAD the audio URL and check mutagen can read basic tags
    try:
        if audio_url:
            req = urllib.request.Request(audio_url, method='HEAD',
                                         headers={'User-Agent': 'HiddenPod/1.0'})
            urllib.request.urlopen(req, timeout=8)
            # If HEAD succeeds the file is reachable; full ID3 check needs download
            # — defer to a future pass; award partial credit for reachability
            artwork_score = 40
    except Exception:
        artwork_score = 0

    return clamp(int(desc_score * 0.70 + artwork_score * 0.30))


def score_compliance(feed_url: str) -> int:
    """Podcasting 2.0 namespace adoption + chapter marker support. Returns 0–100."""
    if not HAS_META:
        return 0

    score = 0
    try:
        feed = feedparser.parse(feed_url)

        # Check raw feed XML via feed.feed.tags or namespaces
        raw = getattr(feed, 'feed', {})

        # Podcasting 2.0 tags in parsed entries
        p2_tags = ['podcast_transcript', 'podcast_chapters', 'podcast_value',
                   'podcast_soundbite', 'podcast_person', 'podcast_location']
        found = sum(1 for tag in p2_tags
                    if any(tag in str(e) for e in (feed.entries or [])))
        if found:
            score += min(found * 20, 60)

        # <itunes:summary> / <itunes:explicit> as basic hygiene
        entries = feed.entries
        if entries:
            ep = entries[0]
            if ep.get('itunes_explicit'):
                score += 20   # labelled
            if ep.get('itunes_duration'):
                score += 20   # duration tag present
    except Exception:
        pass

    return clamp(score)


# ── Carry-over helpers ────────────────────────────────────────────────────────

def extract_existing_score(show: dict, key: str) -> int:
    """Pull an integer score from the existing PodSignal scores object."""
    val = show.get('scores', {}).get(key, 0)
    if isinstance(val, dict):
        return int(val.get('score', 0))
    return int(val or 0)


# ── Main ──────────────────────────────────────────────────────────────────────

def compute_production_score(show: dict, dry_run: bool = False) -> dict:
    audio_url = (show.get('latestEpisode') or {}).get('audioUrl', '')
    feed_url  = show.get('feedUrl', '')

    # Sub-components that don't need audio
    c_consistency = extract_existing_score(show, 'consistency')
    c_vitality    = extract_existing_score(show, 'vitality')
    c_metadata    = score_metadata(feed_url, audio_url) if not dry_run else 0
    c_compliance  = score_compliance(feed_url) if not dry_run else 0

    # DSP sub-components — download slices
    c_audio_tech = 0
    c_loudness   = 0
    c_quality    = 0
    c_pacing     = 0
    slices_fetched = 0

    if HAS_DSP and audio_url and not dry_run:
        episode_duration_s = (show.get('latestEpisode') or {}).get('durationSeconds', 0) or 0
        slice_offsets = compute_slice_offsets(episode_duration_s)
        with tempfile.TemporaryDirectory() as tmp:
            slices = []
            for offset in slice_offsets:
                path = fetch_audio_slice(audio_url, offset, SLICE_DURATION_S, tmp)
                if path:
                    slices.append(path)
                    slices_fetched += 1

            if slices:
                c_audio_tech, c_loudness, c_quality = score_audio_technical(slices)
                c_pacing = score_pacing(slices)

    total = (
        c_audio_tech  * W_AUDIO_TECH  +
        c_consistency * W_CONSISTENCY +
        c_vitality    * W_VITALITY    +
        c_pacing      * W_PACING      +
        c_metadata    * W_METADATA    +
        c_compliance  * W_COMPLIANCE
    )

    return {
        'totalScore':        round(total),
        'audioTechnical':    c_audio_tech,
        'loudnessCompliance': c_loudness,
        'recordingQuality':  c_quality,
        'consistency':       c_consistency,
        'vitality':          c_vitality,
        'pacingFlow':        c_pacing,
        'metadataComplete':  c_metadata,
        'feedCompliance':    c_compliance,
        'slicesFetched':     slices_fetched,
        'algorithmVersion':  ALGO_VERSION,
        'scoredAt':          time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }


def main():
    parser = argparse.ArgumentParser(description='Compute Production Score for all shows in scored_shows.json')
    parser.add_argument('--dry-run', action='store_true', help='Skip audio/metadata fetching; report structure only')
    parser.add_argument('--limit',   type=int, default=None, help='Process only first N shows')
    parser.add_argument('--feed-id', type=int, default=None, help='Process a single show by feedId')
    args = parser.parse_args()

    data  = json.loads(SCORED_PATH.read_text())
    shows = data['scored']

    if args.feed_id:
        shows = [s for s in shows if s['feedId'] == args.feed_id]
        if not shows:
            print(f'feedId {args.feed_id} not found in scored_shows.json')
            sys.exit(1)
    elif args.limit:
        shows = shows[:args.limit]

    print(f'=== HiddenPod — Production Score (Step 7) ===')
    print(f'Processing {len(shows)} shows | DSP: {"yes" if HAS_DSP else "no (install requirements)"} | dry-run: {args.dry_run}\n')

    updated = 0
    for i, show in enumerate(shows):
        title = show.get('feedTitle', show.get('feedId'))
        print(f'  [{i+1}/{len(shows)}] {str(title)[:50]}', end=' ', flush=True)

        try:
            ps = compute_production_score(show, dry_run=args.dry_run)
            show['productionScore'] = ps
            updated += 1
            print(f'→ {ps["totalScore"]} (audio:{ps["audioTechnical"]} loud:{ps["loudnessCompliance"]} qual:{ps["recordingQuality"]} meta:{ps["metadataComplete"]} comply:{ps["feedCompliance"]} slices:{ps["slicesFetched"]})')
        except Exception as e:
            print(f'→ ERROR: {e}')

        # Gentle pacing — don't hammer feeds
        if not args.dry_run and i < len(shows) - 1:
            time.sleep(0.5)

    # Write back atomically
    if not args.dry_run:
        tmp_path = SCORED_PATH.with_suffix('.json.tmp')
        tmp_path.write_text(json.dumps(data, indent=2))
        tmp_path.replace(SCORED_PATH)
        print(f'\nUpdated {updated}/{len(shows)} shows → pipeline/scored_shows.json')
    else:
        print(f'\nDry run complete — no files written.')


if __name__ == '__main__':
    main()
