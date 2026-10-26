# Mini App

The editor opened from the bot's `web_app` button: `<pages url>?job=<id>`. React (JS) + Vite SPA, plain CSS, `arch-features.md` layout under `src/`. API contract: `backend/rounds/README.md` (coordinates 0..1 of the display-oriented frame, times in seconds with ms precision).

Run locally without Telegram or the backend: `npm install`, `npm run mock` (needs `ffmpeg` / `ffprobe` on PATH; writes a 32 s test video, its filmstrip and `job.json` into the gitignored `public/mock/`), then `npm run dev` with `VITE_API_URL` unset. Scenarios by query: `?job=ready` (default), `ingest` (two polls, then ready), `done`, `failed`, `rendering` (prefilled from a sample request), `missing` (load error), `reject` (the render POST fails), `nolift` (the outline request fails, Lift falls back to points), `broken` (a failed ingest with its reason). `window.mockRequests` holds every submitted body, `window.mockHaptics` every haptic call.

## Relative base

`base: './'` in `vite.config.js`: the build works under any GitHub Pages project subpath and from `vite preview` without knowing the repo name. Safe because the app has one route; state lives in the query (`?job=`), and Telegram appends its launch data to the hash (`#tgWebAppData=…`), which the app never reads (it uses `Telegram.WebApp.initData`).

## Build target

`build.target` is `safari18` + `chrome130`: the owner uses the Mini App only in Telegram for iOS 18+ (WKWebView, the Safari 18 engine) and Telegram Desktop on Windows (lib_webview, which picks WebView2, evergreen Edge Chromium, and falls back to EdgeHTML only without the WebView2 runtime: `webview/platform/win/webview_win.cpp` in desktop-app/lib_webview, read 2026-10-25). Nothing else needs to work, so no syntax lowering, no CSS prefixes, and `modulePreload.polyfill` is off (the app has no preloaded chunks anyway). Raising the target saved 0.3 KB gzip: the bundle was already modern; its weight was React DOM (Preact, below).

## Preact

The app runs on Preact 10 with the React API of `preact/compat` (owner decision 2026-10-25, overrides react.md): the production entry chunk went from 75.5 to 15.0 KB gzip (15.5 in the mock build), which was the "Reduce unused JavaScript" item of PageSpeed. The source keeps importing `react` and `react-dom/client`; `resolve.alias` in `vite.config.js` points them at `preact/compat` and `preact/compat/client`, and Vite's own oxc transform compiles JSX for `preact` (no `@vitejs/plugin-react`, so no Fast Refresh: an edit reloads the page in dev). The `react` import is deliberate: oxlint's `react` plugin recognizes hooks by their import source, and with `preact/hooks` imports it reported every `ref.current =` as a mutation of a hook value (`react(immutability)`). `@preact/preset-vite` was not used: its peer range rejected Vite 8 (npm ERESOLVE, 2026-10-25).

Differences that matter here:

- No `useEffectEvent` (not exported by `preact/compat` 10.29): `useMainButton` keeps the handler in a ref updated by a layout effect (`services/README.md`, Main button).
- No `StrictMode` (a Fragment in compat), so effects are not double-invoked in dev.
- Renders are batched to a microtask even for discrete events (React flushes a click or a keydown synchronously): code that reads the DOM right after a `dispatch` sees the old render. Nothing in the app does; a test must wait a tick.
- `onChange` of a text input is mapped to `input` by compat (as in React); the app has only a checkbox, where both fire on click.

Checked on the mock build in headless Edge (2026-10-25): load, tap to add a point, option switch, play / pause, arrow keys on a trim handle, submit through the mock MainButton with the current draft; no console errors.

## Inline CSS

The `inline-css` plugin in `vite.config.js` replaces the built `<link rel="stylesheet">` in `index.html` with a `<style>` of the same file and drops the file (web.md: no stylesheet request blocks the first paint). Only CSS linked from the page is inlined; a CSS file of a lazy chunk (`mock.css` in a mock build) stays a file, since its chunk links it at runtime. The page grows to 3 KB gzip and has the same 10-minute cache as the CSS had.

## Telegram script

`index.html` loads `https://telegram.org/js/telegram-web-app.js?64` in `<head>` before every other script, as core.telegram.org/bots/webapps prescribes (checked 2026-10-25; the `?64` cache-buster is the one the page shows, update it from there). It is render-blocking on purpose: `window.Telegram.WebApp` must exist before `main.jsx` calls `setupTelegram()` and `ready()`. Cost: desktop FCP 204–352 ms locally against the 200 ms budget (Perf harness). Do not make it `async` or move it below the module script without moving `setupTelegram()` behind its `load`. In mock mode it still loads; `src/services/mock.js` then replaces `window.Telegram`.

## Opening on iOS

What a phone shows when the Mini App opens, frame by frame from the owner's recording (`IMG_0406.MP4`, 2026-10-26, iPhone, Telegram iOS, dark theme, a `done` job; 60 fps, measured with ffmpeg + a row probe). Read it before "fixing" motion that is not ours.

