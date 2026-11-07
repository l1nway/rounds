# services

`api.js`: the backend calls (`getJob`, `postRender`, for Lift `warmLift`, `segment`, and `lookFrame` for the HDR preview) (`Authorization` from Auth header, errors as `{detail}`, FastAPI validation lists read through `detail[0].msg`). `telegram.js`: the `Telegram.WebApp` integration. `stale.js`: the reload after a redeploy (Stale chunks). No mock code here (`miniapp/README.md`, Dev plugin).

## Stale chunks

Every deploy to Pages replaces `assets/` with new hashed file names, and the old ones are gone. A page loaded before the deploy (an open tab, a Mini App kept in memory, or an `index.html` from the HTTP cache: Pages sends `max-age=600`) still asks for the old names on its first lazy `import()`, gets 404, and Safari reports it as "Importing a module script failed." (found 2026-10-29 on an iPhone XR, iOS 18: picking a video failed on `probe-<old hash>.js` one minute after a deploy; reproduced in Playwright WebKit by answering `probe-*.js` with 404).

`reloadOnStaleChunk()` runs first in both entries (`main.jsx`, `web.jsx`) and listens for `vite:preloadError`, which Vite's preload wrapper fires when a lazy chunk, its dependencies or its CSS fail to load (vite.dev, Load error handling). It reloads the page, which revalidates `index.html` and brings the new names; the error still goes on to the caller, so the notice may flash before the reload. The picked file is lost and has to be chosen again. No reload when the browser is offline (the failure is the network, and a reload would leave a blank page), and at most one per 30 s per tab (`sessionStorage`), so a chunk that is really broken shows its error instead of a reload loop. A missing entry chunk (`web-*.js` from a cached `index.html`) is not covered: nothing of the app runs then; reload by hand.

## Auth header

`authorization` is a getter, `tma <initData>` by default (the Mini App, `backend/rounds/README.md`, Init data). The browser entry replaces it through `authorize(get)` with `web <session>` (`features/account/README.md`, Auth header). A setter rather than a branch on the platform here, because the Mini App must not carry browser code (`miniapp/README.md`, Launch router): this file stays Mini App code, and the web part lives in the module that only `web.jsx` loads. `API` and `post` are exported for the same module (`/api/auth`, `/api/auth/start`).

## Telegram setup

`setupTelegram()` runs in `main.jsx` before the first render: the mono accent check (`src/README.md`, Mono accent), `ready()` (as early as possible, per the docs), `expand()`, header / background colour from the theme, `disableVerticalSwipes()` (7.7+) and, on `ios` / `android` only (`WebApp.platform`), `requestFullscreen()` (8.0+). Every versioned call is behind `isVersionAtLeast`, and every call is skipped outside Telegram (`initData` empty).

Vertical swipes stay disabled for the whole session, not only while drawing: the viewer and the timeline are gesture surfaces from edge to edge, and a toggle on `pointerdown` would be a message to the native side racing the native swipe recognizer that has already started (reasoned, not tested on a phone). Closing still works through Telegram's own Close button. Fullscreen is limited to phones so the desktop clients keep their window; in fullscreen Telegram draws its controls over the page, which the editor pads with `--tg-content-safe-area-inset-*` (`features/editor/README.md`, Safe areas).

APIs used, all checked in core.telegram.org/bots/webapps (2026-10-25): `initData`, `platform`, `isVersionAtLeast`, `ready`, `expand`, `setHeaderColor`, `setBackgroundColor`, `disableVerticalSwipes`, `requestFullscreen`, `close`, `HapticFeedback` (`selectionChanged`, `impactOccurred` light / medium / rigid, `notificationOccurred` success / error). `BackButton` is not used: the editor has no navigation. `MainButton` is not used since 2026-10-26: it resized the page (`features/editor/README.md`, Submit bar).

## Entrance

`settle` in `telegram.js` sets `data-enter` on `<html>`, which starts the staggered entrance of the editor (`src/README.md`, Entrance). It waits for the end of Telegram's own expand: the first `viewportChanged` with `isStateStable` (or `fullscreenChanged`) after which `isExpanded` is true and, on phones, `isFullscreen` too; `fullscreenFailed` and a 1 s cap (`SETTLE`) end the wait as well, so a missing event never leaves the page hidden. If the app is already in its final state at setup (a reopened app, desktop, the mock with `isExpanded: true`) it enters at once. `enter` is exported for `web.jsx`, which has no Telegram to wait for and enters before its first render. Event names and payloads from core.telegram.org/bots/webapps (Events); when exactly Telegram for iOS fires them during the fullscreen animation is not verified on the phone.

## Lift

`warmLift(id)` and `segment(id, {time, points, box})` back tap-to-lift (`features/viewer/README.md`, Lift).

## Follow

