# hooks

`state.js`: the project merge reducer, `createStore` (a `useSyncExternalStore` store with per-selector reads) and `useOnline`. `player.js`: the one `<video>` the app has, as a store (`time`, `paused`, `waiting`, `loaded`, `failed`; `loaded` turns true once, on the first `loadeddata`, and drives the placeholder crossfade in `viewer`) plus imperative `seek` / `step` / `toggle` / `hold` and `useAway(time)` (true while the shown frame is not the frame of `time`; the viewer marks and the lift); the viewer attaches the element, the timeline and the selection read and move it.

## Frame times

The proxy is CFR 30 (`FPS`, backend contract), times are seconds rounded to ms. A browser shows the frame whose timestamp is at or before `currentTime`, so frame `k` starts at `k / 30` and a time rounded *down* to ms (frame 1 → 0.033 < 0.0333) shows frame `k - 1`. Hence `frameTime(k)` rounds **up** to ms (0, 0.034, 0.067, 0.1 …) and `frameOf(t)` floors with a 0.001-frame epsilon for float noise; display and logic then agree on which frame a time means. The backend maps `prompt.time` to a working frame with `round((time - start) * FPS)`, which stays within one frame of what the owner saw (reasoned, not measured on the GPU side). Do not switch either helper to `Math.round` without re-checking the frame burned into the mock video (testsrc2 prints the frame number) against `formatTime`.

## Seek coalescing

One seek in flight at a time: `seek(t)` stores the target and updates `time` at once (the playhead and clock never wait for the decoder); the target goes to `video.currentTime` only when the previous seek fired `seeked` (latest target wins, intermediate ones are dropped). `requestVideoFrameCallback` is not used for this: it fires only when a *new* frame is presented, so a seek that lands on the frame already shown would never release the lock.

The write itself waits for the next frame plus a task (`later`, rAF then `setTimeout`). Measured in Edge headless with the perf engine's mobile profile (CPU ×4, slow 4G, touch emulation, cold cache): a frame-step tap that set `currentTime` in the same task as the DOM update was presented 1384–1392 ms later (Event Timing duration, processing 5 ms, the seek itself done in 4 ms); with the deferral 64 ms. With the proxy blocked the same tap took 48 ms either way, so the paused-video seek held back the presentation of the frame that carried the clock update. The deferral also caps seeks at one per frame while scrubbing. Whether a phone shows the same hold is unverified; keep the deferral.

## Playback clock

While playing, `time` follows the presented frame through `requestVideoFrameCallback` (`mediaTime`), so the playhead and the frame match exactly (MDN BCD: Chrome 83, Safari 15.4, Firefox 132). Fallback: a `requestAnimationFrame` loop reading `currentTime`. Either loop runs only between `play` and `pause`, never idle. Playback stops at the trim end (`setRange` from the editor) and restarts from the trim start.

## Offline

`useOnline` is the network store core asks for: `navigator.onLine` plus `online` / `offline` events through `useSyncExternalStore`. What it gates: the MainButton (inactive offline, the status line says why), the job poll and the load retry (paused, resumed on reconnect). Not gated: everything already loaded (selection, trim, scrubbing inside the buffered part of the video). A seek into a part the browser has not buffered shows the `waiting` spinner until the connection returns; a proxy that fails to load at all sets `failed` and the viewer shows a notice instead of an endless spinner.
