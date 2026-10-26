# Mini App

The editor opened from the bot's `web_app` button: `<pages url>?job=<id>`. React (JS) + Vite SPA, plain CSS, `arch-features.md` layout under `src/`. API contract: `backend/rounds/README.md` (coordinates 0..1 of the display-oriented frame, times in seconds with ms precision).

Run locally without Telegram or the backend: needs the owner's local `dev/` folder (Dev plugin). With it: `npm install`, `npm run mock` (test video, needs `ffmpeg`), `npm run dev` with `VITE_API_URL` unset, open `/?job=ready`; scenarios, the Dev panel (load a video from disk) and the rest are in `dev/README.md`. Without it the page only shows "Open it from the bot".

## Dev plugin

Owner decision 2026-10-26: no mock or local-test code in the repo or the build. All of it (Vite plugin, Telegram shim, mock API, Dev panel, test media generator and its output, its README) lives in `miniapp/dev/`, which is gitignored and exists only on the owner's PC. The repo knows only the hook in `vite.config.js`: if `dev/plugin.js` exists it is imported (through a computed URL, so the config bundler does not try to resolve a file CI does not have) and added to `plugins`; the plugin's own `apply` limits it to `vite` / `vite preview` and `vite build --mode mock`. A plain `vite build` has no trace of it (checked 2026-10-26: no `mock`, `__dev` or `Load video` in `dist/`), and CI has no `dev/` at all.

`src/services/api.js` has no mock branch: it requests `VITE_API_URL + path`, and an unset variable means the same origin, where the dev client answers the calls (`src/services/README.md`, API URL). `package.json` keeps `mock` (`node dev/mock-media.mjs`) and the `--mode mock` of `perf`: paths and a mode name, no mock code; on a clone without `dev/` they fail with a missing file.

## Relative base

`base: './'` in `vite.config.js`: the build works under any GitHub Pages project subpath and from `vite preview` without knowing the repo name. Safe because the app has one route; state lives in the query (`?job=`), and Telegram appends its launch data to the hash (`#tgWebAppData=…`), which the app never reads (it uses `Telegram.WebApp.initData`).

## Build target

`build.target` is `safari18` + `chrome130`: the owner uses the Mini App only in Telegram for iOS 18+ (WKWebView, the Safari 18 engine) and Telegram Desktop on Windows (lib_webview, which picks WebView2, evergreen Edge Chromium, and falls back to EdgeHTML only without the WebView2 runtime: `webview/platform/win/webview_win.cpp` in desktop-app/lib_webview, read 2026-10-25). Nothing else needs to work, so no syntax lowering, no CSS prefixes, and `modulePreload.polyfill` is off (the app has no preloaded chunks anyway). Raising the target saved 0.3 KB gzip: the bundle was already modern; its weight was React DOM (Preact, below).

## Preact

The app runs on Preact 10 with the React API of `preact/compat` (owner decision 2026-10-25, overrides react.md): the production entry chunk went from 75.5 to 15.0 KB gzip (15.5 in the mock build), which was the "Reduce unused JavaScript" item of PageSpeed. The source keeps importing `react` and `react-dom/client`; `resolve.alias` in `vite.config.js` points them at `preact/compat` and `preact/compat/client`, and Vite's own oxc transform compiles JSX for `preact` (no `@vitejs/plugin-react`, so no Fast Refresh: an edit reloads the page in dev). The `react` import is deliberate: oxlint's `react` plugin recognizes hooks by their import source, and with `preact/hooks` imports it reported every `ref.current =` as a mutation of a hook value (`react(immutability)`). `@preact/preset-vite` was not used: its peer range rejected Vite 8 (npm ERESOLVE, 2026-10-25).

Differences that matter here:

