# RIFE and deblur: routing and split design (proposal)

Written 2026-10-30 for the owner. Not in the repo. Every number is labelled: **observed** (ran here), **from README** (measured earlier, source named), or **estimate** (reasoned, belongs in `BUGS.md`, Unmeasured). Routing follows `CLAUDE.md`, Owner decisions: WebGPU on the device, Oracle CPU, device CPU, Modal last; Modal only when it saves about 3–5 minutes or more (about 2–3× counting the cold start).

## 0. Part A results that this plan relies on

**Observed** 2026-10-30 on the owner's PC: **Intel i5-9600K (6 cores, no SMT), Windows**, not an i7. CPU only, BelowNormal priority. During the runs about 30 leftover headless Edge processes (not this session's) kept 40–60 % of the CPU busy, so every time below is pessimistic and noisy. None of this is an Oracle or an iPhone number. Scripts and graphs: `scratchpad/rife-scripts/`, `scratchpad/rife/`.

- Export: `torch.onnx.export` (TorchScript exporter, `dynamo=False`), torch from the project's `gpu` group, **opset 17, dynamic H and W** (one graph runs any side that is a multiple of 64; checked at 320 and 640). Inputs `img0`, `img1` `[1, 3, H, W]` RGB 0..1 in gamma, `t` `[1, 1, 1, 1]`; output `[1, 3, H, W]`. `Head` and the base grid are inside the graph (`Head` runs twice per pair; the server computes it once per frame; a separate `Head` graph would do the same, 1.10).
- Size: **22.75 MB** fp32 (`rife425.onnx`, 22 753 682 B). fp16 not exported (expect about 11.4 MB).
- Ops: Conv 56, LeakyRelu 56, ConvTranspose 7, DepthToSpace 5 (PixelShuffle), Resize 14, **GridSample 18** (`mode` bilinear, `padding_mode` border, `align_corners` 1), Sigmoid 1, plus shape plumbing (Shape, Gather, Range, Cast, Expand, Where, Slice, Concat, Reshape, Transpose, Mul, Add, Div, Sub, Reciprocal, Clip).
- GridSample in ORT Web 1.31.1 (read in `miniapp/node_modules/onnxruntime-web`): the project imports `onnxruntime-web/webgpu` → `ort.webgpu.bundle.min.mjs` → the native WebGPU EP inside `ort-wasm-simd-threaded.asyncify.wasm`, which registers `onnxruntime::webgpu::GridSample` (it also carries "unsupported mode" / "unsupported padding_mode" errors, so the supported subset is not proven for our attributes until a browser run). The JSEP build (`ort.mjs`) has a WGSL GridSample with `zeros` / `border` / `reflection` and both `align_corners`. **Not run in a browser.**
- Parity, ORT CPU vs torch fp32 on 4 real pairs (frames k and k+2 of `miniapp/dev/media/proxy.mp4`, a 960×540 30 fps clip, centre 540² crop scaled to 640 and 320): **max abs diff 3.7e-4** (640), 3.0e-4 (320), on a 0..1 scale (under 0.1 of an 8-bit level). OpenCV DNN vs ORT: 1.1e-4.
- Quality check against the real middle frame (mean abs, 0..1): RIFE 0.0053–0.0081, a plain 50/50 blend 0.0125–0.0259.
- CPU time per pair, median of 5 after warm-up (ORT 1.x CPU EP, from PyPI via `uv run --with`):

| Graph | Side | 4 threads | 1 thread |
|---|---|---|---|
| full flow | 320² | **345 ms** | 747 ms |
| full flow | 640² | **1541 ms** | 2488 ms |
| flow at 1/2 inside the graph (`SCALES` ×2) | 640² | 1062 ms | 1952 ms |
| OpenCV 5.0 DNN, full flow | 320² / 640² | 373 / 1417 ms | — |

- Half scale inside the graph saves only about 30 % on CPU (the 18 warps and `Head` stay at full size) and lost quality (true-middle error 0.0078–0.0113 vs 0.0053–0.0081). **Outer half scale** (run the whole model at 320 on downscaled frames, upsample flow ×2 and the mask, warp the 640 frames once, torch check) matched full 640 against the true middle (0.0057–0.0077 vs 0.0053–0.0081; mean diff to full 640 0.003–0.006, max 0.9 at a few occlusion pixels) at about a quarter of the model cost. Caveat: these 640 frames are upscaled from a 540p proxy, which flatters any downscaled flow; judge by eye on real 4K / 1080p crops before choosing.
- Peak working set of the python process: 765 MB (half graph run) with torch, the model and the reference runs all loaded, so only an upper bound, not an ORT number.
- Licence: RIFE code and weights are MIT (hzwer/Practical-RIFE, HolyWu/vs-rife; `backend/rounds/RIFE-LICENSE`). The ONNX file is our export of MIT weights and stays under MIT with that notice; hosting it needs the notice next to it.

