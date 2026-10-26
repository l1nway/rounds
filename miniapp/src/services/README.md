# services

`api.js`: the backend calls (`getJob`, `postRender`, and for Lift `warmLift`, `segment`) (`Authorization: tma <initData>`, errors as `{detail}`, FastAPI validation lists read through `detail[0].msg`). `telegram.js`: the `Telegram.WebApp` integration. `mock.js` / `mock.css`: the dev mock.

## Telegram setup

`setupTelegram()` runs in `main.jsx` before the first render: `ready()` (as early as possible, per the docs), `expand()`, header / background colour from the theme, bottom bar colour (7.10+), `disableVerticalSwipes()` (7.7+) and, on `ios` / `android` only (`WebApp.platform`), `requestFullscreen()` (8.0+). Every versioned call is behind `isVersionAtLeast`, and every call is skipped outside Telegram (`initData` empty).

Vertical swipes stay disabled for the whole session, not only while drawing: the viewer and the timeline are gesture surfaces from edge to edge, and a toggle on `pointerdown` would be a message to the native side racing the native swipe recognizer that has already started (reasoned, not tested on a phone). Closing still works through Telegram's own Close button. Fullscreen is limited to phones so the desktop clients keep their window; in fullscreen Telegram draws its controls over the page, which the editor pads with `--tg-content-safe-area-inset-*` (`features/editor/README.md`, Safe areas).

APIs used, all checked in core.telegram.org/bots/webapps (2026-10-25): `initData`, `platform`, `isVersionAtLeast`, `ready`, `expand`, `setHeaderColor`, `setBackgroundColor`, `setBottomBarColor`, `disableVerticalSwipes`, `requestFullscreen`, `close`, `MainButton` (`setParams` with `text` / `is_visible` / `is_active`, `showProgress(false)`, `hideProgress`, `onClick` / `offClick`, `hide`), `HapticFeedback` (`selectionChanged`, `impactOccurred` light / medium / rigid, `notificationOccurred` success / error). `BackButton` is not used: the editor has no navigation.

## Entrance

`settle` in `telegram.js` sets `data-enter` on `<html>`, which starts the staggered entrance of the editor (`src/README.md`, Entrance). It waits for the end of Telegram's own expand: the first `viewportChanged` with `isStateStable` (or `fullscreenChanged`) after which `isExpanded` is true and, on phones, `isFullscreen` too; `fullscreenFailed` and a 1 s cap (`SETTLE`) end the wait as well, so a missing event never leaves the page hidden. If the app is already in its final state at setup (a reopened app, desktop, the mock with `isExpanded: true`) it enters at once. Event names and payloads from core.telegram.org/bots/webapps (Events); when exactly Telegram for iOS fires them during the fullscreen animation is not verified on the phone.

## Main button

The submit control is Telegram's MainButton ("Make round"), driven by `useMainButton`. It is visible from the first render (inactive while loading) except in the read-only `rendering` state: showing it only after the job loaded resized the page under the editor (CLS 0.05 in the mock). The editor is never remounted (`features/editor/README.md`, Editor draft), so the cleanup `hide` runs only on a real unmount. Do not reintroduce a remount: a `hide` immediately followed by a `show` is two messages to the native side, and Telegram for iOS animates both, sliding the button out and back in over about 250 ms (`IMG_0406.MP4`, 2026-10-26; the page did not move, the bottom bar went black for a frame). `telegram-web-app.js` drops a `setParams` that leaves the button state unchanged, so re-sending the same params is free. Both effects stay layout effects so the button state is sent in the same frame as the render that changed it. `is_active` combines a valid draft and `navigator.onLine`; while posting, `showProgress(false)` disables it. The click handler is read through a ref that a layout effect without deps sets to the latest `onClick` (Preact has no `useEffectEvent`, `miniapp/README.md`, Preact), so it always submits the current draft; the subscription itself is made once.

## Lift

`warmLift(id)` and `segment(id, {time, points, box})` back tap-to-lift (`features/viewer/README.md`, Lift). In mock mode `warmLift` resolves at once and `segment` goes to `mock.js` (Mock lift).

## Mock lift

`mock.segment` draws fake outlines on a canvas at half the mock proxy width: three discs (8, 16, 30 % of the short side, `best` the middle) around a single positive point, one disc for two or more points, the box itself for a box; 600 ms delay. `?job=nolift` rejects, to see the fallback. The discs are not SAM: only the gestures, the timing and the look can be checked with them.

## Mock mode

`VITE_API_URL` unset means mock mode. `main.jsx` imports `mock.js` before `setupTelegram()`; the module replaces `window.Telegram.WebApp` with a shim (`initData: 'mock'`, every method a no-op, `MainButton` drawn as a real `<button>` under `#root`, haptics logged to `window.mockHaptics`, `close()` covers the page with a note). `api.js` routes its calls to it. Both checks read `!import.meta.env.VITE_API_URL` directly so Rollup folds them: a build with the variable set contains no mock code (checked: no `mock` chunk, 75.5 KB gzip with React on 2026-10-25; 15.0 KB with Preact, also without a `mock` chunk). The CI workflow refuses to build with the variable empty, since that would publish the mock. `mock.css` makes `body` a column so the fake button takes real space like Telegram's bottom bar.
