# src

## Theme tokens

`index.css` maps Telegram's theme variables onto the app tokens (`--bg`, `--surface`, `--text`, `--hint`, `--link`, `--button`, `--button-text`, `--danger`). The Telegram script sets `--tg-theme-*` (and `--tg-color-scheme`) on `<html>` and keeps them current on `themeChanged`, so nothing in JS reads `themeParams`. The second argument of each `var()` is the fallback for a browser outside Telegram and for the mock, redefined under `prefers-color-scheme: dark`; inside Telegram the Telegram colours always win, whatever the OS theme. `color-scheme` follows `--tg-color-scheme` so native controls match.

Fixed colours: `--stage` (black behind the video in both themes, with `--on-stage` text), `--trim` (iOS yellow trim frame). Motion: every transition reads `--dur` / `--ease`; `prefers-reduced-motion` sets `--dur: 0ms`, so state changes still happen, just without the tween. `#root` takes `--tg-viewport-stable-height` (Telegram's own recommendation for bottom-pinned layout), `100dvh` outside Telegram.