## 1. Interpolation (RIFE 4.25)

### 1.1 What the work is

`smooth.frames` (server) decides per output slot (j / 60 s): a real frame within `SNAP` (used as is), a held frame (across a tracking cut, past `MAX_GAP`), a seam mix (Seams), or a RIFE frame between two kept neighbours at τ. Only the RIFE slots cost model time. So the unit of work is **one synthesized slot = one IFNet run on a pair** (plus `Head` once per kept frame, cheap).

Synth count for 60 s of output (3600 slots), from the slot rule:

| Source | Synth slots | Share |
|---|---|---|
| 30 fps | 1800 | 50 % |
| 24 fps | about 2880 | 80 % |
| 25 fps (Android round) | about 2160 | 60 % |
| 60 fps, 5 % gaps / dupes | about 180 | 5 % |
| 59.94 fps, clean | a few (phase drift of 59.94 vs 60) | under 1 % |

The broken-source logic already gives this for free: duplicates are dropped before RIFE (Duplicate frames), gaps become synth slots, long holes and camera switches become seams. The planner reuses it as is; it only has to **run the decision part first** (see 1.4) so the synth count is known before any model runs.

### 1.2 Executors and their cost model

For executor e: `T_e(n) = start_e + n × c_e + xfer_e(n)`

- `start_e`: model download (first time only, Cache API), session creation, shader compile; on Modal the cold start plus weights load.
- `c_e`: ms per synth slot at the chosen size and flow scale, **measured by the probe** (1.6), never assumed.
- `xfer_e`: moving inputs and outputs when e is not the machine that encodes the note (1.5).

Candidates, in owner priority order:

1. **Device WebGPU** (`job.gpu`): ORT Web WebGPU EP, the same ONNX as Part A. One session in the shared model worker (Model worker), loaded after tracking is dropped on touch devices (one-model rule).
2. **Oracle CPU** (A1, 4 OCPU arm64): only when the job is already on Oracle (server path) or when the planner counts the transfer. Runtime: see 1.8.
3. **Device CPU** (ORT Web WASM, single-threaded on GitHub Pages: no COOP/COEP, so no WASM threads; parallelism only by several Workers each with its own session, which multiplies the memory).
4. **Modal** (pro only): the existing `smooth.frames` in `Render` on the GPU, unchanged.

### 1.3 Planner rule

Inputs: `N` synth slots (from 1.4), per-executor `c_e` and `start_e` (probe + cache), the job's time budget `B`, tier.

1. For each executor allowed for the tier and device, `T_e = start_e + N × c_e + xfer_e`.
2. Walk the priority list. Take the first executor with `T_e ≤ B`. Within one machine, parallelism is internal (device Workers, Oracle processes, Modal chunk fan-out).
3. If none fits alone, try **one split of the two best non-Modal executors**: share `n_e ∝ 1 / c_e` (equal finish time), `T_split = max(start_e + n_e × c_e + xfer_e)`. Accept if `T_split ≤ B` and the split saves at least `SPLIT_GAIN` (proposal: 25 % of the best single time; under that the extra transfer and failure modes are not worth it).
4. Modal (pro only) replaces the best non-Modal plan only when `T_best − T_modal ≥ MODAL_GAIN` (owner: 3–5 min; proposal: `MODAL_GAIN = 180 s` and `T_best / T_modal ≥ 2`). A minute's gain never goes to Modal.
5. Nothing fits `B` and no Modal: run the best plan anyway and show its estimate ("about 12 min"), or offer to switch the option off. Never block silently (owner: fewer options is acceptable, a hang is not).

`B` is an owner decision (question 1). Proposal: no hard budget; `B` only decides whether to show a warning, and the split/Modal rules use the gains above.

Example, a 60 s note from a 30 fps source (1800 synth slots), model time only:

