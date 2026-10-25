# editor

The editing screen: composes `viewer`, `timeline` and the options, owns the draft and the submit. `app.jsx` renders it for every state (with `job` null while loading) so the loading, ingesting and error screens are the same layout as the ready one (layout stability).

## Editor draft

One `useReducer(merge)` holds what the owner picks: `start`, `end`, `time` (the frame of the selection, `prompt.time`), `points` (`[x, y, label]`, label 1 = this; 0 = not this exists in the API but the UI no longer places it, `viewer/README.md`), `box` (`[x0, y0, x1, y1]`), `options`, `posting`, `error`. It is initialized once from `job.request` (the previous submission) or from defaults (`0 … min(duration, max_duration)`), which is why `app.jsx` keys the editor by job id: it remounts once when the job becomes usable, never on a refetch. Children get `dispatch` and patch the fields they own; the clamps live where the gesture happens (`timeline`, Trim bounds), validation here (`isValid`: a positive point or a box, `MIN_RANGE ≤ end − start ≤ max_duration`, `start ≤ time ≤ end`).

States by `job.status`: `ready` edits; `done` / `failed` edit a prefilled draft and say so in the status line (resubmitting is allowed); `rendering` is read-only (no handles, no marks input, options disabled, MainButton hidden) but scrubbing still works to look at the submitted selection. After a successful POST: haptic success and `Telegram.WebApp.close()`; the bot reports progress in the chat. The status line holds one line: an error (`role='alert'`) or a note (`role='status'`), keep notes short enough for 320 px.

## Render boundaries

The draft lives in the editor, so every draft change renders `Editor`; the children are `memo` and get only what they read, so a change reaches only its consumers. `Viewer` gets `selection` (`time`, `points`, `box`, one `useMemo` object), `Timeline` gets `start` / `end` / `time`, `Options` gets `options`. A trim drag (a `dispatch` per pointer move) therefore renders `Editor` + `Timeline` only, a tap on the video `Editor` + `Viewer` + `Marks`. The playhead never goes through the draft: `time` of the player store is read by `Clock`, `Scrub` and the boolean `useAway` selector. `Editor` itself is `memo` because `useJob` re-renders `App` on every poll while ingesting (`job` stays null, `notice` is a constant). Do not pass `draft` or an inline object to a child: it defeats the `memo`. Reasoned from the props, not counted with the Profiler.

## Options seam

`OPTIONS` is the list of render options: `key` (the field in `options` sent to `POST /render`), `label`, `hint`, `needs(meta)` and the text shown when the video cannot have it. A new option (stabilization, audio filters) is one more entry plus the backend field; the switch row, defaults (`false`) and the payload (`optionsFor`, which forces an unavailable option to `false`) follow from the list. A row is disabled, not hidden, when `needs` fails (no audio for loudness), so the layout does not change between videos. `interpolate` ("Smooth to 60 fps") reads `meta.interpolable`, which the backend decides at ingest (`backend/rounds/README.md`, Output rate); jobs ingested before the field have it undefined, so the row is disabled for them.

## Safe areas

`.editor` pads itself with `max(env(safe-area-inset-*), var(--tg-safe-area-inset-*))` plus `--tg-content-safe-area-inset-*` (Telegram's own controls over the page in fullscreen, Bot API 8.0). The Telegram script sets those variables and updates them on `safeAreaChanged` / `contentSafeAreaChanged`; outside fullscreen they are 0. `env()` is used only as padding of this element (web-platforms.md: it is not a stable number on iOS). Not verified on a phone: whether the MainButton's bottom bar overlaps the page in fullscreen (then `--tg-content-safe-area-inset-bottom` would carry it).
