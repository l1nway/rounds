# src

## Theme tokens

`index.css` maps Telegram's theme variables onto the app tokens (`--bg`, `--surface`, `--text`, `--hint`, `--link`, `--button`, `--button-text`, `--danger`). The Telegram script sets `--tg-theme-*` (and `--tg-color-scheme`) on `<html>` and keeps them current on `themeChanged`, so nothing in JS reads `themeParams`. The second argument of each `var()` is the fallback for a browser outside Telegram and for the mock, redefined under `prefers-color-scheme: dark`; inside Telegram the Telegram colours always win, whatever the OS theme. `color-scheme` follows `--tg-color-scheme` so native controls match.

Fixed colours: `--stage` (black behind the video in both themes, with `--on-stage` text), `--trim` (iOS yellow trim frame). Motion: every transition reads `--dur` / `--ease`; `prefers-reduced-motion` sets `--dur: 0ms`, so state changes still happen, just without the tween. `#root` takes `--tg-viewport-stable-height` (Telegram's own recommendation for bottom-pinned layout), `100dvh` outside Telegram.

## Motion tokens

`--dur-long` (400 ms, 0 under reduced motion) is for crossfades and the switch spring; `--dur` stays for small state changes. `@keyframes appear` (`from {opacity: 0}`) is the plain reveal, used by the video and marks, the notice body, the status line and the option hints. `@keyframes enter` (`from {opacity: 0; filter: blur(10px); scale: 1.06}`, `--dur-enter` 700 ms, 0 under reduced motion) is the soft reveal of the entrance and of the filmstrip cells.

## Entrance

Owner request 2026-10-26 (recording `IMG_0407.MP4`, iPhone SE2): after Telegram's sheet expanded to fullscreen every block popped in at once. Now the blocks come in one after another, each from transparent, blurred and scaled 1.06 to normal, like the staggered entrance of shelf-sharing-webapp (`src/app/README.md`, Entrance animation) but softer (no overshoot, 700 ms, `--ease`).

- Contract: a block gets the class `enter` and its place `--i` in its own CSS; the delay is `--i × --stagger` (110 ms). Order: viewer (0, `.viewer`), timeline strip with its head (1, `.timeline-head`, `.timeline-track`), the play and frame buttons (2, `.timeline-controls`), then each option row on its own step (3 onward: `--i` set inline from `FIRST_OPTION` + index in `editor.jsx`, so a new option extends the cascade by itself) and the status line after them (also inline). Blocks with the same `--i` move together. Owner request 2026-10-26 (`IMG_0409.MP4`): the options block came in as one piece, the rows should come one by one. The submit bar is not part of the cascade: it mounts when the video has loaded and plays `enter` at once (`features/editor/README.md`, Submit bar).
- Gate: until `<html>` has `data-enter` every `.enter` is `opacity: 0`; then the animation runs with `backwards` fill, so nothing is left hidden after it. `services/telegram.js` sets the attribute once Telegram finished expanding (`services/README.md`, Entrance), so the cascade plays on the settled, full-size layout instead of under the expand animation. Outside Telegram and in the mock it is set at once.
- Reduced motion: no hiding and no animation (both rules sit inside `prefers-reduced-motion: no-preference`).
- Cost: `filter` and `scale` only (no layout); four blocks for under a second, once per open. Checked in the mock (Edge headless, 375 × 667, dark, CPU ×4, slow 4G, CDP screencast): the four steps and the filmstrip wave play in order; perf harness unchanged (CLS 0.000, M LCP 2568 ms against 2572 before, Entry 16.4 KB). The feel on the iPhone is for the owner to judge.
- The grey sheet with the Telegram icon before the page (about 2 s in the recording) and its jump to black are Telegram's own loading screen, not the page: its colours and icon are set in @BotFather (Bot Settings → Configure Mini App, loading screen; Bot API 8.0). Matching its dark background to the dark `bg_color` removes the jump.