| Executor | Per pair | Total | Basis |
|---|---|---|---|
| Owner PC CPU, 4 threads, 640 full | 1.54 s | 46 min | observed (busy PC) |
| Owner PC CPU, 4 threads, outer 320 → 640 | about 0.4 s | about 12 min | observed 345 ms + warp, estimate |
| Owner PC CPU, 1 thread, 640 / 320 | 2.5 / 0.75 s | 75 / 22 min | observed |
| iPhone WASM, single thread | several × the PC's single thread | hours at 640 | estimate |
| Oracle A1, 4 OCPU, 640 / outer 320 | 2.3–3.9 / 0.6–1.0 s | 70–115 / 18–30 min | estimate (1.5–2.5× the PC) |
| Desktop WebGPU (GTX 1660 Ti) | 30–80 ms | 1–2.5 min | estimate |
| Modal L4, 704² fp16 | 30–60 ms + about 1 min cold start | 2–3 min | estimate |

So: desktop WebGPU runs it alone; without WebGPU a full minute at 30 fps is out of reach on the device CPU, and long on Oracle. A pro user without WebGPU goes to Modal (saves far more than 5 min). The device CPU is realistic for **broken sources** (60 fps with a few % gaps: about 180 synth slots, 2–8 min) and short notes. For a free user without WebGPU on a 30 fps minute the choice is Oracle for 20–30 min or no interpolation (owner question 1).

### 1.4 Decide first, synthesize second

Today `smooth.frames` decides and synthesizes in one streaming pass. The split needs the **slot plan** first:

- Pass 1 (cheap, no model): decode timestamps + the 4×4 averaged luma inside the camera window (`smooth.luma`, `moved`), the duplicate drop, the seam decisions, `pick` per slot. Output: kept frames `[t]`, seams, and per slot one of `real k` / `held k` / `synth (a, b, τ)` / `seam [(s, k)…], soft`. Pure data, a few KB.
- Pass 2: decode again, crop the kept frames, run IFNet only for `synth` slots, mix seams, encode.

The browser already decodes twice when stabilization is on (Local motion flow); pass 1 can share that decode. Server: same split inside `smooth.py`, which also makes Modal chunk fan-out possible (Upscale chunks pattern) if 60 s at 704² on one L4 is ever too slow.

### 1.5 Segments and stitching

- A segment is a contiguous range of output slots `[j0, j1)`. Its inputs are the kept frames from the anchor at or before `t(j0)` to the anchor at or after `t(j1 − 1)`; so two neighbouring segments **share one kept frame** at the border (two when the border falls between two synth slots). `Head` features are recomputed on each side (cheap).
- Borders go on a `real` or `held` slot whenever possible (for 30 → 60 every even slot is real), then no pair crosses the border at all. A seam window `[a − LEAD, b + LEAD]` is never cut: it needs RIFE frames from both sides and the dissolve.
- Sizes: segment length ≥ about 2 s of output (amortises the shared anchors and per-segment overhead); count = executors × in-flight depth.
- Stitching: **the encoder lives on one machine** (one MP4, one codec config, the size budget of Note size is global; bitstreams from WebCodecs and SVT-AV1 cannot be concatenated into one track). The helper returns only its synthesized frames, the encoder machine slots them in by index.
- Transfer for a cross-machine split (device ↔ Oracle). Raw 640² RGB is 1.2 MB per frame, so frames travel as a high-quality intermediate video: the anchor crops (padded side) one way, the synth frames back, both as one short HEVC / AV1 clip per segment at high quality (about 30–60 KB per 640² frame, estimate). A 60 s 30 → 60 job split half to Oracle: about 900 anchors up and 900 synth frames down, about 30–55 MB each way (estimate). Cost: one extra lossy generation on the helper's frames only.
- The cross-machine split also needs the camera path on both sides: the device sends the path rows (a few KB), not the source, when it sends the crops. When the job is already on Oracle (server path), Oracle has the source and the device is not a helper at all (the device would have to download the source).

Recommendation: **v1 = one machine per job** (device or Oracle or Modal) with internal parallelism; cross-machine split as v2, only if the batch measurements show device and Oracle rates within about 2× of each other on real phones. Reason: on desktop WebGPU the device will almost certainly win alone; the split matters only for phones without WebGPU, where it costs the most upload.

### 1.6 Speed probe at job start