`track(id, {start, end, prompt: {time, points, box, mask}})` posts to `/api/jobs/{id}/track` and returns `{fps, start, boxes}` (the object's box per sample, `null` where it is lost) or `null` when a newer call superseded it on the server (`backend/rounds/README.md`, Track preview; consumer `features/viewer/README.md`, Follow).

## Exact frame

`lookFrame(id, {time, look, exposure})` posts to `/api/jobs/{id}/look` and returns `{image, width, height}` (a JPEG data URL of the whole display-oriented frame at proxy size with the complete HDR look, AI repair included; 409 while the proxy is not ready, 502 with a readable `detail` when the GPU call fails). Caller and timing: `features/viewer/README.md`, Exact frame.

## Launch aspect

`launchAspect()` reads `a` from the launch URL (width / height of the video, written by the bot, `backend/rounds/README.md`, Launch aspect) or returns `null` when it is missing, `0` or not a number. The editor uses it as `FALLBACK_ASPECT` until the job arrives: the viewer's shape (`features/viewer/README.md`, Viewer fit) and the split or stacked layout (`features/editor/README.md`, Split layout) are right from the first paint. A hint for the layout only: everything else reads `job.meta`.

## API URL

`API` is `VITE_API_URL` without trailing slashes, or empty when the variable is unset: the calls then go to the same origin (`/api/jobs/...`). The production build always has it (the CI workflow refuses an empty one: the Pages origin has no `/api`). Locally, unset, the gitignored dev client answers those same-origin calls in the page (`miniapp/README.md`, Dev plugin). There is no mock branch: until 2026-10-26 `api.js` and `main.jsx` imported `mock.js` when the variable was empty and relied on Rollup folding the check away; the owner wanted no mock code in the repo at all.

## Browser upload

The upload calls (`/api/uploads`, the parts, `/uploaded`) and the client note live in `features/local/server.js`, which only the browser entry loads: while they sat in `api.js` the shared chunk carried them into the Mini App. `api.js` exports `request`, `post` and `jobPath` for that module (`features/local/README.md`, Local server). The server side is `backend/rounds/README.md`, Browser upload and Client note.

## Modal fallback

[DOC: modal-fallback] `respond` is `request` that also returns the router's `X-Rounds-Via` header, and every failed request throws an `Error` with `status` and the body's `code` (`pro_unavailable` when Modal is down). Used by `features/local/server.js` (`features/local/README.md`, Modal fallback); `request` is `respond` minus the header.

## Telemetry

[DOC: telemetry] `telemetry.js` sends anonymous diagnostics to Oracle (`backend/rounds/README.md`, Telemetry, Telemetry privacy).

- **Start.** `startTelemetry(sample)` runs once per page in both entries (`main.jsx`, `web.jsx`), before the first render. It does nothing without `VITE_API_URL` (the mock dev build). It:
  - makes the install id (`rounds.install`) and a session id;
  - reports `open` and the previous black box;
  - listens to `error`, `unhandledrejection`, `visibilitychange` and `pagehide`;
  - calls `sample()` 3 s later. The entry passes the lazy device sampler (`features/local/README.md`, Device sample), because a service never imports a feature.
- **Queue.** `report(kind, data)` queues an event.
  - The queue flushes 4 s after its first event, at most 50 events a batch; it keeps up to 200.
  - `credentials()` (`api.js`) returns the current `Authorization` value, or `null` before the browser version signs in. Meanwhile the events wait in the queue.
- **Helpers.** `recall` and `keep` are the try-wrapped `localStorage` JSON helpers.
- **Rules.**
  - Never put a job id, a file name, a selection or user data into an event (Telemetry privacy).
  - `BUILD` is the commit (`miniapp/README.md`, Telemetry build).
- **Checked 2026-11-07** in headless Edge, on a build with a Telegram launch hash and a local capture server. These arrived:
  - `open`;
  - `device` (36 limits, bench 535 GFLOPS on the GTX 1660 Ti);
  - `conditions`;
  - `error` and `rejection` with stacks;
  - `pagehide`, `hidden`;
  - after a reload, `previous` with the first page's 6 events.
  - Trap: scripts injected over CDP (`page.evaluate`) give "Script error." and no `unhandledrejection` (muted errors). Test with a same-origin script tag.
  - Beats and model events have not run with a real model yet.

## Telemetry transport

[DOC: telemetry-transport] `fetch` with `keepalive: true`, `Content-Type: text/plain` and the credentials in the body.
- This is a CORS simple request with no preflight, so it also leaves during `pagehide`, and a dying page's last beat gets out.
- `keepalive` caps the bodies in flight at 64 KB (Fetch spec), and the server caps a batch at 48 KB.
- A failed send is dropped: these are diagnostics, with no retry loop.

## Telemetry black box

[DOC: telemetry-black-box] Every event except `previous` is also written to `rounds.blackbox` in `localStorage`: the last 40, with the session and the build. The next page load sends it as `previous`.
- A crash leaves no event of its own. A session whose last event is a `beat`, with no `hidden` or `pagehide` after it, died during work. The server also sees its beats stop.
- It is the mechanism of the removed check panel's run record (`features/local/README.md`, Phone findings), which showed that `localStorage` survives a WebContent kill in Telegram on iOS.
- Unknown: whether Telegram fires `pagehide` when the Mini App is closed. Until the black box arrives, a closed app may look like a death.

## Telemetry beat

[DOC: telemetry-beat] `busy(label)` opens a work span and returns its `done`.
- While a span is open, and for 4 s after the last one closes, a `beat` with the open labels is reported and flushed every 3 s.
- The 4 s (`LINGER`) keep the gaps between track steps from stopping and restarting the beat.
- `models.js` opens a span per worker call (`features/local/README.md`, Model telemetry).
- The last beat dates a death to within 3 s.