- No `useEffectEvent` (not exported by `preact/compat` 10.29): a handler an effect reads goes into a ref updated by a layout effect.
- No `StrictMode` (a Fragment in compat), so effects are not double-invoked in dev.
- Renders are batched to a microtask even for discrete events (React flushes a click or a keydown synchronously): code that reads the DOM right after a `dispatch` sees the old render. Nothing in the app does; a test must wait a tick.
- `onChange` of a text input is mapped to `input` by compat (as in React); the app has only a checkbox, where both fire on click.

Checked on the mock build in headless Edge (2026-10-25): load, tap to add a point, option switch, play / pause, arrow keys on a trim handle, submit through the mock MainButton with the current draft; no console errors.

## Inline CSS

The `inline-css` plugin in `vite.config.js` replaces the built `<link rel="stylesheet">` in `index.html` with a `<style>` of the same file and drops the file (web.md: no stylesheet request blocks the first paint). Only CSS linked from the page is inlined; a CSS file of a lazy chunk would stay a file, since its chunk links it at runtime. The page grows to 3 KB gzip and has the same 10-minute cache as the CSS had.

The built head order is: charset, viewport, title, icon, the theme `<style>` of `index.html` (Vite minifies it in place, dev serves it as written), the Telegram script, the module script, the inlined app CSS (Vite puts its `<link>` before `</head>`). The colours paint from the theme style before any app CSS or JS (`src/README.md`, Theme tokens); the app CSS needs no particular place, since the module script is deferred and `#root` is empty until it runs.

## Theme tokens

The inline `<style>` in `index.html` is the single home of the colour tokens and of the page background, so the first paint has the right colour in dev and in the build: `src/README.md`, Theme tokens. It sits before the Telegram script so it is parsed while that script downloads (its `var(--tg-…)` resolve whenever the script sets them); keep it free of anything but colours.

## Favicon

`<link rel='icon' href='data:,'>` in `index.html`, no icon file. No client of the app shows a favicon (Telegram iOS and Telegram Desktop open it without a tab), but without any icon link Chromium requests `/favicon.ico` by itself: headless Edge 154 on a test server fetched it and logged `Failed to load resource: 404` in the console (a Lighthouse best-practices failure); with `data:,` it made no request and logged nothing; with the former `favicon.svg` it made one request (2026-10-26). WebView2 shares Edge's browser layer, so the same is expected there (reasoned, not run in Telegram Desktop). Under GitHub Pages `/favicon.ico` is the host root, outside the project, so it would 404.

## No SEO

The Mini App is not searchable, so there is no `<meta name='description'>` and no `robots.txt` (removed 2026-10-26). A `robots.txt` would not work there anyway: RFC 9309 §2.3 says crawlers read it only from `/robots.txt` at the top-level path of the host, and a GitHub Pages project site lives under `/<repo>/`. `<title>` stays: HTML requires it and axe (Lighthouse accessibility) audits it (`document-title`); `lang` stays for screen readers. The SEO score is not a budget here (owner, 2026-10-26: only weight and speed matter): `perf.config.mjs` sets `budgets: {SEO: -Infinity}`, so the harness still prints the score (82 without these files) with no limit.

## Telegram script

`index.html` loads `https://telegram.org/js/telegram-web-app.js?64` in `<head>` before every other script (after the theme `<style>`, which is not a script), as core.telegram.org/bots/webapps prescribes (checked 2026-10-25; the `?64` cache-buster is the one the page shows, update it from there). It is render-blocking on purpose: `window.Telegram.WebApp` must exist before `main.jsx` calls `setupTelegram()` and `ready()`. Cost: desktop FCP 204–352 ms locally against the 200 ms budget (Perf harness). Do not make it `async` or move it below the module script without moving `setupTelegram()` behind its `load`. Being parser-blocking also puts Telegram's theme variables on `<html>` before the first paint (`src/README.md`, Theme tokens); an `async` script would paint the fallback colours first. Locally it still loads; the dev client then replaces `window.Telegram` (Dev plugin).

## Opening on iOS

What a phone shows when the Mini App opens, frame by frame from the owner's recording (`IMG_0406.MP4`, 2026-10-26, iPhone, Telegram iOS, dark theme, a `done` job; 60 fps, measured with ffmpeg + a row probe). Read it before "fixing" motion that is not ours.

