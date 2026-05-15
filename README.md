# HiddenPod — Prototype

Podcast discovery prototype with real audio playback.

## Deploy to Vercel

1. Push this repo to GitHub
2. Import at vercel.com/new
3. No build settings needed — Vercel auto-detects
4. Deploy

## How it works

- `/public/index.html` — the app UI
- `/api/audio.js` — serverless function that fetches RSS feed MP3 URLs
- The player streams directly from podcast hosts, starting at minute 20

## Local dev

```bash
npm install -g vercel
vercel dev
```
