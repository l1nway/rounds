# timeline

Filmstrip, trim frame with two handles, playhead, clock with the precision mode, frame step and play buttons. `use-drag.js` is the pointer logic shared by the playhead and both handles.

## Fine scrub

Every drag is relative: `value = v0 + (x − x0) · duration / stripWidth · ratio`. A press on the strip first jumps the playhead under the finger, then drags it. Holding still for 400 ms (movement ≤ 6 px resets the timer) lowers `ratio` from 1 to 1/10, another hold to 1/100, with a medium haptic and a re-anchor at the current point, so the value never jumps when the mode changes. The clock line shows the mode and its real step (`Fine · 9.82 ms/px` on a 32 s video at 390 px). In the fine modes each frame boundary crossed gives `selectionChanged`; in the normal mode it would buzz continuously, so it is off there. Hitting a bound gives one `rigid` impact and re-anchors, so dragging back moves at once. The mode resets on release. Keyboard: arrows step one frame, Shift + arrows one second, on the playhead and on each handle.

## Trim bounds

`start` ∈ `[max(0, end − max), min(end − MIN_RANGE, time)]`, `end` ∈ `[max(start + MIN_RANGE, time), min(duration, start + max)]`, playhead ∈ `[start, end]`. `MIN_RANGE` is 1 s (a UI choice, not a backend rule). The handles stop at the selection frame (`time`, the blue dot under the strip) instead of invalidating it: the dot shows where the wall is, and Clear removes it. Dragging a handle seeks the video to it, like the iOS trim. Values are clamped unrounded (so the drag can detect a clamp) and stored rounded to ms.

## Timeline hit areas

The strip itself (`.timeline-scrub`, full width) is the playhead slider for focus, keyboard and accessibility; the visible playhead line has `pointer-events: none`. The handles are separate sliders, 24 px wide (`--hit`) with the 16 px yellow part (`--handle`) drawn by `::before` on the range side. Why: Lighthouse `target-size` failed on the 16 px handle and the 4 px playhead, and a slider inside a slider is invalid (children of `role='slider'` are presentational). The handles sit outside the range, so they never overlap each other; the playhead line is drawn above the trim frame (`z-index: 3` on the line, the scrub layer has no stacking context). The track keeps `touch-action: none` and its `margin-inline` equals the visible handle width, so a handle at 0 or at the end stays inside the padding.

## Filmstrip cells

The sprite (`filmstrip_url`, `tiles` frames in one row) is cut into square cells of the strip height (48 px, `STRIP`, also fed to CSS as `--strip`), each showing the tile nearest to its time, centre-cropped (`background-size` / `background-position` in px from the tile size). Stretching the whole sprite across the strip would distort it at any width. The cell count follows the measured width (`ResizeObserver`). The sprite is decoded (`img.decode()`) before the cells render, then they fade in once.
