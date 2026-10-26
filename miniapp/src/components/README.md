# components

## Sheen

The loading placeholder: a `--surface` box with a soft light band sweeping across (`sheen.jsx`, `sheen.css`). Used by the viewer (busy notice and video stage, `features/viewer/README.md`, Loading crossfade) and the filmstrip (`features/timeline/README.md`, Filmstrip cells). Adapted from shelf's `FadeImage` placeholder (`shelf-sharing-webapp/src/app/components/fade.css`, README Fade image): the same 300 %-wide `::before` with a 105° gradient tiled at a third of its width, moved by `translateX(-66.667%)` in 3.6 s (one sweep per 1.8 s, seamless because the tiles repeat).

- Contract: `<Sheen on/>` as a child of a positioned parent with `isolation: isolate`. It sits at `z-index: -1`, so it paints above the parent's background and below the parent's content (the video, the filmstrip cells, the notice text). Without the isolation it falls behind the nearest stacking context's background and disappears.
- `on` false freezes the band (the animation is paused, never removed, so it does not snap) and keeps the layer visible for `--dur-long`, then `visibility: hidden`. The content that replaces it fades in over it with `appear` for the same time, so a placeholder and an opaque fading layer never dim each other in the middle of a crossfade. A parent that fades out itself (the notice) takes the sheen with it.
- Dark theme: the band is `color-mix(in srgb, var(--text) 9%, transparent)` over `--surface`, so it follows the Telegram theme both ways (shelf's literal `#d0d0d0` / `#f6f6f6` were for a light page).
- Motion is WAAPI on the pseudo-element (`animate(…, {pseudoElement: '::before'})`), per perf-web.md: no CSS `@keyframes` iteration events, a compositor-only transform. One `Animation` per instance, created in a layout effect, paused / played by `on`, cancelled on unmount. Reduced motion drops the band (`background: none`), leaving a static `--surface` box.
- The element is a `span`, not an `i`: `.timeline-film i` styles the filmstrip cells.
