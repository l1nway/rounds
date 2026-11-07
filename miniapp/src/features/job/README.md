# job

## Job states

`useJob` turns the launch into `{job, notice}`: `job` is non-null only when the editor can work (status not `ingesting` and a `proxy_url`), `notice` is what the viewer area shows instead. A failed ingest has no proxy, so the API sends `proxy_url: null` and the notice is "This video could not be prepared" with the backend's readable reason (`job.error`, `backend/rounds/README.md`, Broken sources) before "Send it to the bot again". Until 2026-10-26 the API signed the URL anyway: the editor opened with `meta: null` and crashed on `meta.width` (the owner's broken file, exit 69); `?job=broken` in the mock shows the notice. Order: not in Telegram (`initData` empty) → no `?job=` → load error (with "Try again", disabled offline) → `ingesting` (poll every 2 s) → loading or offline. A settled job (`ready`, `rendering`, `done`, `failed`) is never refetched, also not on reconnect, so nothing the owner already did can be reset by the network. The poll and the retry pause while offline and resume on `online`. Only `ingesting` is polled; `rendering` is shown as read-only, and the bot reports progress in the chat.

## Miniapp local

Since 2026-11-07 the Mini App runs tap-to-lift and the preview tracking on the phone for every tier (owner: routing priority, device first; Modal credits). `withLocal` adds `lift`, `follow` (`attachLocal`, `features/local/README.md`, Local attach) and `proxy` to the server job:

- The device works on the proxy, not the source: `proxy.file` is the signed `proxy_url` (a string: `open` in `local/render.js` reads it with Mediabunny's `UrlSource`, and `identity` in `stage-cache.js` keys it by the URL without its query, which changes on every job read). `proxy.meta` is `job.meta` scaled to the proxy's long side 960 (`PROXY_LONG`, a copy of `media.PROXY_LONG`: change both together), so the tracker's frame size and the park rule (`local/README.md`, Park light) see the proxy, not a 4K source. `job.meta` itself is untouched: the options and the render body read it.
- `server` exists only on `pro` (Modal has `/segment` and `/track`; Oracle answers 403): a local failure on `pro` falls back to Modal, on `free` there is simply no outline (the point still works).
- Consent: the download card of the browser version does not exist here, so `consent` asks with Telegram's own `showConfirm` (Bot API 6.2+, a 256-character popup); older clients download without asking. The same 1 MB quiet rule applies (`local/README.md`, Quiet download).
- `lift` being a function makes `useLift` send `warmLift(id, 'local')` once (`backend/rounds/README.md`, Lift history), so the bot stops warming Modal's `Lift` for this user.

## Miniapp track

`sendRender` (in `use-job.js`, the Mini App's `send`): when the render follows the object (the same rule as `locate.follows` on the server: a selection, not a crop, and a non-square source or zoom), the phone first tracks the range with VitTrack (`trackSamples`, `local/README.md`, Miniapp track) for at most `WAIT` = 60 s (owner 2026-11-07), the label on the point showing the share. Then it posts the render with `track` (the samples it got) and closes. Whatever the phone did not reach, the server tracks from the edge of the device's span (`backend/rounds/README.md`, Device track). A failure or a crash flag (`localOff`) sends no `track`, and the server tracks the whole range itself. Not run on a phone yet.

## Crash note

The conditions banner after a crash (owner 2026-11-06, `CLAUDE.md`, Device routing): `useJob` imports `models.js` only when the crash guard is set in `localStorage` (`local/README.md`, Crash route), and turns its `crashNote` into the editor's `gate` note (`editor/README.md`, Editor seams). The note shows under the button from the first frame and leaves (the status line's own animation) after the next successful model call.
