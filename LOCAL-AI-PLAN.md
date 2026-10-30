# Local AI in the browser version: handoff plan

Written 2026-10-29 for any agent (Claude, Gemini, other) that continues this work without the earlier chat. Read this file, then `CLAUDE.md`, then the READMEs listed per step. Do the steps in order, one per commit-sized change. The project must build (`cd miniapp && npm run lint && npm run build`) after every step.

## Goal

On a PC browser (the "web" shell, same URL as the Mini App) the anonymous user gets nothing except the timeline: every option is locked by tier and tap-to-lift / follow need a server job id. Make the browser run what the device can run: loudness and exposure on CPU/WebGL, noise reduction (DeepFilterNet3, WASM on CPU), tap-to-lift and tracking (SAM 2.1 via ONNX Runtime Web on WebGPU). A `pro` user also runs locally when the device is clearly fast; when local clearly loses, Modal.

## Owner rules (do not break)

1. **The Mini App stays minimal.** It runs in a Telegram WebKit view with tight memory. Nothing from this work may enter the Mini App bundle: every new module is reached only by dynamic `import()` from `miniapp/src/features/web/web-app.jsx` (or from a module that only the web shell loads). After each step run `npm run build` and compare the Mini App entry chunk size with the size before (`miniapp/dist/assets`); it must not grow. New npm packages are approved by the owner (onnxruntime-web, highs, a DeepFilterNet WASM package) but only on that condition.
2. Free hosting only. Model weights come from a safe, fast, licensed source: Hugging Face model repos with permissive licences (Apache-2.0 / MIT), fetched at use time, cached in the Cache API, never committed to the repo. Show size and a consent/progress before the first download.
3. Local first for what the device can do fast; Oracle next; Modal last (priority and the Modal threshold: `CLAUDE.md`, Owner decisions, 2026-10-30). Offline: a local render works offline, a downloaded model keeps working offline.
4. Project style: `C:\Users\l1nway\projects\claude-rules\core.md` (2-space, no semicolons, single quotes, no spaces in braces, files <= 200 lines, comments only as tags/doc-keys, explanations go to the folder README under a `[DOC: key]` heading, UI copy English, owner replies Russian). Edit with the Edit tool; text with backticks never via shell heredoc. Update the folder README in the same step as any behaviour change.
5. Do not commit or push unless the owner asks. No `Co-Authored-By` in commits.

## Facts already established

Observed in code (2026-10-29):

- Tier: `miniapp/src/features/account/session.js`, `tierOf = user => user ? user.tier ?? 'free' : 'local'`. `locked(tier, item)` in `miniapp/src/features/editor/draft.js` compares `RANK = {local:0, free:1, pro:2}` with each option's `need`. Rows show a "Sign in"/"PRO" badge and are disabled in `miniapp/src/features/editor/options.jsx`.
- `miniapp/src/features/local/plan.js`: `LOCAL_OPTIONS = new Set(['zoom'])`; `needsServer` is true for any other option or level, a codec in `meta.off`, an HDR source, or a pro selection; `gate` blocks anonymous users on those.
- `miniapp/src/features/local/render.js`: Mediabunny 1.63.0 `Conversion`, crop from `frameOf` (one fixed square), 640x640, one-pass size fit, `tags: () => ({})`.
- Mediabunny 1.63.0 types (`miniapp/node_modules/mediabunny/dist/mediabunny.d.ts`, search `process?:`): `video.process(sample) => CanvasImageSource | VideoSample | ... | null` and `audio.process(sample) => AudioSample | AudioSample[] | null`. Per-frame WebGL cropping/colour and audio filtering can be hooked into `Conversion` with no ffmpeg. Not run yet.
- Viewer: `miniapp/src/features/viewer/viewer.jsx` lines ~46 and ~153 pass `job?.tier === 'free' ? null : job?.id` to `useLift` and `useFollow`; a local job has `id: null`, so lift and follow never run.
- Server reference algorithms to mirror (read `backend/rounds/README.md` sections Tracking, Lift, Camera path, Audio chain, Loudness, Denoise, Look): lift = SAM 2.1 image model, 3 candidates, middle by area, mask cleaned (opening, holes, 4 px edge, 1.2 feather); tracking = SAM 2.1 video, 1024 input, circle = min enclosing circle of mask; camera path = Grundmann L1 LP (`backend/rounds/camera.py`); loudness = ffmpeg loudnorm I=-16 TP=-1 LRA=7 two-pass; denoise = `deep-filter` DeepFilterNet3, atten 6->100 dB on a log scale `6*(100/6)^s`.

