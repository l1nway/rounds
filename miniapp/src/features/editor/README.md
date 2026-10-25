# editor

The editing screen: composes `viewer`, `timeline` and the options, owns the draft and the submit. `app.jsx` renders it for every state (with `job` null while loading) so the loading, ingesting and error screens are the same layout as the ready one (layout stability).

## Editor draft

One `useReducer(merge)` holds what the owner picks: `start`, `end`, `time` (the frame of the selection, `prompt.time`), `points` (`[x, y, label]`, label 1 = this, 0 = not this), `box` (`[x0, y0, x1, y1]`), `negative` (the "Not this" mode), `options`, `posting`, `error`. It is initialized once from `job.request` (the previous submission) or from defaults (`0 … min(duration, max_duration)`), which is why `app.jsx` keys the editor by job id: it remounts once when the job becomes usable, never on a refetch. Children get `dispatch` and patch the fields they own; the clamps live where the gesture happens (`timeline`, Trim bounds), validation here (`isValid`: a positive point or a box, `MIN_RANGE ≤ end − start ≤ max_duration`, `start ≤ time ≤ end`).

States by `job.status`: `ready` edits; `done` / `failed` edit a prefilled draft and say so in the status line (resubmitting is allowed); `rendering` is read-only (no handles, no marks input, options disabled, MainButton hidden) but scrubbing still works to look at the submitted selection. After a successful POST: haptic success and `Telegram.WebApp.close()`; the bot reports progress in the chat. The status line holds one line: an error (`role='alert'`) or a note (`role='status'`), keep notes short enough for 320 px.

## Options seam

`OPTIONS` is the list of render options: `key` (the field in `options` sent to `POST /render`), `label`, `hint`, `needs(meta)` and the text shown when the video cannot have it. A new option (stabilization, audio filters) is one more entry plus the backend field; the switch row, defaults (`false`) and the payload (`optionsFor`, which forces an unavailable option to `false`) follow from the list. A row is disabled, not hidden, when `needs` fails (no audio for loudness), so the layout does not change between videos.

## Safe areas

`.editor` pads itself with `max(env(safe-area-inset-*), var(--tg-safe-area-inset-*))` plus `--tg-content-safe-area-inset-*` (Telegram's own controls over the page in fullscreen, Bot API 8.0). The Telegram script sets those variables and updates them on `safeAreaChanged` / `contentSafeAreaChanged`; outside fullscreen they are 0. `env()` is used only as padding of this element (web-platforms.md: it is not a stable number on iOS). Not verified on a phone: whether the MainButton's bottom bar overlaps the page in fullscreen (then `--tg-content-safe-area-inset-bottom` would carry it).
