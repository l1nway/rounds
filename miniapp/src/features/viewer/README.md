# viewer

The proxy video with the selection overlay, `viewer.jsx`. There is no selection bar under it on purpose (owner decision 2026-10-25): the "Not this" mode, the summary / "Jump" chip and Clear duplicated what the gestures and closing the Mini App already do, and were noise. Do not bring them back.

## Letterbox

`.viewer-stage` is exactly the displayed video: `aspect-ratio` from `--aspect` (`meta.width / meta.height`, set on `.viewer` and inherited, see Viewer fit) (display-oriented, the same aspect as the proxy) and `width: min(100cqw, 100cqh * aspect)` inside a `container-type: size` parent, so it fits both ways and the black bars belong to `.viewer`. Pointer positions are normalized against this box, which makes them 0..1 of the display-oriented frame (the API contract) with no letterbox maths in JS. Marks are HTML elements positioned in percent, so they stay put at any size and keep a fixed pixel size. Container query units: Chrome 105, Safari 16, Firefox 110 (MDN BCD); older engines get `height: 100%; max-width: 100%`, which can overflow on a very wide video.

## Viewer fit

Owner request 2026-10-26 (`IMG_0407.MP4`, iPhone SE2): the viewer got only the grid leftover, about 100 pt of 667, too small to tap an object. Once the job (and so the aspect) is known, `.viewer[data-fit]` takes `height: min(100cqw / var(--aspect), 70cqh)` of the editor (a size container): a vertical video grows to 70 % of the editor height, a horizontal one gets exactly its own height with no bars (it may shrink). The editor then scrolls (`editor/README.md`, Editor scroll); nothing is compressed to fit (owner decision).

- `useFit` in `viewer.jsx` animates the change with WAAPI, one layout effect per aspect: drop `data-fit`, read `offsetHeight` (from), set it back, read again (to), then `animate({height, '--aspect'}, FIT)` (600 ms, the `--ease` curve; JS literals because the minifier writes `--dur-long` as `.4s`, so do not parse tokens from computed style). No fill: when it ends the CSS rule holds the same height, and later viewport changes follow CSS. Reduced motion: no animation, the rule applies at once.
- `--aspect` is registered (`@property`, `<number>`, inherits) so it interpolates from 16:9 (`FALLBACK_ASPECT`, the shape of the placeholder before the job) to the video's aspect along with the height, and the stage (sized in `.viewer` container units) morphs smoothly instead of jumping shape. Do not add a CSS transition on `--aspect` or `height`: the "to" read would then return the start value.
- `offsetHeight`, not `getBoundingClientRect`: the entrance (`src/README.md`, Entrance) scales the viewer by 1.06 at the same time, and a transformed rect made the animation end with a 1–2 px jump.
- Fit runs on the job, not on `loadeddata`: the placeholder takes its final shape while the video loads, and the video then fades into a box that no longer moves under the finger.
- Rejected: the owner's `collapse` library. On Preact it builds only with a `useEffectEvent` shim, split aliases and `forwardRef` (+1.86 KB gzip), and it animates closed ↔ natural height, not grid leftover → target height. `calc-size()` / `interpolate-size` are not in Safari; a `grid-template-rows` transition from `1fr` to px is discrete.
- Measured in the mock (Edge headless, 375 × 667, the SE2 viewport; `meta` swapped for the vertical case): vertical 231 → 422 px over 600 ms, page content 794 px for 603 available (191 px of scroll); horizontal 1920×1080 231 → 211 px. CLS: 0.20 (vertical) and 0.0016 (horizontal) at 375 × 667, 0.182 in the perf harness: the layout shift is the requested growth itself (`miniapp/README.md`, Perf harness). The feel on the iPhone is not verified.

## Selection gestures