From web search, secondary sources, **not verified against primary docs** (check before relying):

- SAM 2.1 ONNX exports exist for the browser: `SharpAI/sam2-hiera-tiny-onnx`, `Geo-IA/evo-sam2.1-onnx` (image encoder + decoder, fp16 variants), `square-zero-labs/sam2.1-tiny-video-onnx` (video with memory modules, no browser/WebGPU demo seen). No confirmed transformers.js SAM2 video pipeline.
- DeepFilterNet3 WASM npm packages: `deepfilternet3-noise-filter` (AudioWorklet, realtime, wants SharedArrayBuffer), `deepfilter-standalone` (buffer processing). Pick the one that processes a whole buffer, check licence and size.
- ONNX Runtime Web has WASM and WebGPU EPs. GitHub Pages cannot send COOP/COEP, so no SharedArrayBuffer unless a service-worker shim (`coi-serviceworker`) is added; WebGPU EP itself should not need it. Firefox/Safari WebGPU status: unverified, check MDN/caniuse. iOS (owner-observed 2026-10-30, iPhone XR): iOS 18 Safari has WebGPU behind a hand-set Feature Flag, iOS 18 WKWebView (the Mini App) has none, iOS 26 has it by default (`miniapp/src/features/local/README.md`, WebGPU by platform).
- Owner PC: GTX 1660 Ti, Edge and Firefox. No AV1/VP9 hardware encode there (software encode works).

## Steps

Each step: implement, build, lint, update README, report what was and was not verified.

### Step 0. Capability layer and unlock (about 120 lines total)

- Done already (2026-10-29): codec block no longer greys out when only some codecs are unavailable (`miniapp/src/features/editor/options.css`: block dims only when every radio is disabled; single disabled radio labels dim alone).
- New `miniapp/src/features/web/device.js` (~50 lines): `deviceOf()` returns `{gpu: bool, wasm: true}`, `gpu` from `navigator.gpu?.requestAdapter()`. Loaded dynamically by `web-app.jsx` only.
- Change the lock model: an option's availability = `locked(tier, item)` OR runs locally. Add to `OPTIONS`/`LEVELS` in `miniapp/src/features/editor/draft.js` a field `local: true|'gpu'` for the local-capable ones (loudnorm, denoise, look/exposure; later lift/follow) and let `locked()` (or its callers in `options.jsx`) skip the tier lock when `device` satisfies `local`. Pass the device flags through the `job` object (`web-app.jsx` builds `job`) so the Mini App path (no `local` capability) behaves exactly as before.
- `plan.js`: `LOCAL_OPTIONS` becomes the set of options the device handles; `needsServer` stops returning true for them. Update `miniapp/src/features/local/README.md`, `[DOC: local-plan]`.

**Status 2026-10-29:** Step 0's lock model is done in a simpler form than planned: an item with `local: true` (or numeric cap `< 1`) in `draft.js` skips its tier lock when the job has `local: true` (set by `web-app.jsx`); no `device.js` yet (add it with the first GPU feature, Step 4). Step 1 (`local/loudness.js`, `render.js`, README `Local loudness`), Step 2 (`local/look.js` `grade(look, ev, OUT)`, `local: LOOK.HONEST` cap in `draft.js`/`options.jsx`, `metadataFormat: 'mdta'` and strict `KEPT_TAGS` + `'©xyz'` in `probe.js`/`render.js`, README `Local exposure` and `Local metadata`), and Step 3 (`@lofcz/deepfilternet-web@0.1.0`, `local/denoise.js` + `denoise-worker.js`, `levelPlanes` after denoise in `loudness.js`/`render.js`, `local: true` on `denoise` in `draft.js`/`plan.js`, README `Local denoise`) are done; lint and build pass, the maths, WASM DeepFilterNet3 attenuation/delay, plan/lock assertions, and `ffprobe` MP4 metadata round-trip were verified in Node, nothing ran in a browser yet. Next: Step 4 (Tap-to-lift on WebGPU).

