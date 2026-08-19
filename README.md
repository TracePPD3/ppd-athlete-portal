# PPD Athlete Portal

A unified shell (Next.js App Router) for Pure Player Development's training
tools. The first tool is the **Swing Analyzer**; more (e.g. Baseball IQ Trainer)
plug in as new sections without a rewrite.

- **Home** (`/`) — lists available tools.
- **Swing Analyzer** (`/swing-analyzer`) — upload a swing clip, get an AI Load /
  Unload coaching report.
- **API** (`/api/swing-analyzer/analyze`) — Node.js route: upload → FFmpeg frames
  → Claude vision → report.

Mobile-first responsive, PPD-branded (purple / black / silver / white), and an
installable **PWA** (Add to Home Screen → full-screen standalone).

## Structure

```
app/
  layout.js                     # portal shell (header, PWA metadata, SW register)
  page.js                       # home: tool list
  manifest.js                   # -> /manifest.webmanifest
  swing-analyzer/page.js        # client UI: click + drag-drop upload, report
  api/swing-analyzer/analyze/route.js   # routing: upload -> pipeline
lib/
  frames.js                     # video -> frames (FFmpeg)   [reused, unchanged logic]
  analyze.js                    # frames -> report (Claude)   [reused, unchanged logic]
  prompt.js                     # the Load/Unload rubric      [reused, unchanged logic]
components/ServiceWorkerRegister.js
public/  sw.js, icon-*.png, apple-touch-icon.png
```

The three `lib/` modules are the same modular logic from the original Express
app, converted to ESM only. Adding a tool = a new route + section + (optionally)
a new `lib/` module.

## Run locally

```bash
cd portal
npm install
cp .env.example .env.local     # paste your ANTHROPIC_API_KEY
npm run dev                     # http://localhost:3000
```

## Deploy to Render (long-lived Node server — FFmpeg-friendly)

This is **not** Vercel: FFmpeg + a persistent process need a standard web
service, which the included `render.yaml` describes.

1. Push this `portal/` directory to a Git repo (GitHub/GitLab).
2. In Render: **New → Blueprint**, point at the repo (it reads `render.yaml`).
   - Build: `npm install && npm run build`
   - Start: `npm start` (`next start`, binds to Render's `$PORT`)
3. Set environment variables on the service:
   - `ANTHROPIC_API_KEY` = your key (**secret**)
   - `ANTHROPIC_MODEL` *(optional)* — defaults to `claude-opus-5`
4. Deploy. Render gives you a permanent `https://<name>.onrender.com` URL.

Manual (non-blueprint) path: **New → Web Service** → Runtime **Node**, Build
`npm install && npm run build`, Start `npm start`, then add the env vars.

### Notes
- FFmpeg ships via the `ffmpeg-static` npm package (no apt / Docker needed);
  `next.config.mjs` marks it `serverExternalPackages` so its binary path
  resolves at runtime.
- The API route runs on the Node.js runtime (`export const runtime = "nodejs"`).
- Uploads capped at 30 MB; frames sampled ~2 fps, capped at 24; uploaded videos
  deleted right after processing. Nothing is stored.
- **Icons in `public/` are generated placeholders** (purple with a "PPD"
  wordmark) — swap in a real logo when you have one.
- `.env.local` is git-ignored; never commit your key.
