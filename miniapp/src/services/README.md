# services

`api.js`: the two backend calls (`Authorization: tma <initData>`, errors as `{detail}`, FastAPI validation lists read through `detail[0].msg`). `telegram.js`: the `Telegram.WebApp` integration. `mock.js` / `mock.css`: the dev mock.

## Telegram setup

`setupTelegram()` runs in `main.jsx` before the first render: `ready()` (as early as possible, per the docs), `expand()`, header / background colour from the theme, bottom bar colour (7.10+), `disableVerticalSwipes()` (7.7+) and, on `ios` / `android` only (`WebApp.platform`), `requestFullscreen()` (8.0+). Every versioned call is behind `isVersionAtLeast`, and every call is skipped outside Telegram (`initData` empty).

Vertical swipes stay disabled for the whole session, not only while drawing: the viewer and the timeline are gesture surfaces from edge to edge, and a toggle on `pointerdown` would be a message to the native side racing the native swipe recognizer that has already started (reasoned, not tested on a phone). Closing still works through Telegram's own Close button. Fullscreen is limited to phones so the desktop clients keep their window; in fullscreen Telegram draws its controls over the page, which the editor pads with `--tg-content-safe-area-inset-*` (`features/editor/README.md`, Safe areas).

APIs used, all checked in core.telegram.org/bots/webapps (2026-10-25): `initData`, `platform`, `isVersionAtLeast`, `ready`, `expand`, `setHeaderColor`, `setBackgroundColor`, `setBottomBarColor`, `disableVerticalSwipes`, `requestFullscreen`, `close`, `MainButton` (`setParams` with `text` / `is_visible` / `is_active`, `showProgress(false)`, `hideProgress`, `onClick` / `offClick`, `hide`), `HapticFeedback` (`selectionChanged`, `impactOccurred` light / medium / rigid, `notificationOccurred` success / error). `BackButton` is not used: the editor has no navigation.

## Main button

The submit control is Telegram's MainButton ("Make round"), driven by `useMainButton`. It is visible from the first render (inactive while loading) except in the read-only `rendering` state: showing it only after the job loaded resized the page under the editor (CLS 0.05 in the mock). Both effects are layout effects on purpose: when the editor remounts with the loaded job, the old instance's cleanup (`hide`) must run before the new instance's `setParams` (`show`); with a passive cleanup the order flips and the button disappears. `is_active` combines a valid draft and `navigator.onLine`; while posting, `showProgress(false)` disables it. The click handler is read through a ref that a layout effect without deps sets to the latest `onClick` (Preact has no `useEffectEvent`, `miniapp/README.md`, Preact), so it always submits the current draft; the subscription itself is made once.

## Mock mode

`VITE_API_URL` unset means mock mode. `main.jsx` imports `mock.js` before `setupTelegram()`; the module replaces `window.Telegram.WebApp` with a shim (`initData: 'mock'`, every method a no-op, `MainButton` drawn as a real `<button>` under `#root`, haptics logged to `window.mockHaptics`, `close()` covers the page with a note). `api.js` routes both calls to it. Both checks read `!import.meta.env.VITE_API_URL` directly so Rollup folds them: a build with the variable set contains no mock code (checked: no `mock` chunk, 75.5 KB gzip with React on 2026-10-25; 15.0 KB with Preact, also without a `mock` chunk). The CI workflow refuses to build with the variable empty, since that would publish the mock. `mock.css` makes `body` a column so the fake button takes real space like Telegram's bottom bar.