### Step 1. Loudness on CPU (about 150 lines, new `miniapp/src/features/local/loudness.js`) — DONE, unverified in a browser

- BS.1770 K-weighting + gating, a gain curve towards -16 LUFS and a true-peak limiter at -1 dBFS, applied in Mediabunny `audio.process` inside `render.js` `encode()`. Two passes: measure the trimmed range first, then process. Do not add ffmpeg.wasm.
- Verify on a clip: output near -16 LUFS integrated (measure with `ffmpeg -af ebur128` on the owner's PC), peak <= -1 dBTP. Document the difference from ffmpeg `loudnorm`.

### Step 2. Exposure and honest HDR look in the render (about 150 lines) — DONE, verified in Node (`ffprobe`), unverified in a browser

Done 2026-10-29: `local/look.js` `grade(look, ev, size)` runs the viewer's `createLook` in `video.process` with `split(look)` (`t` in `0..1`, `hdr: 0`), `LEVELS` caps `look` at `LOOK.HONEST` (`0.4`) for non-pro local jobs (`capOf`), `plan.js` keeps `0 < look <= LOOK.HONEST` local and routes `look > LOOK.HONEST` to Modal, and `probe.js`/`render.js` read the 10 `KEPT_TAGS` (plus `'©xyz'` -> `com.apple.quicktime.location.ISO6709`) and write them with `Mp4OutputFormat({fastStart: 'in-memory', metadataFormat: 'mdta'})` (README `Local exposure`, `Local metadata`).

- Reuse the preview shaders `miniapp/src/features/viewer/look-glsl.js` and `look-gl.js` (read `miniapp/src/features/viewer/README.md`, Look). Apply per frame in `video.process`: draw the cropped frame to an OffscreenCanvas through the shader and return the canvas. HDR *sources* still go to the server (`meta.hdr`) until a tone-map path exists.
- Metadata: probe currently returns `tags: {}`; read source tags in `probe.js` and write them through Mediabunny `tags` when the option is on. Compare with `backend/rounds/tags.py`. Check GPS/camera tags can be read and written.

### Step 3. Noise reduction, DeepFilterNet3 in WASM (about 180 lines, `miniapp/src/features/local/denoise.js` + worker) — DONE, verified in Node, unverified in a browser / by ear

Done 2026-10-29: `@lofcz/deepfilternet-web@0.1.0` (`libDF` WASM SIMD + embedded DeepFilterNet3 weights), `local/denoise.js` + `local/denoise-worker.js`, `attenOf(s) = 6 * (100 / 6) ** s` dB, 3-frame (1440-sample, 30 ms) delay compensation, `loudness.js` `levelPlanes` run on the denoised 48 kHz buffer when `options.loudnorm` is also on, `replace(clean)` in `audio.process`, `local: true` on `denoise` in `draft.js` and `'denoise'` in `LOCAL_OPTIONS` (`plan.js`).

- Needs owner-approved package choice (see Facts). Run in a Web Worker, CPU WASM, decode audio of the trimmed range to PCM 48 kHz, process the whole buffer, feed the result through `audio.process`. Map the slider 0..1 to attenuation `6*(100/6)^s` dB if the package exposes an attenuation limit; otherwise mix dry/wet and write down the difference.
- Order of audio stages must match the server (`backend/rounds/README.md`, Audio chain): denoise, then loudness.
- Listen test by the owner; say plainly that it is unverified until then.

### Step 4. Tap-to-lift on WebGPU (about 200 lines per file, split into `models.js`, `lift-local.js`, worker) — DONE, verified in headless Edge on GTX 1660 Ti, unverified interactively in the owner's browsers

Done 2026-10-29: `onnxruntime-web@1.31.1`, `local/models.js` (`MODELS` registry for `Geo-IA/evo-sam2.1-onnx` rev `b3234dc2bf3cfd9475755d20a5dd11308c56e6ae`, Apache-2.0, `sam2.1-tiny-encoder` 67.31 MB + `sam2.1-tiny-decoder` 8.76 MB = 76.07 MB total, Cache API `rounds-models-v1`, SHA-256 verification, consent card in `result.jsx` + `.web-sync` download progress, `deviceOf()`), `local/lift-local.js` + `local/lift-worker.js` (WebGPU EP with WASM fallback, 8-frame LRU embedding cache, mask cleanup matching `backend/rounds/segment.py` with `IoU = 0.9999`), and `job.lift` in `web-app.jsx` + `viewer.jsx` (with Modal fallback on `pro` when `source.id` is ready). Measured on GTX 1660 Ti in Edge 154: encoder **1.26 s** first frame (cold) / **233–242 ms** subsequent frames (warm), decoder **2.49–2.65 s** first tap (cold) / **43–77 ms** warm (`152–184 ms` end-to-end with cleanup and PNG encoding), VRAM `+1071 MiB` (`2577 -> 3648 MiB`).

- `models.js`: registry `{name, url, bytes, sha256}`, Cache API storage, progress callback, consent UI hook. Source: Hugging Face model repo with a permissive licence; record the repo, revision and licence in the README.
- `lift-local.js`: SAM 2.1 tiny/small image encoder + decoder in `onnxruntime-web` (WebGPU EP, WASM fallback). Same output shape as the server's `/segment` so `useLift` in `viewer.jsx` needs a provider switch only: `lift = local ? localLift : serverLift`. Mirror the mask cleanup from the backend.
- Measure on the GTX 1660 Ti: encoder time per frame, decoder time per tap, VRAM. Record numbers in `local/README.md`. If encoder time is over ~3 s, document and stop; do not ship a slow path silently.

### Step 5. Tracking and camera path (largest, uncertain) — DONE, verified in headless Edge on GTX 1660 Ti, numerical parity tests, and interactive E2E browser tests

Done 2026-10-29: `diffusionstudio/sam2.1-tiny-video-onnx-fp16` (Apache-2.0, rev `66673b5db39371b7dd7847f4d3bc0d4f4179b79e`, path `onnx/`, 83.16 MB total across 5 graphs), `local/tpos.js` + `local/track-worker.js` + `local/track-local.js` (WebGPU sequential sessions, ImageNet normalization 512², Welzl's minimum enclosing circle, 512-bin histogram, `changes` / `sceneCuts` matching `backend/rounds/media.py`, `grid` preview at 10/6/5 fps with single-flight cancellation, full video rate track for render with `toSource` scaling), `local/camera.js` (Hampel outlier filter, velocity jump & size spike cleanup matching Python with 0 mismatches and 2.05e-12 px path identity, $O(N)$ tridiagonal Thomas not-a-knot `CubicSpline` matching SciPy to 1.42e-13, `sampler` across scene cuts), dynamic per-frame crop via Mediabunny `video.process` in `render.js` (`sample.draw(ctx, sx, sy, side, side, 0, 0, OUT, OUT)`), and wired into `web-app.jsx` (`job.follow`), `viewer.jsx`, `follow.js`, `draft.js`, and `plan.js`. Measured on GTX 1660 Ti in Edge: warm inference **185–201 ms/frame** (~5.2 fps), tracking error **0.002** vs PyTorch, preview `followLocal` 16 frames in **14.41 s** cold, `renderNote` 1.5 s clip with tracking in **10.38 s**, producing valid 640² AV1 MP4 (`339 kB`, verified with `ffprobe`). Fixed interactive tap-to-lift and tracking pipeline (detached `<video>` seek hang replaced with `live` video + Mediabunny `CanvasSink`, fixed 404 in video model URLs, added explicit UI status messages for inference and tracking, guarded gesture pointers). Mini App chunks (`index`, `editor`, `look`, `look-gl`) unchanged.

**Audit 2026-10-29 (after Step 5):** the camera path was the Gaussian fallback only; the server's L1 LP is now ported (`local/camera-lp.js`, `highs@1.15.3`, parity with `camera.solve` 1.4e-11 px). Lift and tracking share one model worker (one ONNX Runtime, one model at a time on touch devices), render tracking streams frames instead of holding all of them (1.8 GB for 60 s before), preview and render runs are serialized, local tracking needs WebGPU (fixed crop otherwise), `look.js` no longer subtracts the trim start twice, Welzl is iterative. Details: `miniapp/src/features/local/README.md` (Model worker, Local tracking, Camera path); the iPhone reload: `BUGS.md`.

### Step 6. Stabilisation, interpolation (RIFE), AI HDR, upscale, deblur

Feasibility studies only, each separately measured. Upscale stays on the server (about 4 min per 10 s on a server GPU). Do not start without the owner. Measurements policy (owner 2026-10-30): no one-off benchmarks while planning; an unverified estimate goes to `BUGS.md`, "Unmeasured", and the owner runs them later as one parallel batch.

Routing for all of them follows the priority in `CLAUDE.md`, Owner decisions: WebGPU on the device, Oracle CPU, the device CPU, Modal last.

- **AI HDR (Zero-DCE++, FastDVDnet).** Zero-DCE++ is CC BY-NC 4.0 with an "academic research only" statement; licences are followed strictly, so its weights are never shipped to the browser (no local Zero-DCE++). The AI part of the HDR slider stays on the server; the honest part and exposure run locally (Step 2). The Zero-DCE++ curve will also run on the Oracle free tier on the CPU, in several processes at once. FastDVDnet stays Modal-only (too heavy even on a GTX 1660 Ti). Open risk: brightening without the FastDVDnet denoise first lifts the noise too (`BUGS.md`, Zero-DCE without denoise).
- **Stabilization.** Not finished. The goal now is the architecture for on-device execution (WebGPU, WebGL2, Workers) with parity to the server path (`backend/rounds/README.md`, Stabilization); details are tuned later. Phone memory budgets (canvas size, donor reach) are not fixed until the jetsam analysis of the iPhone crashes concludes, so no number here is final. Owner: cutting the canvas or the buffer is undesirable. Estimates for time and memory are listed in `BUGS.md`, "Unmeasured". The edge fill follows the routing priority: the cheap fill locally or on Oracle, ProPainter only when Modal is available.
- **iOS memory evidence.** The SE2 jetsam highwater of 1.62 GB is one sample and ambiguous, to be repeated: the owner will crash it several more times and collect all logs. The iPhone XR writes no JetsamEvent logs at all (Settings → Privacy → Analytics shows none), so XR testing is blind. Until then treat 1.62 GB as one sample, not a firm limit (`BUGS.md`, "iPhone reload on tracking").

## Pro users

After Steps 4/5: for `pro` run local when `device.gpu` and the measured local time is below the server's expected round trip; otherwise Modal. Keep Modal as the fallback on any local failure.

## Verification checklist per step

- `npm run lint`, `npm run build` in `miniapp/`; Mini App entry chunk size unchanged.
- Browser check on the owner's PC (Edge and Firefox) through `npm run dev` with the dev folder (`miniapp/dev/README.md`).
- State plainly what ran and what did not (a real-device claim needs the owner).

## Files to read first

- `CLAUDE.md` (project), `C:\Users\l1nway\projects\claude-rules\core.md`
- `miniapp/src/features/local/README.md`, `plan.js`, `render.js`
- `miniapp/src/features/editor/draft.js`, `options.jsx`, `options.css`
- `miniapp/src/features/web/web-app.jsx`, `miniapp/src/features/web/README.md`
- `miniapp/src/features/viewer/viewer.jsx`, `miniapp/src/features/viewer/README.md`
- `backend/rounds/README.md` (algorithms), `backend/rounds/camera.py`, `track.py`, `segment.py`, `audio.py`
