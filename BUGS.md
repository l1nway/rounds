# Open bugs and questions

Known bugs and open questions that are not being worked on right now. Each entry: what is seen or missing, what is known, where the details live, and what closes it. A closed entry is removed; its outcome goes to the folder README it belongs to.

## Note start cut off

- Seen (owner, 2026-10-27): job `8K9cD2dNs7` (4K HEVC 60 fps, follow + loudness, sent by `sendVideoNote`) arrived as a round, but its beginning felt cut off. Cause not investigated.
- Next: the owner retests by hand. Then compare the requested trim start in the job's `request` with the render log line `clip=`, the first frame of `note.mp4` and the audio start (loudness levelling can fade in).

## Rolling shutter

- Open (owner, 2026-10-28): the owner sees no rolling-shutter wobble ("jello") in their clips, so no correction is planned for now.
- Known: on the 384² test clip there was no usable rolling-shutter signature (measurements and the plan in `backend/rounds/README.md`, Stabilization: homography mixtures in `motion.params` first, MeshFlow only if they fail).
- Closes when: a high-resolution phone clip with visible wobble shows up; then check the correlations described there.

## iPhone reload on tracking

- Seen (owner, 2026-10-29, browser version in Safari on an iPhone XR, iOS 18): a tap lifts the object fine, then the tracking starts and Safari reloads the page; the progress is lost. Later the XR (CPU: WebGPU is off by default in iOS 18 Safari, `miniapp/src/features/local/README.md`, WebGPU by platform) lifts and tracks, slowly, to the end.
- Still seen (owner, 2026-10-29, iPhone SE2, iOS 26, WebGPU, a private tab, `IMG_0416.MP4`): the tab reloads during "Selecting object…", about 10 s after the selection model downloaded; Safari then shows its "Reduce Protections" banner.
- Known: lift and tracking each started their own ONNX Runtime worker (two WASM heaps, the 28.7 MB runtime compiled twice) on a device without WebGPU, so tracking also ran on the CPU. Also seen on an iPhone 17 (iOS 26, WebGPU present). Changed 2026-10-29 by reasoning, not on a device: one model worker, one model at a time on touch devices and no JS copy of the weights there, frames streamed instead of held, the lift canvas capped at 1920 px, tracking on the CPU allowed but sparse (preview 12 frames, render 2 fps), a screen Wake Lock during the work, and a crash card on the reload that offers the processor after a WebGPU crash (never switches by itself, never switches a feature off) (`miniapp/src/features/local/README.md`, Model worker, Local tracking, Track guard; `miniapp/src/features/web/README.md`, Web crash). Measured CPU-path memory in Edge is 1.2–1.4 GB peak, lift alone near 0.7 GB.
- Confirmed (owner's `JetsamEvent-2026-10-29-230748.ips`, SE2): jetsam, `com.apple.WebKit.WebContent` killed at its `highwater` limit of 1.62 GB. Measured cause: ORT's default WebGPU buffer cache keeps about 1 GB after the first lift run; touch devices now use `lazyRelease` (lift peak 512 MB, tracking 171 MB; `miniapp/src/features/local/README.md`, Model worker, gpu-buffer-cache). Not yet run on the phone. The 1.62 GB is one log: the owner will crash the SE2 several times and collect every file to confirm the limit.
- Also seen (owner, 2026-10-29, iPhone XR, iOS 18, WebGPU switched on in Safari's Feature Flags): the same reload, but no file at all appears in Analytics Data on the XR, so the cause cannot be read there and tests on it are blind. Item 6 of the owner's batch: a lighter selection model (EdgeSAM measured, `miniapp/src/features/local/README.md`, gpu-buffer-cache) would cut the lift's peak further; tracking still needs the WebGPU fix.
- Still seen after `lazyRelease` (owner, 2026-10-30, both phones): the tab dies about 3 s into "Selecting object…"; the video frame vanishes from the viewer first, then the page reloads. Logs `JetsamEvent-2026-10-30-021958.ips` (XR `iPhone11,8`, iOS 18.5: two WebContent processes killed by `highwater` at 1536 and 1544 MB) and `JetsamEvent-2026-10-30-022102.ips` (SE2 `iPhone12,8`, iOS 27.2: `highwater` at 1539 MB). So the XR does write logs, and the limit is about 1.54 GB on both, not 1.62 GB. The vanishing frame is read as WebKit dropping decoded video under memory pressure (reasoned). Why the lift needs that much on iOS when Edge shows 512 MB GPU plus 221 MB heap is unknown (how WebKit charges WebGPU memory was not measured). Change: touch devices now lift with EdgeSAM (`miniapp/src/features/local/README.md`, Lift model), 173 MB peak in Edge. Not yet run on a phone.
- Closes when: the owner repeats tap, wait, render on the iPhone XR and on the iPhone SE2 / an iOS 26 iPhone with WebGPU (`npm run phone` in `miniapp/` serves a production build for a phone through a tunnel, `miniapp/dev/README.md`) and the page stays, or the SE2 finishes on the processor after the crash card.

## iPhone viewer grey until Play

- Seen (owner, 2026-10-29, both iPhones, `IMG_0413.MP4`, `IMG_0415.MP4`): some local sources (shot on an iPhone, from TikTok) show the grey loading sheen until Play; Twitter downloads do not (`miniapp/src/features/viewer/README.md`, Video source).
- Cause found in WebKit's source and fixed by `preload='metadata'` for `blob:` sources (`miniapp/src/features/viewer/README.md`, blob-preload). Closes when: the owner's file `268C684F-….MP4` shows its frame without Play on an iPhone.

## Notifications

- Missing (owner, 2026-10-29): the app has no notification system. Wanted first for the Modal fallback: when Modal is down or out of budget, the browser render silently goes to Oracle without the pro options, and the user sees what was left out only in the result card (`miniapp/src/features/web/README.md`, Web result; `miniapp/src/features/local/README.md`, Modal fallback). The owner prefers to tell the user when it happens.
- Open: what a notification is (an in-app toast, a line in the editor, a bot message), what else uses it (offline, a held round, a finished server render), and whether the user may refuse the fallback instead of only being told.
- Closes when: the system is designed with the owner and the fallback uses it.

## Tracking on the free tier

- Missing: users without Modal (the Oracle free tier, CPU only) get no object tracking. Their crop is the centre or a fixed crop centred on the selection, so the circle does not follow a moving object.
- Known: candidates for a free CPU tracker are listed in `backend/rounds/README.md`, Tiers (OpenCV CSRT / KCF, YOLO nano + ByteTrack, MobileSAM / NanoSAM in ONNX, MediaPipe, motion centroid). None is measured on the Oracle VM yet.
- Closes when: a tracker is picked by a speed and quality test on the VM and the camera path (`camera.solve`, CPU already) consumes its track.

## Stabilization and deblur on the free tier

- Open: the stabilization work (2026-10-28) targets Modal. The motion analysis, the camera path and our own edge fill run on CPU, and the problem-frame detection for heavy deblur is planned as light CPU analysis (owner OK). ProPainter and DSTNet+ need a GPU.
- Decided (owner, 2026-10-30): the free tier offers stabilization with the cheap edge fill, on the device or on Oracle (`CLAUDE.md`, Routing priority); ProPainter only where Modal is available. Deblur is still under analysis: classical deblur split between the device and Oracle. The Oracle speed for both is in Unmeasured.

## Browser version: unverified paths

- Open (2026-10-28, the editor in the browser): only the local render was run end to end (headless Edge, software AV1, hardware hint stripped). Not run: the sign-in in an iframe against the real Telegram, a local render on a real browser with its own encoders (software AV1 speed, Firefox's codecs), the server path (upload, ingest, render from the browser), sending a local round to the chat (`POST /api/notes`) and the Mini App on a device after the editor moved into a shared chunk.
- Known: details and what each depends on are in `miniapp/src/features/account/README.md` (Frame login: Telegram may refuse framing, then the sign-in goes back to a redirect), `features/local/README.md` (Local encoders, Local size, Local server) and `features/web/README.md` (Web shell: signing in resets the draft).
- Also unverified (2026-10-28): the pro promote (background upload to Modal, job swap with the draft kept), the Oracle-first render for an allowed user (`?via=oracle` in the router, a second upload), HDR detection (`hasHighDynamicRange()` on a real iPhone HLG clip) and the Retry buttons. Nothing of this ran against a real server; the router change is not deployed (paste `router/worker.js` in the dashboard).
- Also open: the Oracle VM's `.env` must carry the same `ALLOWED_USER_IDS` as Modal's, or an allowed user signs in as `free`; an older stored session has no tier (reads `free`) until the user signs in again.
- Closes when: the owner opens the deployed page, signs in (anonymous, a normal user and an allowed one), renders a round locally with a GPU encoder, one through the server path, and sends one to the chat.

## Zero-DCE without denoise

- Open (owner, 2026-10-30): the Zero-DCE++ curve will also run on Oracle on the CPU, but FastDVDnet stays Modal-only, so there the curve runs without the denoise that `repair.py` runs first. Brightening a noisy dark video without denoising lifts the noise too.
- Known: `backend/rounds/README.md`, Repair (denoise, then curve); the weights never go to the browser (licence), `CLAUDE.md`, Owner decisions.
- Built 2026-10-30 (`backend/rounds/README.md`, Free look): the free path keeps the server order and skips only the denoise. First look (owner's PC, IMG_7045, look 0.9): the dark hair shows lifted noise blocks, as expected; not yet compared side by side with Modal.
- Closes when: the Oracle result is compared with the full Modal result on the owner's old dark noisy clips (IMG_7045, IMG_1037), and either accepted, or the Oracle path gets a cheap CPU denoise before the curve, or the slider's AI zone stays Modal-only.

## Unmeasured

- Policy (owner, 2026-10-30): no one-off benchmarks during planning; the owner runs all of these later as one parallel batch. A measured line is removed and its numbers go to the README that owns it.
- RIFE 4.25: our own ONNX export, its WebGPU speed on desktop, and its speed on the iPhone CPU. No estimate written yet (`miniapp/src/features/local/README.md`, Local plan; `backend/rounds/README.md`, Rife).
- Interpolation on Oracle (CPU, arm64): about 0.3–0.6 frames/s, estimated (owner's estimate, 2026-10-30, not yet in a README; `backend/rounds/README.md`, Interpolation).
- Deblur step 1 (classical, OpenCV) on Oracle arm64: cost per frame unknown (`backend/rounds/README.md`, Deblur, Free tier).
- Zero-DCE++ CPU throughput on Oracle with N processes (`backend/rounds/README.md`, Repair; `BUGS.md`, Zero-DCE without denoise).
- Free look on the A1 (`freelook.py`, 3 worker processes): estimate 2–4× the plain free render time for the honest part and exposure, 4–7× with the Zero-DCE++ curve, scaled from one run on the owner's busy PC (`backend/rounds/README.md`, Free look); whether the main process (maps, curve input, Zero-DCE++ at 53²) or the workers limit it is not known.
- Free look memory: estimate 0.5–0.8 GB more during a render (3 spawned workers with numpy, scipy and OpenCV loaded, about 6 frames of 2.4 MB in flight each way); the A1 has 24 GB, so only a sanity check.
- `WORKERS` = CPU count − 1 is reasoned, not tuned: the right split between the look workers, the decoder and the SVT-AV1 first pass on 4 cores is unmeasured.
- Stabilization motion time: 1–1.5 min per 60 s on 4 Workers on desktop, 2.5–4.5 min on an iPhone (estimates). Memory: about 260–310 MB on desktop, about 130 MB for the phone preset (estimates; preset sizes are not final until the jetsam analysis concludes) (`LOCAL-AI-PLAN.md`, Step 6, Stabilization; owner's estimates, 2026-10-30).
- ProPainter speed on L40S, and Render RAM with upscale (`backend/rounds/README.md`, Propainter fill, known risks).
- Stabilization motion port (2026-10-30): the parity test ran the JS LK at 336 ms per pair (854×480) in one Node thread on the owner's PC, so the 1–1.5 min above is probably low: about 2.5 min per 60 s at 30 fps on 4 Workers if browsers match Node (estimate). Unmeasured: browser and iPhone speed, the gain from more Workers, and the fill budgets (`reach`, `canvas`, kept at desktop defaults until the jetsam analysis; WebGL textures counted as WebContent memory) (`miniapp/src/features/local/README.md`, Local motion flow, Motion budget).
- Closes when: the batch has run and each line is measured, or dropped.
