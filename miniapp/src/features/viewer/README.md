# viewer

The proxy video with the selection overlay, `viewer.jsx`. There is no selection bar under it on purpose (owner decision 2026-10-25): the "Not this" mode, the summary / "Jump" chip and Clear duplicated what the gestures and closing the Mini App already do, and were noise. Do not bring them back.

## Letterbox

`.viewer-stage` is exactly the displayed video: `aspect-ratio` from `meta.width / meta.height` (display-oriented, the same aspect as the proxy) and `width: min(100cqw, 100cqh * aspect)` inside a `container-type: size` parent, so it fits both ways and the black bars belong to `.viewer`. Pointer positions are normalized against this box, which makes them 0..1 of the display-oriented frame (the API contract) with no letterbox maths in JS. Marks are HTML elements positioned in percent, so they stay put at any size and keep a fixed pixel size. Container query units: Chrome 105, Safari 16, Firefox 110 (MDN BCD); older engines get `height: 100%; max-width: 100%`, which can overflow on a very wide video.

## Selection gestures

One input layer (`touch-action: none`) over the stage, pointer events with capture, primary pointer only. Movement under 8 px is a tap, more is a box (drawn live by writing the style of one `[data-draft]` element, no React state per move; a box under 12 px either way is dropped). A tap within 24 px (screen) of an existing point removes it, otherwise it adds a point (label 1, "this object"; exclusion points with label 0 are no longer placed, but a prefilled draft from an older request still shows them red via `data-negative`). One box: a new one replaces it. `pointerdown` during playback freezes on the presented frame first (`hold`), so the mark belongs to the frame under the finger. Every change gives a light haptic. Coordinates are rounded to 4 decimals.

Keyboard and screen readers cannot place marks: picking an object on a video frame is pointer work, and the editor is for the owner on a phone. The rest (trim, playhead) is reachable by keyboard.

## Video source

The `<video>` src ends with `#t=0.001`. iOS (Telegram's WKWebView) does not honour `preload` and shows nothing until it is played, so no `loadeddata` arrives, the spinner never stops and a frame cannot be picked; the media fragment forces the first frame to load. Reasoned from the symptom (the editor worked in Telegram Web, not on the iPhone), not yet confirmed on the device.

## Selection frame

The selection belongs to one frame (`time`, `prompt.time`). On another frame the marks dim (`data-away`); the blue dot under the filmstrip shows where the selection frame is. A tap or a box on another frame **moves** the selection there: the old marks are dropped and the new mark starts a fresh selection at the current frame. Chosen over a confirm dialog because a dialog interrupts the gesture, the old marks are visible (dimmed) right up to the tap, and redoing one or two marks is cheaper than answering a question each time. Since the playhead is kept inside the trim range, `time` always lies in `[start, end]`, and the trim handles stop at it (`timeline/README.md`, Trim bounds). Ways to undo without Clear: tap a point to remove it (the last one removed with no box frees `time`), draw a new box (replaces the old), select on another frame (moves the selection), or close the Mini App (the draft is not kept).