- Device: after the model loads, time the **first real pairs of the job** (not throwaway pairs): 1 warm-up + 3 timed at the chosen size. Cost about 4 pair times plus session creation. Store `{c, start, size, scale, backend, adapter, ua}` in `localStorage` (per-viewer convenience, try/catch), reuse for 7 days, re-probe when the backend falls back (WebGPU → WASM) or after a Track guard crash.
- Oracle: the VM is one fixed machine; `c_oracle` is measured once at service start (3 pairs on a bundled 640² test pair) and served with the job (`GET /api/jobs/:id` or a `capabilities` field), scaled by the current load (`os.getloadavg()[0] / cpu_count`) so a busy VM looks slower.
- Modal: never probed per job (credits, cold start). `c_modal` and `start_modal` come from the `render.encode` stats already logged (`synth`, `fps`); a constant in the client until measured.
- The probe decides the plan; the plan is revised once mid-job if the observed rate drifts by more than 30 % (thermal throttling on phones), only towards a cheaper executor, never towards Modal mid-job.

### 1.7 Flow at half scale

- RIFE's own `scale` knob (Practical-RIFE `scale_list = [16/s, 8/s, 4/s, 2/s, 1/s]`): with `s = 0.5` our `SCALES` become `(32, 16, 8, 4, 2)`: the five IFBlocks see 1/2 the resolution, the final warp and mask still use the full-size frames. Block cost goes with (side / scale)² × width², so most of the cost (the two finest blocks) drops about 4×. Part A measured it at 640: only about 30 % faster on CPU (1062 vs 1541 ms) and worse against the true middle, because the 18 GridSample warps and `Head` still run at full size.
- **Proposed instead: outer half scale.** Run the whole model on frames downscaled to half (320 for 640), upsample the flow (×2 in value) and the mask, and do one final warp + blend of the full-size frames (two bilinear lookups and a mix per pixel: a WebGL / WGSL shader or a tiny second graph). Part A: same error against the true middle as full 640 on its 4 pairs, at about a quarter of the model cost. Unverified on sharp real crops (the test frames were a 540p proxy), so by eye first. It needs the graph to output `flow` `[1, 4, h, w]` and the mask logit `[1, 1, h, w]` instead of the image: a third export, the same weights.
- Trap (in-graph half scale): every block downsamples by `scale` and then by 4 more (two stride-2 convs), so the side must be a multiple of `64 × 2`: 640 works, **704 (the server's padded side) does not** (5.5 × 128). The outer variant has the same rule on its small side: 704 → 352 is not a multiple of 64; it needs side 768 (`PAD` 64) → 384, or 640 → 320 with less padding.
- Use: phones and WASM by default (memory and time), desktop WebGPU and Modal keep full scale. Judged by eye per media.md before shipping (side-by-side columns of a fast pan and of the IMG_4042 gap).
- Rejected: the in-graph `SCALES` ×2 (measured above: small gain, worse result).

### 1.8 Memory (iPhone)

Peer's rule (not final): one GPU stage peaks at or below about 0.5 GB and is released between runs; the page stays well under about 1.5 GB.

- RIFE is much smaller than SAM 2.1: 5.66 M parameters, 22.6 MB fp32 (11 MB fp16, not exported yet). Activations at 640² full scale: the finest block holds 32-channel maps at full size (640² × 32 × 4 B = 52 MB each, a few alive), plus the warps; at half scale the finest maps are 1/4 of that. Part A has no clean ORT number (765 MB peak for the whole python process with torch loaded, an upper bound only); the WASM heap and WebGPU `lazyRelease` peaks are unmeasured. The outer half-scale variant runs the network at 320², a quarter of the activation memory of 640².
- Rules: lazyRelease on touch devices (gpu-buffer-cache), one-model (drop tracking and lift before RIFE), one RIFE session per page (no Worker pool on phones: each Worker would hold its own WASM heap), frames in flight capped (a ring of the kept crops needed by the current segment: about 1–1.5 s, as `smooth.frames` already streams).
- The render encoder (WebCodecs) and the decode run at the same time; the budget is page total, so measure the whole render, not the model alone.

### 1.9 Oracle without torch

`smooth.py` and `rife.py` import torch; the A1 image has none (free stabilization was ported to numpy for the same reason). Options:

1. **OpenCV DNN** (`cv2.dnn.readNetFromONNX`, OpenCV 5.0, already a main dependency, approved for the VM): no new dependency. **Part A: it runs our graph** (OpenCV 5.0.0, the version in the lock) at 373 / 1417 ms per pair at 320 / 640 with 4 threads, max diff 1.1e-4 to ORT: as fast as ORT on x86. Proposed as the Oracle runtime; arm64 speed unknown.
2. **onnxruntime** (MIT, `aarch64` Linux wheels on PyPI): **a new dependency, needs the owner's OK.** Only worth it if cv2.dnn turns out much slower on arm64 than ORT (to measure on the A1 with both, in the batch).
3. A numpy port of IFNet: rejected, convolution-heavy, would be many times slower than either runtime.

Either way the A1's 4 cores run one session with intra-op threads (one process, not several: the model is compute bound and a pool would only split the same cores). The free render (`crop.render`) gains a `freesmooth.py` (the decision pass of 1.4 without torch, plus the ONNX call).

### 1.10 Files (approximate lines)

| File | Change | Lines |
|---|---|---|
| `backend/rounds/smooth.py` | split into `plan(...)` (decision pass) and `frames(...)` (synth pass) | about 170 now, about 190 after (or `slots.py` new, about 90) |
| `backend/rounds/freesmooth.py` | new: synth pass for Oracle on ONNX (cv2.dnn or onnxruntime), numpy crop | about 130 |
| `backend/rounds/crop.py` | wire `interpolate` on the free tier | +10 |
| `backend/rounds/api.py`, `free.py` | lift `interpolate` out of the pro-only set when the Oracle path exists; `c_oracle` in the job | +10 |
| `deploy/setup.sh` | fetch the ONNX (sha256), as the Zero-DCE weights | +5 |
| `backend/rounds/README.md` | Interpolation, Rife, new `Rife onnx`, `Interpolation plan` | +40 |
| `miniapp/src/features/local/smooth-plan.js` | new: decision pass (timestamps, luma cells, duplicates, seams, `pick`), port of the Python, parity-tested like `camera.js` | about 180 |
| `miniapp/src/features/local/rife-infer.js` | new, in the model worker: `Head` graph once per frame, IFNet graph per pair (flow + mask out for the outer variant), the final warp + blend shader | about 120 |
| `miniapp/src/features/local/smooth.js` | new: synth pass inside `render.js`'s `video.process` (crop at padded size, slots out with explicit timestamps; output rate 60 ≠ input rate, so it returns several samples per input) | about 160 |
| `miniapp/src/features/local/route.js` | new: probe, cost model, planner (also for deblur and stabilization; today `routeOf` in `plan.js` has no time model) | about 120 |
| `weights.js`, `model-worker.js`, `plan.js`, `draft.js` | registry entries (RIFE `Head` + IFNet graphs, sha256), `interpolate` local flag, STAGES row | +30 |
| `miniapp/src/features/local/README.md` | Local interpolation, Rife onnx, Stage routing update | +40 |
| Hosting the ONNX | owner decision: an HF model repo of ours (MIT) or a GitHub release asset | — |

### 1.11 Unknowns (ready for BUGS.md, Unmeasured)

- RIFE 4.25 ONNX on desktop WebGPU (ORT Web 1.31.1 native EP, GTX 1660 Ti, Edge): ms per pair at 640² / 704², and whether all 18 GridSample nodes stay on the GPU; estimate 30–80 ms per pair.
- RIFE 4.25 ONNX on the iPhone (iOS 26 WebGPU, SE2) and on WASM (XR, iOS 18): ms per pair at 320² (outer half scale); estimate 2–4× the PC's native single thread (0.75 s) on WASM.
- RIFE ONNX peak memory in WebKit (WebGPU `lazyRelease`, WASM heap) at 640² and 320²; estimate under 0.3 GB at 320².
- RIFE on the Oracle A1 (4 OCPU) through cv2.dnn and onnxruntime: ms per pair at 320² and 640²; estimate 1.5–2.5× the owner's PC (PC: 345 / 1541 ms, 4 threads, busy).
- Outer half-scale flow (320 → 640) vs full 640 on sharp real crops (fast pan, IMG_4042 gap): by eye; on a 540p proxy it matched full 640.
- PC CPU numbers of Part A taken with about 40–60 % background load (leftover headless Edges): rerun on a quiet PC in the batch.
- Transfer size of anchor crops and synth frames as a high-quality intermediate clip (640², HEVC / AV1): estimate 30–60 KB per frame.
- Modal L4 RIFE throughput at 704² (`render.encode` stats `synth`, `fps`): not logged from a real job yet.

### 1.12 Owner questions (interpolation)

1. Free user without WebGPU and a long 30 fps note: offer interpolation on Oracle at 20–30 min (estimate), or keep it to short notes and broken-source repairs (few synth slots), with the estimate shown?
2. v1 one machine per job (recommended) or the cross-machine device + Oracle split from the start?
3. Oracle runtime: OpenCV DNN (works, no new dependency; proposed) or onnxruntime (new dependency, only if arm64 shows cv2.dnn much slower)?
4. Outer half-scale flow (320 → 640) on phones and Oracle by default, after an eye test on real crops? It changes the padded side (768 or 640).
5. Where to host our ONNX (MIT, ours): an HF model repo under the owner's account, or a GitHub release asset of this repo?

## 2. Deblur

### 2.1 Steps and where they can run

| Step | What | Where |
|---|---|---|
| 0 | nothing | — |
| 1 | classical `lucky.py` (DIS flow, re-blur, transfer) | Oracle (CPU, OpenCV approved), device (needs a port), Modal |
| 2–4 | DSTNet+ L | **Modal only** |

Steps 2–4 stay Modal-only for two independent reasons: (1) the weights have no licence (all rights reserved); the owner accepted them only fetched at build time and never redistributed (`backend/rounds/README.md`, DSTNet+), and shipping them to a browser is redistribution; (2) cost: 1429 ms per frame at 384² on the local GPU (from README), far too heavy for a phone or the A1.

### 2.2 Step 1 on Oracle

- Nearly done in code: `deblur.py` and `lucky.py` use only numpy, scipy and OpenCV; `crop.render` imports `deblur` lazily; `api.FREE_DEBLUR = 0` is the one switch. Turning it to 1 is the change, after the A1 measurement.
- Cost: 185–234 ms per processed frame at 384², about 0.6 s at 640², the stream with detection 200–280 ms per frame at 384 (from README, Windows x86, 3 threads). On a shaky clip about 70 % of frames are flagged (Deblur detect). A1 arm64: unknown (estimate 1.5–2.5× slower per frame).
- Parallel on the A1: blocks of `BLOCK` 24 frames are independent given `reach + CONTEXT` frames of context each side, so a pool of 3 processes over blocks (as `freelook.py`) is the natural split; the main process keeps decode and encode.

### 2.3 Step 1 in the browser

Can it be ported like the motion flow? Yes, with one hard part:

- Easy (per-pixel, WebGL2 fragment shaders or plain JS): Sobel / Tenengrad, linear-light conversions, `remap` (linear and cubic), the motion-blur accumulation (up to 41 taps of `remap`), Gaussian blur, 3×3 erode / dilate, the weighted transfer and clamp, the weights / flags logic (pure JS, tiny).
- Hard: **DIS optical flow** (`cv2.DISOpticalFlow`, MEDIUM preset, finest scale 0). Per processed frame `lucky.restore` runs up to 2 (velocity) + 2 × 4 (forward-backward alignment of 4 donors) = **10 dense flows at 640²**, plus one small flow per frame for `speed`. Options:
  1. Scalar JS port of DIS in Workers (as `motion-flow.js` ported LK): pyramid, inverse search per patch, densification, variational refinement. Parity testable against cv2 like Test C. About 350–450 lines in two files. Speed estimate: 3–6× OpenCV's SIMD per flow, so about 2–4 s per processed frame per Worker at 640², 0.5–1 s with 4 Workers on desktop (estimate).
  2. OpenCV.js custom build with `DISOpticalFlow` exported: exact parity, no port, but a multi-MB WASM (estimate 4–8 MB) and a custom build to maintain; the default opencv.js whitelist does not export DIS (not verified here).
  3. A WebGPU / WebGL2 DIS: the fastest, but no parity with OpenCV and the largest effort.
  - Proposal: option 1 for parity (same approach as the motion port), WebGL2 for the per-pixel parts when the device has it, a phone preset only after measurement.
- Memory: the luma window (±0.3 s plus the look-ahead, about 50 frames at 60 fps, 640² float32 = 1.6 MB each) is about 80 MB, plus the 10 flows of one frame (3.2 MB each). Fits the phone rule easily (estimate).
- Order trap: the server deblurs **source pixels before the crop** (README, Deblur: blur lives on source pixels). The browser render crops inside `video.process`, so deblur must run on the decoded sample before the crop draw, at the working size (crop side ≤ 640). That is a full-frame luma pass in the browser: decode at the working size, compute the luma delta, upsample, add. In WebGL2 this is one more pass before the crop draw; in JS it needs the frame's pixels (a `copyTo` of the luma plane).

### 2.4 Split and routing for step 1

- Same planner as 1.3, unit = one **processed** frame (flagged + context), known after the cheap detection pass (Tenengrad + the small DIS speed), which is itself the "decide first" pass of 1.4.
- Priority: WebGPU / WebGL2 device port (when 2.3 exists with a GPU part), then Oracle, then device CPU (JS Workers), then Modal (pro, in `Render`).
- Cross-machine split: same transfer problem as RIFE, worse: the deblur output is a luma delta on the **source** before the crop, so a helper must send back a working-size delta per processed frame. v1: one machine per job.

### 2.5 Files (approximate lines)

| File | Change | Lines |
|---|---|---|
| `backend/rounds/api.py` | `FREE_DEBLUR` 1 after the A1 measurement | 1 |
| `backend/rounds/freedeblur.py` | new: block pool of 3 processes around `deblur.frames` on the A1 (only if one process is too slow) | about 80 |
| `miniapp/src/features/local/dis.js` + `dis-worker.js` | new: DIS port (pyramid, inverse search, densify, variational refinement) | about 200 + 150 |
| `miniapp/src/features/local/lucky.js` | new: port of `lucky.py` (sharpness, re-blur, align, transfer) | about 180 |
| `miniapp/src/features/local/deblur.js` | new: port of `deblur.py` detection, run plan and stream (`flags`, `weights`, blocks) | about 150 |
| `render.js`, `plan.js`, `draft.js` | deblur before the crop draw, STAGES row, local level cap 1 | +30 |
| READMEs | `Local deblur`, `Deblur` free tier update | +40 |

### 2.6 Unknowns (ready for BUGS.md, Unmeasured)

- Deblur step 1 on the Oracle A1: ms per processed frame at 640² working size, one process and a pool of 3; estimate 1.5–2.5× the owner's PC.
- DIS JS port speed per 640² flow in a browser Worker (desktop and iPhone); estimate 200–400 ms desktop, 3–4× that on an iPhone.
- Deblur step 1 browser memory (luma window + flows), estimate about 100–150 MB.
- Whether the default opencv.js build exports `DISOpticalFlow` and its WASM size.

### 2.7 Owner questions (deblur)

1. Turn on step 1 on the free tier as soon as the A1 time is measured (a one-line switch), even before any browser port?
2. Browser port: JS DIS port with parity (proposed), or an OpenCV.js custom build (a new multi-MB dependency)?
3. Is a cheaper phone preset (fewer donors, DIS ULTRAFAST) acceptable even though it departs from the server result?

## 3. Top decisions for the owner

1. **Interpolation for free users without WebGPU**: a 60 s 30 fps note is about 20–30 min on Oracle even at half-scale flow (estimate), and far longer on a phone CPU. Offer it with an estimate, limit it to short notes and broken-source repairs, or leave it off there?
2. **Outer half-scale flow** (model at 320, final warp at 640) as the default on phones and Oracle: about 4× cheaper and equal on the test pairs, but those were soft proxy frames; approve an eye test on real crops, and the padded-side change (768 or 640) it implies.
3. **v1 is one machine per job** (device or Oracle or Modal, parallel inside the machine); the cross-machine device + Oracle split (anchor crops up, synth frames down as an intermediate clip, about 30–55 MB each way for a minute) comes later, only if the batch shows comparable rates. Agree?
4. **Oracle runtime for RIFE**: OpenCV DNN (already approved, runs our graph, as fast as ORT on x86) instead of a new onnxruntime dependency. And **deblur step 1 on the free tier** as soon as the A1 time is measured (`FREE_DEBLUR` 1, a one-line switch).
5. **Deblur in the browser**: a parity JS port of OpenCV's DIS flow (about 350 lines, as the LK port) plus WebGL2 for the per-pixel parts, or an OpenCV.js custom build (new multi-MB dependency); and whether a cheaper phone preset that departs from the server result is acceptable. Steps 2–4 stay Modal-only (unlicensed weights, cost).

Also needed: where to host our ONNX (HF repo of the owner or a GitHub release), and the Modal gain threshold as a number (proposed: at least 180 s and at least 2×).