- 0.25–1.7 s: Telegram's own sheet with its grey placeholder while the page, `telegram-web-app.js` and the entry chunk load and `ready()` runs (Telegram script, above). Nothing of ours is on screen yet.
- 1.8–2.15 s: the sheet expands to fullscreen (`requestFullscreen()` on phones, `services/README.md`, Telegram setup). The whole page, Telegram's own header pill and the MainButton move up together by about 50 px on an ease-out curve: a native animation, not a layout shift of ours (all rows move by the same amount within 3 px of scaling). Only opening in fullscreen directly would remove it, which a `web_app` keyboard button cannot ask for.
- 2.15–4.0 s: the job request (`GET /jobs/{id}` to Modal). Its 2 s are the network and the backend (reasoned, not measured: a Modal container waking from zero would explain it), not the page.
- 4.0 s, before 2026-10-26: the MainButton slid out and back in (editor remount, `services/README.md`, Main button), the notice vanished, the trim frame, switches, status line and texts popped in, and the selection box drew over a black stage. Now: the notice fades into the stage placeholder, everything else fades or springs (`features/viewer/README.md`, Loading crossfade; `features/timeline/README.md`, Timeline loading; `features/editor/README.md`, Editor draft).
- 4.6 s: the filmstrip arrived (it faded, but in 2 frames of 60). Now a 400 ms crossfade from the sheen.
- 5.4 s: `loadeddata`. Before, the spinner faded out and the video popped in about 80 ms later. Now a 400 ms crossfade from the sheen, marks with it.

No layout shift of ours was found in the recording: rows kept their positions to the pixel from the first frame (the reserved status line, the MainButton visible from the first render and the stage inside a `container-type: size` viewer already held). Safe-area and viewport variables had arrived before Telegram showed the page; no font loads (system font).

## Perf harness

`scripts/perf.mjs` is a symlink to `claude-rules/tools/perf.mjs`; `perf.config.mjs` serves `vite preview` and measures `/?job=ready`. `npm run perf` builds with the current env, so run it with `VITE_API_URL` unset and after `npm run mock`: the measured page is the mock build (a production build without the mock shows only the "open it from the bot" notice). A local build copies `public/mock/` (about 3.7 MB) into `dist/`; CI has no mock folder.

On Windows the checkout writes the symlink as a text file holding the target path (`core.symlinks` is false), and `npm run perf` then fails with `SyntaxError: Invalid regular expression flags`; run the engine directly from `miniapp/`: `vite build && node ~/projects/claude-rules/tools/perf.mjs`. Measured that way on 2026-10-25 after the render boundaries and the inline CSS: Entry 73.4 KB, M INP 56, M TBT 133, CLS 0.000, LH 98, A11y / BP / SEO 100; over budget the same three as below (M LCP 2.9 s, D FCP 208 ms, Idle 267 ms). After the switch to Preact (same day): Entry 15.0 KB, Page 112 KB, M FCP 1072, M LCP 2.54 s, M TBT 96, M long 146, M INP 48, CLS 0.000, LH 99, A11y / BP / SEO 100; still over: M LCP, D FCP 216 ms, Idle 214 ms (mobile; desktop idle 1 ms), causes unchanged. After removing the selection bar and adding the interpolation option (same day; the first harness tap is now `.options-row input`): Entry 14.6 KB, M LCP 2.47 s, M TBT 70, M INP 48, D FCP 192 ms (within budget this run), CLS 0.000, LH 99; over: M LCP, Idle 165 ms. After the loading crossfade, the sheen and the iOS switches (2026-10-26, with the metadata / high-res rows of the same day): Entry 15.4 KB (14.6 for HEAD of that day, built from a scratch copy), DOM 89 nodes (73), CLS 0.000 in every run, M INP 40–48 (32 for HEAD), LH 93–99; timings were measured A/B interleaved with HEAD on a machine busy with other browsers and builds, and both builds swung the same way (D FCP 272–612 ms for HEAD, 248–468 for the new build; M LCP 2.4–3.8 s against 3.0–5.4 s; Idle 50–174 ms against 70–178 ms), so no timing change could be attributed to the work. Rerun on a quiet machine before trusting a millisecond.

The engine needs a git repo (`git rev-parse` for the journal row) and fails at the end until the repo is initialized. Until then there is no `PERF.md` journal yet. The first measurement (2026-10-25, mock build, Edge 154, run from a scratch git folder with this config) passed Entry 73.5 KB, M TBT 50, M long 100, CLS 0.000, M INP 48, Page 171 KB, LH 97, A11y / BP / SEO 100. Over budget, each an owner decision:

- M LCP 2.9–4.1 s: the LCP element is the `<video>` first frame of a 3.6 MB proxy over slow 4G. The video is the content.
- D FCP 204–352 ms: the render-blocking Telegram script (above).
- Idle 78–201 ms (mobile only, 0 style / layout): the browser's media loading while the proxy keeps downloading (`preload='auto'`); script time in that window is 1–2 ms, and blocking the proxy drops it to about 30 ms. `preload='metadata'` would cut it but make every scrub wait for range requests.