- 0.25–1.7 s: Telegram's own sheet with its grey placeholder while the page, `telegram-web-app.js` and the entry chunk load and `ready()` runs (Telegram script, above). Nothing of ours is on screen yet.
- Launch colours (owner's recording `IMG_4373.MP4`, 2026-10-26: the header starts grey and turns black when the page loads). Before the page runs, Telegram paints the bot's `botAppSettings` (`background_color`, `header_color` and their `_dark` twins, plus an SVG placeholder icon) or its own default; set in @BotFather: /mybots → the bot → Bot Settings → Configure Mini App → Enable Mini App (Bot API 8.0, "Loading Screen Customization", core.telegram.org/bots/webapps). Not only for the Main Mini App: Telegram iOS passes the bot's app settings to keyboard and inline `web_app` buttons too (`ChatControllerOpenWebApp.swift`, `WebAppController.swift` 323–346), Telegram Desktop maps them in `bot_attach_web_view.cpp` (read 2026-10-26, via a research agent). They are fixed hex values per light / dark, not theme keys, so they match only the owner's theme; `telegram-web-app.js` posts `web_app_set_header_color` `bg_color` at load anyway (its default), so set them to that theme's `bg_color`. Enabling it gives the bot a Main Mini App that opens the editor without `?job=` (it then shows "No video in the link", `MISSING` in `use-job.js`).
- 1.8–2.15 s: the sheet expands to fullscreen (`requestFullscreen()` on phones, `services/README.md`, Telegram setup). The whole page, Telegram's own header pill and the MainButton move up together by about 50 px on an ease-out curve: a native animation, not a layout shift of ours (all rows move by the same amount within 3 px of scaling). Only opening in fullscreen directly would remove it, which a `web_app` keyboard button cannot ask for.
- 2.15–4.0 s: the job request (`GET /jobs/{id}` to Modal). Its 2 s are the network and the backend (reasoned, not measured: a Modal container waking from zero would explain it), not the page.
- 4.0 s, before 2026-10-26: the MainButton slid out and back in (editor remount, `services/README.md`, Main button), the notice vanished, the trim frame, switches, status line and texts popped in, and the selection box drew over a black stage. Now: the notice fades into the stage placeholder, everything else fades or springs (`features/viewer/README.md`, Loading crossfade; `features/timeline/README.md`, Timeline loading; `features/editor/README.md`, Editor draft).
- 4.6 s: the filmstrip arrived (it faded, but in 2 frames of 60). Now a 400 ms crossfade from the sheen.
- 5.4 s: `loadeddata`. Before, the spinner faded out and the video popped in about 80 ms later. Now a 400 ms crossfade from the sheen, marks with it.

No layout shift of ours was found in the recording: rows kept their positions to the pixel from the first frame (the reserved status line, the MainButton visible from the first render and the stage inside a `container-type: size` viewer already held). Safe-area and viewport variables had arrived before Telegram showed the page; no font loads (system font).

## Perf harness

`scripts/perf.mjs` is a symlink to `claude-rules/tools/perf.mjs`; `perf.config.mjs` serves `vite preview` and measures `/?job=ready&perf` (`perf` hides the Dev panel). `npm run perf` builds with `--mode mock`, which adds the local dev plugin (Dev plugin), so run it with `VITE_API_URL` unset and after `npm run mock`; without `dev/` the measured page is only the "Open it from the bot" notice. The test media is served from `dev/media/` by the plugin, not copied into `dist/` (before 2026-10-26 `public/mock/`, about 3.7 MB, went into every local build). The dev client loads through an inline module, so Entry KB still counts only the app (`dev/README.md`, Dev plugin); it adds one small request to Page.

On Windows the checkout writes the symlink as a text file holding the target path (`core.symlinks` is false), and `npm run perf` then fails with `SyntaxError: Invalid regular expression flags`; run the engine directly from `miniapp/`: `vite build --mode mock && node ~/projects/claude-rules/tools/perf.mjs`. Measured that way on 2026-10-25 after the render boundaries and the inline CSS: Entry 73.4 KB, M INP 56, M TBT 133, CLS 0.000, LH 98, A11y / BP / SEO 100; over budget the same three as below (M LCP 2.9 s, D FCP 208 ms, Idle 267 ms). After the switch to Preact (same day): Entry 15.0 KB, Page 112 KB, M FCP 1072, M LCP 2.54 s, M TBT 96, M long 146, M INP 48, CLS 0.000, LH 99, A11y / BP / SEO 100; still over: M LCP, D FCP 216 ms, Idle 214 ms (mobile; desktop idle 1 ms), causes unchanged. After removing the selection bar and adding the interpolation option (same day; the first harness tap is now `.options-row input`): Entry 14.6 KB, M LCP 2.47 s, M TBT 70, M INP 48, D FCP 192 ms (within budget this run), CLS 0.000, LH 99; over: M LCP, Idle 165 ms. After the loading crossfade, the sheen and the iOS switches (2026-10-26, with the metadata / high-res rows of the same day): Entry 15.4 KB (14.6 for HEAD of that day, built from a scratch copy), DOM 89 nodes (73), CLS 0.000 in every run, M INP 40–48 (32 for HEAD), LH 93–99; timings were measured A/B interleaved with HEAD on a machine busy with other browsers and builds, and both builds swung the same way (D FCP 272–612 ms for HEAD, 248–468 for the new build; M LCP 2.4–3.8 s against 3.0–5.4 s; Idle 50–174 ms against 70–178 ms), so no timing change could be attributed to the work. Rerun on a quiet machine before trusting a millisecond. After the staged entrance and the viewer fit (2026-10-26): Entry 16.5 KB, M INP 40, LH 98, A11y / BP / SEO 100; over: M LCP 2.64 s, Idle 177 ms (as before) and CLS 0.182 (budget 0.01, 0.000 before): the viewer growing or shrinking to the video (`src/features/viewer/README.md`, Viewer fit) moves the timeline and the options while they are visible. The shift is the requested animation; the budget was left for the owner to decide. After the cleanup of the same day (unmount on exit, fitted placeholder from the first frame, late rows growing together, CSS reset, no SEO files), A/B interleaved with HEAD (7b567f9) built from a scratch copy, two runs each: CLS 0.030–0.037 against 0.029–0.030 (the remaining shift is the late option rows growing in above the codec, owner decision; a 16:9 viewer no longer moves), DOM 80 nodes (100), 7 requests (8, the favicon is gone), M INP 48; timings moved the same way for both builds on a busy machine (M FCP 1788–1800 against 1776–1956 ms, D FCP 544–668 against 612–664, Idle 256–331 against 176–339), so no timing change is attributed to the work. SEO 82: no meta description and `/robots.txt` answered by the SPA fallback, both removed on purpose (No SEO); the owner then dropped the SEO budget.

The engine needs a git repo (`git rev-parse` for the journal row) and fails at the end until the repo is initialized. Until then there is no `PERF.md` journal yet. The first measurement (2026-10-25, mock build, Edge 154, run from a scratch git folder with this config) passed Entry 73.5 KB, M TBT 50, M long 100, CLS 0.000, M INP 48, Page 171 KB, LH 97, A11y / BP / SEO 100. Over budget, each an owner decision:

- M LCP 2.9–4.1 s: the LCP element is the `<video>` first frame of a 3.6 MB proxy over slow 4G. The video is the content.
- D FCP 204–352 ms: the render-blocking Telegram script (above).
- Idle 78–201 ms (mobile only, 0 style / layout): the browser's media loading while the proxy keeps downloading (`preload='auto'`); script time in that window is 1–2 ms, and blocking the proxy drops it to about 30 ms. `preload='metadata'` would cut it but make every scrub wait for range requests.