One input layer (`touch-action: none`) over the stage, pointer events with capture, primary pointer only. Movement under 8 px is a tap, more is a box (drawn live by writing the style of one `[data-draft]` element, no React state per move; a box under 12 px either way is dropped). A tap within 24 px (screen) of an existing point first cycles the lifted outline (Lift) and removes the point once every candidate was shown; without a lift it removes the point at once. Otherwise it adds a point (label 1, "this object"; exclusion points with label 0 are no longer placed, but a prefilled draft from an older request still shows them red via `data-negative`). One box: a new one replaces it. `pointerdown` during playback freezes on the presented frame first (`hold`), so the mark belongs to the frame under the finger. Every change gives a light haptic. Coordinates are rounded to 4 decimals.

Keyboard and screen readers cannot place marks: picking an object on a video frame is pointer work, and the editor is for the owner on a phone. The rest (trim, playhead) is reachable by keyboard.

## Video source

The `<video>` src ends with `#t=0.001`. iOS (Telegram's WKWebView) does not honour `preload` and shows nothing until it is played, so no `loadeddata` arrives, the spinner never stops and a frame cannot be picked; the media fragment forces the first frame to load. Reasoned from the symptom (the editor worked in Telegram Web, not on the iPhone), not yet confirmed on the device.

## Selection frame

The selection belongs to one frame (`time`, `prompt.time`). On another frame the marks dim (`data-away`); the blue dot under the filmstrip shows where the selection frame is. A tap or a box on another frame **moves** the selection there: the old marks are dropped and the new mark starts a fresh selection at the current frame. Chosen over a confirm dialog because a dialog interrupts the gesture, the old marks are visible (dimmed) right up to the tap, and redoing one or two marks is cheaper than answering a question each time. Since the playhead is kept inside the trim range, `time` always lies in `[start, end]`, and the trim handles stop at it (`timeline/README.md`, Trim bounds). Ways to undo without Clear: tap a point to remove it (after cycling through the outlines, Lift) (the last one removed with no box frees `time`), draw a new box (replaces the old), select on another frame (moves the selection), or close the Mini App (the draft is not kept).

## Lift

Tap-to-lift (owner decision 2026-10-26, after the demo on the iPhone): after every selection change the viewer asks the backend for SAM's outlines of the tapped object (`POST /segment`, `backend/rounds/README.md`, Lift) and shows the chosen one lifted from the frame (Lift look). The outline is what the tracker follows: its PNG goes into the draft as `mask` and to `POST /render` as `prompt.mask`.

- `useLift` (in `viewer.jsx`, its only consumer) owns the ephemeral state `{time, candidates, index, best, pending}`; the draft holds only the chosen `mask`. `ask(selection)` runs after every `select`: it clears `mask` at once (a submit while waiting sends plain points), keeps the old outline dimmed (`data-stale`) when the new selection is on the same frame, and drops answers that are not the latest (a counter, not an abort: the GPU call runs anyway). A selection without a positive point or a box clears the lift.
- Gestures: a repeated tap on the point cycles the candidates from `best` (the middle one by area: part, whole, surroundings) and wraps; when the next one would be `best` again, the tap removes the point instead, as before Lift. Two points or a box give one outline, so a tap on a point removes it at once. Adding outside and subtracting inside the outline were proposed and are not built.
- Failure (`502`, offline, `?job=nolift` in the mock): no outline, no message, the point stays and is tracked from points. An error line for a decoration would be noise.
- Warm-up: `warmLift` (`POST /warm`) when the editor gets a job that is not rendering, and again on every `visibilitychange` to visible (the GPU container sleeps after 120 s idle). Errors are ignored.
- A prefilled draft (`done`, `failed`, `rendering`) shows the submitted `prompt.mask` as the only candidate. `useJob` gives `job` a new identity once, so the "store the previous `job`" reset in render runs once.

## Lift look

`lift.jsx` + `lift.css`: the iOS "lift subject" look, tuned on the owner's iPhone with the demo page (2026-10-26). Over the stage, under the marks: `lift-dim` darkens everything outside the outline (`mask-composite: exclude`); `lift-pop` scales a copy of the frame inside the outline by 1.012 around the tap point (a 1.03 overshoot on arrival); `lift-glow` puts three `drop-shadow`s (0.75 px white rim, 7 px and 20 px glows) on that masked copy; `lift-shine` is a faint silver gradient with one light band that sweeps twice on the first outline and once on a switch (`translate` only). A switch crossfades two layers (`prev` fades out, `cur` fades in, keyed by a counter).

- The frame copy is a `<canvas>` painted from the `<video>` (`drawImage`) when the layer mounts, when the video first loads and whenever the selection frame is shown again (after `seeked` if a seek is running). A cross-origin video taints the canvas, which only blocks reading it back; nothing reads it. Showing the live `<video>` through the mask was rejected: a glow needs a masked element of its own above the video, and a white or translucent fill there hides or greys the object.
- `--bleed` (32 px): the glow element is that much larger than the stage so the shadow is not clipped at its box. WebKit still clipped the glow where the outline ran along the frame edge; the backend therefore insets the outline 4 px from the frame border (`backend/rounds/README.md`, Lift mask), so the rim is drawn inside the picture.
- Away from the selection frame (another frame shown, playback) the lift is hidden, not dimmed like the marks: the frame copy would sit over a different picture. Before `loadeddata` it is hidden with the marks (Loading crossfade).
- Waiting: the point pulses with two staggered rings (`data-pending` on `.viewer-marks`, `scale` and `opacity`), the old outline at 0.45.
- Reduced motion: no sweep, no pop, a static ring; the fades follow `--dur-long` (0).
- Checked in the mock (Edge headless, 390 × 844): pending rings, lift, two cycles, removal on the third repeated tap, the submitted `prompt.mask`, and the `nolift` fallback; no console errors. The look on the iPhone was approved on the demo page, not yet in the Mini App.

## Loading crossfade

What the viewer shows from the first paint to the first video frame, with no layout shift and no pop (owner's recording `IMG_0406.MP4`, 2026-10-26: the selection box drew over a black stage for 1.4 s, then the video popped in).

- Phase 1, no job (loading, ingesting): the `Notice` covers the whole viewer. A busy notice (`LOADING`, `INGESTING`, `data-busy`) has a `Sheen` as its background and theme text colours on it (`--text` / `--hint`: the sheen is `--surface`, light in a light theme); it has no spinner, the sheen is the activity indicator. A non-busy notice (errors, offline, outside Telegram) stays opaque `--stage`.
- Phase 2, job known, no frame yet: the notice fades out (`data-off`, opacity over `--dur-long`, then `visibility: hidden`) and reveals the stage, morphing to the video's aspect and size (Viewer fit), with its own `Sheen` and black letterbox bars. Inside the stage box both sheens are the same colour, so only the bars appear to fade in. The notice keeps its last content while it fades (`last` state, updated during render, React's "store information from previous renders" pattern: a ref read in render and a `setState` in an effect are both lint warnings here); its body is keyed by the title so a new notice text fades in (`appear`) instead of reflowing the old one (the ingest → ready reflow was CLS 0.001).
- Phase 3, `loadeddata` (`loaded` in the player store): `data-loaded` on the stage; the video and the marks play `appear` over the frozen sheen, which hides when the fade is done. The video is `opacity: 0` until then, the marks `visibility: hidden` (a box over a black stage looked broken). The marks' own `data-away` dim is untouched (the reveal is an animation, not an opacity override). The `waiting` spinner is gated by `loaded`: the sheen covers the first load.
- The stage sheen runs only with a job (`on` = job, not loaded, not failed): in phase 1 it would only run hidden under the notice.
- A one-shot `animation`, not a transition, for the reveal (perf-web.md: a cached video can fire `loadeddata` before the hidden state was ever painted).
- The video is the LCP element; at `opacity: 0` it is not an LCP candidate until the reveal starts. See `miniapp/README.md`, Perf harness, for the measured effect.
- Measured in the mock (Edge headless, 390 × 844, CPU ×4, slow 4G, `?job=done` and `?job=ingest`): CLS 0 through the whole load, every state change a fade. That was before Viewer fit, whose growth is a counted layout shift. Only a phone shows how WKWebView paints the `<video>` layer under `opacity: 0`.
