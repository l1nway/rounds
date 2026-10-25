# Mini App

The editor opened from the bot's `web_app` button: `<pages url>?job=<id>`. React (JS) + Vite SPA, plain CSS, `arch-features.md` layout under `src/`. API contract: `backend/rounds/README.md` (coordinates 0..1 of the display-oriented frame, times in seconds with ms precision).

Run locally without Telegram or the backend: `npm install`, `npm run mock` (needs `ffmpeg` / `ffprobe` on PATH; writes a 32 s test video, its filmstrip and `job.json` into the gitignored `public/mock/`), then `npm run dev` with `VITE_API_URL` unset. Scenarios by query: `?job=ready` (default), `ingest` (two polls, then ready), `done`, `failed`, `rendering` (prefilled from a sample request), `missing` (load error), `reject` (the render POST fails). `window.mockRequests` holds every submitted body, `window.mockHaptics` every haptic call.

## Relative base

`base: './'` in `vite.config.js`: the build works under any GitHub Pages project subpath and from `vite preview` without knowing the repo name. Safe because the app has one route; state lives in the query (`?job=`), and Telegram appends its launch data to the hash (`#tgWebAppData=…`), which the app never reads (it uses `Telegram.WebApp.initData`).

## Telegram script

`index.html` loads `https://telegram.org/js/telegram-web-app.js?64` in `<head>` before every other script, as core.telegram.org/bots/webapps prescribes (checked 2026-10-25; the `?64` cache-buster is the one the page shows, update it from there). It is render-blocking on purpose: `window.Telegram.WebApp` must exist before `main.jsx` calls `setupTelegram()` and `ready()`. Cost: desktop FCP 204–352 ms locally against the 200 ms budget (Perf harness). Do not make it `async` or move it below the module script without moving `setupTelegram()` behind its `load`. In mock mode it still loads; `src/services/mock.js` then replaces `window.Telegram`.

## Perf harness

`scripts/perf.mjs` is a symlink to `claude-rules/tools/perf.mjs`; `perf.config.mjs` serves `vite preview` and measures `/?job=ready`. `npm run perf` builds with the current env, so run it with `VITE_API_URL` unset and after `npm run mock`: the measured page is the mock build (a production build without the mock shows only the "open it from the bot" notice). A local build copies `public/mock/` (about 3.7 MB) into `dist/`; CI has no mock folder.

The engine needs a git repo (`git rev-parse` for the journal row) and fails at the end until the repo is initialized. Until then there is no `PERF.md` journal yet. The first measurement (2026-10-25, mock build, Edge 154, run from a scratch git folder with this config) passed Entry 73.5 KB, M TBT 50, M long 100, CLS 0.000, M INP 48, Page 171 KB, LH 97, A11y / BP / SEO 100. Over budget, each an owner decision:

- M LCP 2.9–4.1 s: the LCP element is the `<video>` first frame of a 3.6 MB proxy over slow 4G. The video is the content.
- D FCP 204–352 ms: the render-blocking Telegram script (above).
- Idle 78–201 ms (mobile only, 0 style / layout): the browser's media loading while the proxy keeps downloading (`preload='auto'`); script time in that window is 1–2 ms, and blocking the proxy drops it to about 30 ms. `preload='metadata'` would cut it but make every scrub wait for range requests.
