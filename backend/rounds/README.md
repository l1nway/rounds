# rounds (backend package)

One Modal app (`app.py`) that receives the source video, serves the Mini App and renders the video note. Every module below is owned by one concern; the contracts in this file are what the modules agree on, so a change to a contract updates this file and every side in the same step.

## Files

| File | Concern | Runs in |
|---|---|---|
| `app.py` | Modal entry points: functions (`web`, `ingest`, `setup`, `watch`), the `Render` class (`warm`, `prepare`, `run`) and the `Lift` class; registers `painter.Painter` and `upscale.Upscaler` by import; re-exports the `cloud` names (Upscale image) | — |
| `cloud.py` | Modal infrastructure: the `rounds` app object, images (ffmpeg, RIFE and repair weights, `deep-filter`), Volumes, Dicts, the secret | `app`, `upscale` (through `app`) |
| `config.py` | env (from the `rounds` secret) and shared constants | everywhere |
| `api.py` | FastAPI: Telegram webhook, Mini App and browser API, the tier guard (Tiers) | `web`, `free` |
| `files.py` | signed file URLs and the file route, browser upload in parts, client-rendered notes (Browser upload, Client note) | `web`, `free` |
| `auth.py` | who is calling: Mini App `initData`, browser sessions, Telegram sign-in (OIDC) | `web` |
| `bot.py` | aiogram handlers: accept videos, Mini App button, progress messages, note delivery and Resend | `web`, `ingest`, `render` |
| `transfer.py` | MTProto (Telethon) download of the source | `ingest` |
| `pipeline.py` | job orchestration: `ingest_job`, `render_job`, progress, stage timings | `ingest`, `Render`, `retry`, `free` |
| `retry.py` | retry of stuck jobs: `start`, `watch` (Stuck jobs) | `web`, `watch` |
| `locate.py` | where the object is: decode → track → scene changes, the track cache, `prepare_job`, the camera path of a job (Track cache) | `Render` |
| `source.py` | the source: ffprobe, frame cadence (gaps), duplicate frames, output rate | `ingest`, `render` |
| `media.py` | proxy + filmstrip, frame decode, tracking frames, scene cuts | `ingest`, `render` |
| `audio.py` | the note's audio chain: noise reduction (DeepFilterNet3), loudness | `render` |
| `render.py` | GPU renderer: subpixel crop + resample + colour pipeline → raw frames for `encode` | `render` |
| `encode.py` | note encoder: codecs, two passes to the size budget, audio, fit loop | `render` |
| `upscale.py` | AI upscale of a small source to 640 (FlashVSR v1.1 tiny-long): its CUDA image, the `Upscaler` worker class, the chunk fan-out from the render | `render`, `pipeline`, `app` (imported at its end) |
| `smooth.py` | 60 fps interpolation: timed decode, duplicate drop, retiming with RIFE | `render` |
| `seam.py` | seams over holes in the source: time remap, blurred dissolve | `render` |
| `rife.py` | RIFE 4.25 network, vendored (MIT, `RIFE-LICENSE`) | `render` |
| `repair.py` | AI repair of the HDR slider: FastDVDnet denoise + Zero-DCE++ low-light curve over the frame stream (Repair) | `render`, `Lift` |
| `fastdvdnet.py` | FastDVDnet network, vendored (MIT, `FASTDVDNET-LICENSE`) | `render`, `Lift` |
| `zerodce.py` | Zero-DCE++ network and curve, vendored (CC BY-NC 4.0, `ZERODCE-LICENSE`) | `render`, `Lift` |
| `dstnet.py` | DSTNet+ video deblur network, vendored pure-torch port (Apache-2.0, `DSTNET-LICENSE`) (DSTNet+) | deblur (Deblur) |
| `deblur.py` | deblur of the decoded frame stream: problem-frame detection, run planning, steps 1–4, DSTNet+ in-process (Deblur) | `render`, `crop` |
| `lucky.py` | classical deblur: sharp-pixel transfer from aligned neighbours on luma, OpenCV (Deblur classical) | `deblur` |
| `color.py` | torch colour pipeline: YUV↔RGB, transfer functions, HDR→SDR, chroma resampling | `render` |
| `look.py` | HDR look: local tone mapping, clipped-channel rebuild, smart exposure (Look) | `render`, `Lift` |
| `track.py` | object tracking (SAM 2.1 video, HF transformers) | `render` |
| `follow.py` | track preview: the selected object's box over the trim range on the proxy (SAM 2.1 video) | `Lift` |
| `segment.py` | tap-to-lift: candidate outlines of the tapped object on one proxy frame (SAM 2.1 image) | `Lift` |
| `camera.py` | virtual camera path (L1 optimal path, HiGHS LP) | `render` |
| `motion.py` | global camera motion for stabilization: feature flows on a small grey decode, per-frame similarity, the stabilised world and the window placer (Stabilization) | `render` |
| `fill.py` | edge fill of a stabilised note: the analytic missing mask, honest pixels from neighbouring frames, push-pull extension (Edge fill); the fallback of ProPainter and the path wherever it does not run | `render` |
| `paint.py` | ProPainter edge fill from the render: hole masks, chunk plan, fan-out to `Painter`, compositing, per-chunk fallback to `fill` (Propainter fill) | `render` |
| `painter.py` | ProPainter worker: its image, the `Painter` GPU class, the inference over one chunk (Propainter worker; `PROPAINTER-LICENSE`, S-Lab, non-commercial) | `Painter`, `app` (imported at its end) |
| `tags.py` | source metadata for the note: read at ingest, MP4 box rewrite after the encode | `ingest`, `render` |
| `free.py` | the free tier's server on Oracle: the same API on SQLite and the local disk, CPU ingest and render queues (Free server) | Oracle |
| `store.py` | SQLite and disk stand-ins for `modal.Dict` and `modal.Volume` (Free store) | Oracle |
| `crop.py` | CPU renderer of the free tier: a fixed square crop by FFmpeg → `encode` (Free render) | Oracle |

## Contracts

**Time and space.** All backend coordinates are in source pixels of the *display-oriented* frame (rotation metadata applied, as ffmpeg's autorotate does), origin top-left. The API and the Mini App use normalized coordinates (0..1 of the display-oriented frame). Times are seconds (float, millisecond precision) on the source timeline. A job's tracking timeline is CFR at `FPS` (config, 30): frame `k` is at `start + k / FPS`, `N = round((end - start) * FPS)`; the tracking frames, the track and the camera path have length `N`. The note has its own CFR rate (`source.out_rate`, Output rate); `camera.sampler` maps the path onto it.

**Volume** `rounds-data`, mounted at `/data`; one folder per job, `/data/jobs/<job_id>/`:

- `source.<ext>`: the original file, untouched.
- `proxy.mp4`: for the Mini App only. SDR BT.709, long side 960, CFR 30, keyframe every 15 frames (fast accurate seeking), H.264 + AAC 96k, `+faststart`.
- `filmstrip.jpg`: `tiles` frames evenly spread over the whole source, side by side in one row, each `tile_width × tile_height` (height 96).
- `note.mp4`: the result. Debug artifacts (`track.npz`, `path.npy`) may sit next to it.

**Job** (`modal.Dict` `rounds-jobs`, key = job id, 10 url-safe chars):

```
id, user_id, chat_id, source_message_id, status_message_id, queued_at (unix s, set when ingest / render is spawned), name (the source's file name or None, Note send)
status: 'ingesting' | 'ready' | 'rendering' | 'done' | 'failed'
stage: None | 'queued' | 'decoding' | 'tracking' | 'cuts' | 'framing' | 'rendering' | 'sending',  progress: 0..1,  error: str | None
meta: source.probe() result (tags included) + dupes, has_audio (re-checked on the proxy), interpolable (set by ingest after the proxy)
proxy: {width, height, fps},  filmstrip: {tiles, tile_width, tile_height}
request: None | {start, end, prompt: {time | None, points: [[x, y, label]], box: [x0, y0, x1, y1] | None, mask: str | None}, options: {zoom: bool, loudnorm: bool, interpolate: bool, metadata: bool, upscale: bool}, codec: 'av1' | 'hevc' | 'vp9', denoise: 0..1, look: 0..1, exposure: -2..2}
```

`options` is a free `dict[str, bool]` read with `.get`, so an unknown or retired key (`hires`, `hd720`, `hd1080`, `hevc` of older Mini App builds, High resolution) is ignored. `label` is 1 for "this object", 0 for "not this". `prompt.time` lies inside `[start, end]`; `end - start ≤ MAX_DURATION`. `codec` (default `av1`; requests stored before the field have none, `pipeline` reads it with `.get` and the same default) must match the keys of `encode.CODECS` and the Mini App's `CODECS` (Codecs). `denoise` is the noise slider (Denoise), a float because `options` holds only booleans; default 0 (off), also for requests stored before the field; `pipeline.render_job` merges it into the `options` it hands to `render.render` as `options['denoise']`. `look` (the HDR slider, 0 = off) and `exposure` (EV, 0 = off) travel the same way, top level, default 0 (Look). `prompt.mask` is the outline the owner picked in the Mini App (Lift mask), a `data:image/png;base64,` URL of at most `MASK_CHARS` (90 000) characters; jobs and clients without it send `None`.

**Module functions** (pure of Modal, so they run and test locally):

- `source.probe(path) -> dict`: `duration`, `fps` (nominal, Source cadence), `gaps` (share of missing frames), `stream` (index of the video stream), `width`, `height` (display-oriented), `rotation`, `transfer` (`'sdr' | 'hlg' | 'pq'`), `matrix` (`'bt709' | 'bt2020' | 'bt601' | ''`), `full_range` (bool; full-range Android H.264 passes through `-pix_fmt yuv420p` untouched, so the renderer must know), `bit_depth`, `has_audio`, `codec`, `tags` (source tags the note can carry, Note metadata). Without `matrix` the renderer assumes 709 for SDR and 2020 for HDR.
- `media.make_proxy(src, job_dir, meta) -> ({'proxy': {...}, 'filmstrip': {...}}, {'dupes', 'has_audio'})`. `probe`, `make_proxy`, `track_frames` and `render` raise `source.Unreadable` with a readable reason for a source they cannot use (Broken sources).
- `media.track_frames(src, meta, start, end, long_side=1024) -> np.ndarray` `(N, H, W, 3)` uint8 RGB SDR, a memmap in a local temp dir.
- `media.changes(frames) -> np.ndarray` `(N,)`: the histogram change of every frame from the one before (`d[0]` = 0); `media.scene_cuts(d) -> list[int]`: indices of frames that start a new shot. Split in two so the track cache can keep `d` and cut any sub-range (Track cache).
- `segment.Segmenter().segment(job_id, at, points, box, (w, h)) -> {candidates: [{mask, area}], best}` (Lift).
- `follow.follow(net, proxy, (w, h), prompt, start, end, stop) -> {fps, start, boxes} | None` (Track preview).
- `track.track(frames, index, points, box, mask='') -> dict` of `(N,)` arrays in `frames` pixels: `present` (bool), `cx`, `cy`, `r` (minimum enclosing circle of the mask), `area`. `points` / `box` are in `frames` pixels; `index` is the prompt frame; a decodable `mask` replaces both as the prompt (Lift mask).
- `camera.solve(track, width, height, cuts=(), fps=FPS, zoom=False) -> np.ndarray` `(N, 3)`: `cx, cy, side` of the square window per frame, source pixels (`track` scaled to source pixels by the caller).
- `camera.still(n, width, height) -> np.ndarray` `(n, 3)`: the centred full-frame window, for an untracked square source (Square source).
- `camera.sampler(path, cuts) -> at(frames)`: path rows at fractional tracking frames (Path sampler).
- `render.render(src, meta, start, end, path, cuts, out, options, codec, progress=None) -> dict` (`size` in bytes, `duration`, `rate`, `frames`, `codec`, `fit` (the bitrate scale the fit loop ended at, 1.0 = first try), `upscale` (bool, Upscale), plus `synth`, `dupes`, `seams` when interpolating): `path` from `camera.solve` on the tracking timeline; `progress(fraction)` optional.
- `render.preview(src, meta, at, value, ev, (w, h), nets) -> {image, width, height}`: the exact look of the whole frame at `at`, proxy size, JPEG data URL (Look preview); `nets` from `repair.load` / `repair.to`.
- `repair.frames(frames, device, strength, rate)`: a generator over linear SDR `(3, S, S)` frames, same count and order (Repair); `repair.middle(window, nets, strength)`: the middle frame of 5, repaired.

**Output** (`config`): `OUT_SIZE` 640 (the ceiling, High resolution), `MAX_DURATION` 60, rate by Output rate (≤ `MAX_FPS` 60). The codec of the request (Codecs), yuv420p, BT.709 limited range tagged, AAC-LC 48 kHz, `+faststart`, at most `encode.NOTE_BYTES` (Note size); always sent with `length=OUT_SIZE`.

## Camera path

`camera.solve` turns a track into a square window per frame (`cx, cy, side`, source px) with an L1-optimal path (Grundmann et al., "Auto-Directed Video Stabilization with Robust L1 Optimal Camera Paths", CVPR 2011), solved as one sparse LP per shot by HiGHS (`scipy.optimize.linprog(method='highs')`, dual simplex).

- Units: everything is divided by `S = min(W, H) / 2`, so the widest window has half-side 1 and weights are resolution-independent. Each shot between `cuts` is solved alone: the camera may jump at a cut, never pans across it.
- Variables per sample: `x, y, h` (h = side / 2). Every L1 term `|A z - b|` is split as `A z - b = p - m`, `p, m ≥ 0` (one equality row, cheaper for dual simplex than two inequality rows).
- Objective: `|D1|, |D2|, |D3|` with weights 10 / 1 / 100 (paper), zoom ×8 (`ZOOM_WEIGHT`) so zoom stays static; data `|c - p|` (`CENTER` 0.2, low: the operator is lazy, follows a moving subject, ignores fidgeting); framing `|h - r / FILL|` (`FRAMING` 0.5, `FILL` 0.55).
- Hard: window inside the frame; `h ∈ [OUT_SIZE/2, 1]` (never upscale; the largest square if the source is smaller); pan speed ≤ `PAN_SPEED` 0.5 window/s, acceleration ≤ `PAN_ACCEL` 1.5 window/s², zoom ≤ `ZOOM_SPEED` 12 %/s. The caps are rows relative to the current `h`, not bounds, so a wide window may pan faster in pixels.
- Soft inclusion: the subject circle inside the safe circle `ρ·h` (`SAFE` 0.85), linearised with an inscribed `SIDES`-gon: `(p − c)·u_k + cos(π/K)·r ≤ cos(π/K)·ρ·h + s_a + s_b`, one slack pair per frame (the max violation over k). `s_a ≤ cos(π/K)(1 − ρ)h` costs `SAFE_EXIT` 1000, the rest (outside the real circle) `CIRCLE_EXIT` 20000. Frames whose subject is larger than `ρ` × the widest window get no inclusion rows: with them the path chased noise and traded zoom for shift (measured 32–106 segments); without them the window goes widest and centred, with an honest partial exit.
- Preprocessing: Hampel (11 present samples, 3·MAD) on `cx, cy, r`; a jump (displacement > `JUMP`·r per frame, or size ratio > `JUMP_SIZE` between neighbours) splits the present samples into runs, and a run shorter than `SPIKE` (1 s) and shorter than a neighbour run is marked absent (tracker switched to a distractor). Non-finite values count as absent.
- Gaps: absent frames carry no data or inclusion terms; the regulariser bridges short gaps. In a gap longer than `GAP_HOLD` (1 s) the velocity is pinned to 0 (bounds on the D1 slacks) except the last `GAP_LEAD` (1 s), so the camera does not drift over empty scenery but can be at the subject when it reappears.
- Timeline: solved every `STEP` = 2 frames on an exactly uniform grid (a rounded `linspace` made 1-frame steps the LP treated as 2: accel spikes of 2–5 windows/s²), weights rescaled per second (D1 ×1, D2 /q, D3 /q², per-sample terms ×q), then a `CubicSpline` (C2) to every frame and a clamp to the frame. PCHIP is only C1: jerk ~100 windows/s³ vs ~5. Measured on synthetic tracks (6 logical CPUs, 2026-10-25): N=1800 ≈ 1.3–1.7 s, N=3600 ≈ 3.9 s (STEP 1: 5–7.5 s and 14 s, same quality).
- Fallback: LP failure or `TIME_LIMIT` (30 s), or a shot under 8 samples → the subject centre interpolated over gaps, Gaussian σ = 1 s, a constant zoom from the median `r`, clamped to the frame; no detections → widest centred window. Never raises.
- Do not: switch to `highs-ipm` (timed out at 30 s on N=1800); put inclusion back for subjects bigger than the window; use a non-uniform sample grid.
- Not yet checked on real SAM tracks or real footage.

## Zoom option

Owner request 2026-10-26: zooming in on the subject is an option, `options.zoom` ("Zoom in on the object"), off by default and off for requests without the key. Off: `camera.solve` pins `h` to 1 (`lo` = 1, `# [DOC: zoom-option]`), so the window is always the whole short side of the frame and the path only pans along the long side; a square source gets a still, full-frame note. Everything else in the LP stays (smoothness, pan caps, soft inclusion against `h` = 1); the framing and zoom terms become constants, and `_clamp` / `_fallback` follow `lo`. On: the path described above, `h ∈ [OUT_SIZE/2, 1]`. The Mini App shows the switch only when the short side is over 640 px: below that the window is already the whole short side either way (Upscale). Checked with a synthetic 4K track (300 frames, subject crossing the frame): off, side 2160 on every frame and `cy` fixed at the centre; on, side 640.

## Square source

Owner request 2026-10-26: an already square video becomes a round without a selection. `api.Prompt` accepts either a full selection (`time` plus points or a box, as before) or none at all (`time` None, no points, no box, no mask; anything in between is 422 "Select the object"). `POST /render` takes an empty prompt only when `meta.width == meta.height` (else 422), `RenderRequest.check` skips the range test for it, and `/segment` still demands a selection. `pipeline.follows(meta, request)`: track only with a selection and either a non-square source or `options.zoom`; otherwise `pipeline.frame_path` returns `camera.still` (the centred full frame on every tracking frame, `media.frame_count` rows, no cuts) and skips decoding, SAM (and its model load in `render.load`), scene cuts and the solver; no `track.npz` is written. A square source with a selection and zoom off is not tracked either: without zoom its window is the whole frame anyway (Zoom option). `# [DOC: square-source]` marks `api`, `camera.still` and `pipeline.follows`. Checked locally: the validator cases (empty, point, box, time without coords, coords without time, out of range) and `follows` for square / wide × selection × zoom; not run on Modal.

## Round as source

Owner request 2026-10-26: the bot also takes a video note (an old round to rebuild) and any ordinary Telegram video, not only files. `bot.VIDEO` adds `F.video_note`; `bot.video` reads the size from `message.video_note` too. Nothing else changes: `transfer.download` fetches the message by id over MTProto and `download_media` handles every media kind. A round is square, so it takes the square-source path without a selection (Square source); it has no file name, so the new note is `round.mp4`. Not run on Modal.

## Edge fill

Owner: honest pixels first, an unnoticeable fill where the circle leaves the frame, an AI model may come later. `fill.py`, a stage of its own right after the frame source (`render.render`, `# [DOC: edge-fill]`), only when stabilizing (with a world); without stabilization the window never leaves the frame and nothing changes.

- Mask (`fill.Edges.bad`): analytic, per output frame `k` at `k / rate`: every output pixel is mapped to the world (the window from the path sampler), then into the source frame shown at that time (the nearest motion frame; both neighbours when interpolating, since RIFE mixes two anchors); missing = outside the frame (`RIM` 1 px) or, for a baked disc, outside `DISC_SAFE` × R (Baked disc).
- Order of sources per missing pixel: near donors, then the canvas, then the extension.
- L1, honest pixels: the frames within `REACH` 0.5 s (both sides, nearest first) are donors. Windows are axis-aligned in the world, so donor `j` is sampled at `(grid · side_k + c_k − c_j) / side_j` (scale + shift, bilinear), and a donor pixel counts only where the donor's own mask is fully valid there (`COVER`). With hand shake the strip uncovered now was usually visible a few frames earlier or later. Lookahead: the stage holds `REACH × rate` frames (30 at 60 fps: 640² float, about 150 MB on the GPU).
- L1b, memory: `fill.Canvas`, a world-space image (output scale = output side / median window side, at most `CANVAS` 4096 px on a side, fp16 RGB + seen) where every emitted frame writes its own valid pixels. It covers what the near donors cannot: when the window lags a pan for longer than `REACH`, the uncovered strip is what the camera saw earlier (first test without it: a smooth grey crescent on the side the camera left, measured by eye on the 384² clip at 0.75). It holds the latest real pixel per place, so a person who walked through stays as a stale ghost there.
- L2, never seen anywhere: `fill.spread`, a push-pull pyramid (premultiplied average down, bilinear up, `x + (1 − w)·up` at each level): a smooth continuation of the surrounding colours, no invented detail.
- Seam: the frame's own pixels are kept with weight `alpha` = valid × the valid share of a `2·FEATHER + 1` (8 px) box, so the last 8 px before the edge blend into the fill.
- Order: after the warp and the look (frames from `cut`), before repair and upscale, so FastDVDnet and FlashVSR see complete frames. When interpolating, RIFE still runs before the fill on the replicated edge; the fill then replaces that region in the 60 fps frames (accepted for now: the region is thin and fully replaced).
- Measured (2026-10-27, the 384² clip with a baked disc, stabilize 0.75, CPU): ground truth by marking a 24 px band of real pixels next to the missing region as missing too and filling it: near donors 25.6 dB PSNR (gamma, inside the circle), donors + canvas 25.5, extension alone 15.0, the old edge clamp 15.2. Painted: mean 5.2 % of the circle, max 27 % (about 4 % of it is the disc's anti-aliased rim beyond `DISC_SAFE`, painted on every frame).
- Rejected: masking moving pixels out of the donors and the canvas (difference to the previous frame aligned in the world, threshold 0.04 on √linear, dilated by `FEATHER`, the previous mask kept over duplicate frames). In a selfie nearly everything is close to the camera and moves with parallax, so the mask covered most of the strip and the fill became a patchwork of donors with skin-coloured blobs and steps: 25.6 → 19.6 dB, visibly worse. Ghosts of people in the strip need a flow-guided video inpainter (L3), not a mask.
- Known limits: the donors are aligned with the global similarity, so parallax (a near object) and anything moving in the strip (people) leave seams or ghosts; the subject is not excluded from donors yet; no exposure match between donors.
- L3, ProPainter (owner's pick 2026-10-28): on Modal it replaces this whole stage (Propainter fill); this module stays its per-chunk fallback and the path for local runs. Rejected: generative outpainting (MOTIA, Follow-Your-Canvas) because it invents content and Follow-Your-Canvas needs about 60 GB.
- The old subject-at-the-edge case (a subject in a corner stays outside the safe circle 100 % of the time: +0.52h measured) can now use the same rows: today they are soft only with stabilization; making them soft without it is a separate owner decision.

## Propainter fill

Owner's pick 2026-10-28, by eye from a side-by-side (source | `fill.py` | ProPainter, stabilize 1.0, soft 24 px edge cap): ProPainter (ICCV 2023, flow-guided video inpainting) paints the strip the stabilised window leaves, where `fill.py` leaves seams and ghosts with parallax and moving people. The metric disagreed with the eye (gt-band PSNR 24.0 against 25.6 dB for `fill.py`), as it did for shake. Licence: NTU S-Lab License 1.0, non-commercial, which fits this personal bot (`PROPAINTER-LICENSE`).

- Where: `render.render` takes `paint.frames` when `paint.wanted()` (true in any Modal container: `render.py` runs only in `Render`, the free tier renders with `crop.py`), else `fill.frames`; same place and signature, so the order (after warp and look, before repair and upscale) is the one of Edge fill. Local runs and scratch scripts keep `fill.py`.
- Holes: `fill.Edges.bad(k)` ∧ the output disc of radius S/2 + `fill.FEATHER`: nothing outside it is seen in the round, and the feather of the last visible pixels reaches `FEATHER` past the circle. A frame without holes passes untouched (no resample, no blend). It is the held fp16 copy, so it differs from the fp32 stream by fp16 rounding (2⁻¹¹ relative, far under a 10-bit step, reasoned).
- Working side (`paint.side`): min(8·⌊footprint / 8⌋, 640), footprint = min(median window side in source px, the stream side), the real pixels behind the circle; ProPainter wants multiples of 8. A 384 round paints at 384, 1080p and up at 640. Frames go down by area in linear light, then to gamma (BT.1886 2.4, what the model saw in training); masks go down as "any coverage" and are dilated by `DILATE` 4 px at the working side (ProPainter's default `mask_dilation`; here a square max-pool, its own is a cross).
- Chunks (`paint.plan`): `k = max(⌈n / MAX_CHUNK⌉, min(WORKERS, n // MIN_CHUNK), 1)` equal cores, `MIN_CHUNK` 150, `MAX_CHUNK` 300, each sent with `LEAD` 40 frames before and `TAIL` 24 after; their outputs are dropped. Measured locally (2026-10-28) on a 180-frame chunk against a full run in fp32: the start converges to the full run in about 40 frames and the end in about 25, then the two are about 1/255 apart. Overhead about 32 % at 200-frame cores, 21 % at 300.
- Each chunk is spawned as soon as its last sent frame has arrived (no warm calls: the first spawn starts the cold start while the rest decodes). A chunk whose core has no hole is not sent; on the 2026-10-28 handheld clips 9 of 10 chunks had holes, so this saves little.
- The Render container holds every frame as fp16 linear on the CPU (2.4 MB per 640² frame: 60 s at 60 fps is about 8.8 GB) plus packed-bit masks, and collects the whole stream before the first frame comes out (as Upscale), so the progress bar stalls while painting.
- Contract: `Painter.run(blob, masks, size, skip, core) -> bytes`: `blob` the sent frames as FFV1 `gbrp10le` gamma (`upscale.pack`), `masks` zlib of the packed bits, frame-major, `size` the working side, the core is `[skip, skip + core)`. It returns only the core frames with holes, in order; the client knows which.
- Compositing (`paint.blend`): painted frame → bicubic up to the stream side in gamma → linear, blended with `fill.alpha(hole)` (the 8 px feather of Edge fill), so pixels further than `FEATHER` from a hole are the frame's own.
- Log: `paint: N frames painted, M chunks filled instead`.
- Known risks, not measured: speed on L40S (locally 3032 s for 273 frames at 384, fp16, a throttled GTX 1660 Ti, the transformer 95 % of it); with RIFE to 60 fps it paints after RIFE, twice the frames; Render RAM about 18 of 32 GB with upscale (estimate); chunk seams (the overlap was measured on one clip; something entering the strip at a boundary may differ between chunks).
- Checked locally (2026-10-28, CPU, a scratch script): `paint.frames` with a stub worker that runs the real `painter.chunk` (packing, mask transport, the list of wanted frames) and a constant instead of the network, on 64² synthetic frames with small chunk constants: lead / tail and core indices as planned, the hole-free chunk not sent, each chunk spawned exactly when its tail frame arrived, hole-free frames bit-equal to the held copy, holed frames equal to the frame where `alpha` = 1 and to the painted value where 0, working side 56 (bicubic path) and 64, a short stream (50 of 60 frames), the fallback on a raising and on a timing-out stub (equal to `fill.frames(start=40)`, the call cancelled on timeout), and `fill.frames` with `start=0` equal to the previous `fill.py` on the same stream.

## Propainter worker

`painter.py`, its own GPU class `Painter`, mirroring `Upscaler` (Upscale chunks).

- Image `paint_image` = `cloud.image('gpu', commands=…)`: ProPainter cloned at a pinned commit into `CODE` and the three weights of its v0.1.0 release (about 192 MB) fetched with sha256 checks. Not `gpu_image.run_commands(…)`: Modal refuses build steps after `add_local_python_source` (`_assert_no_mount_layers`, read in `modal/_image.py`), and the worker needs none of RIFE, the repair weights or `deep-filter`. ProPainter's model code needs einops, torchvision (`deform_conv2d`), scipy and opencv, all in the `gpu` group; its `requirements.txt` is not installed.
- `load()` runs in the snapshot phase on the CPU, `to()` moves the nets to CUDA after each restore (as Lift). torch ≥ 2.6 loads with `weights_only` by default; the checkpoints are plain state dicts (the local run forced it and loaded).
- Precision fp32 with TF32 (`set_float32_matmul_precision('high')`, `cudnn.allow_tf32`): fp16 gave NaN on a chunk locally (Turing); bf16 untested; TF32 not compared with plain fp32.
- Settings are ProPainter's own defaults (`inference_propainter.py`): RAFT 20 iterations in clips of 12 frames (side ≤ 640), flow completion in sub-videos of 80 with 5 padding, image propagation in 100 with 10, transformer windows of 10 neighbours (stride 5), reference frames every 10 within ±40 when the chunk is longer than 80. `refs` and `sliced` match the reference loops (0 mismatches for lengths up to 364, checked).
- Only the transformer windows that touch a wanted frame run (95 % of the local time was this stage): a frame's result averages only the windows that contain it, so the skipped ones change nothing. Lead and tail still go through the flows and the propagation, they are the context.
- Output: the prediction where the dilated mask is, the input elsewhere (as ProPainter's own inference), 16-bit → FFV1 10-bit.
- GPUs `GPUS` L40S, A100-40GB, L4 (24 GB, reasoned enough for a 364-frame chunk at 640: frames, four flow fields and the propagated frames are about 9 GB in fp32; not measured); `WORKERS` 3 (`max_containers`): 4 Upscaler + 2 Render + 1 Lift + 3 Painter = 10, the account's GPU cap. `IDLE` 60 s, `TIMEOUT` 1800 s, 4 CPUs, 16 GB.
- Imports: `app.py` imports `painter` at its end so the class registers (as `upscale`). `pack`, `unpack`, `clone`, `ffmpeg`, `DEPTH`, `RAW` and `LOSSLESS` live in `blob.py`, which imports nothing from the package: `painter` used to import them from `upscale`, and Modal loads `rounds.upscale` first in a container (`upscale` → `app` → `painter` → `upscale`), so `DEPTH` was not defined yet and `Upscaler` crash-looped with `ImportError`. Keep `blob.py` free of package imports.

## Propainter fallback

`paint.painted`: a chunk whose call raises (whatever the worker raised) or gives nothing within `WAIT` 1500 s (then cancelled) is filled by `fill.frames(…, start=a)` over its core: the honest-pixel fill without donors from before the chunk; `start` keeps the masks and windows on the global frame index. `except Exception` on purpose: the note must be delivered whatever the worker did. Calls not yet collected are cancelled when the stage exits early (an error further down, the consumer stopped).

## Stabilization

Owner request 2026-10-27: a "Stabilize" slider for shaky handheld sources (`stabilize`, 0..1, top-level in `POST /render`, off by default like every option). The goal is smoothness, not a locked camera: intentional hand movement and a slow roll stay, the tremor goes. Why the old path did not help: `camera.solve` smoothed the virtual window in source coordinates, so the shake already in the source went straight into the note.

- Where: inside the existing pieces, not as a pass of its own. `motion.py` estimates the camera motion, `camera.solve` solves the same L1 path in stabilised "world" coordinates, `render.crop` warps instead of cropping (Stabilization warp). Order in the render: decode → warp → (edge fill, later) → look → RIFE → repair → upscale → encode. Before RIFE: interpolating a shaking source draws the shake and large flows give more artifacts; before repair: FastDVDnet's 5-frame window and the Zero-DCE EMA work better on aligned frames; before upscale: FlashVSR is temporal, and warping its non-deterministic output (Upscale) would resample the redrawn detail. One resample from the source, in linear light.
- Rejected: an ffmpeg `vidstab` / `deshake` pre-pass (a second resample, its own crop and smoothing that fight our path, knows nothing about the subject or the circle); stabilising the full 4K frame before tracking (cost, double resample); gyro data (Telegram-recompressed files carry none).
- Motion (`motion.flows`, `# [DOC: motion-decode]`): a grey decode scaled to a short side of at most `SIDE` 480, the same frames as the render decode (Motion decode); per consecutive pair `goodFeaturesToTrack` (`CORNERS` 600) + pyramidal LK with a forward-backward check (`BACK` 1 px), points stored in source px (edge coordinates: index + 0.5, then scaled). `motion.params`: per pair `estimateAffinePartial2D` (4-DOF similarity, RANSAC 1.5 px), points inside `EXCLUDE` 1.2 × the tracked subject circle dropped (a face in a selfie moves on its own), under `INLIERS` 24 → identity; a pair across a scene cut → identity. Accumulated source → world per frame, stored as `(tx, ty, θ, log s)` about the frame centre.
- World (`motion.world`): the slow part of roll and scale (Gaussian, σ = `SLOW` 0.5 s) is taken out of the world, so the note keeps the camera's slow roll and zoom and only the fast part is compensated; the circle is invariant under rotation about its centre, so roll costs no margin. The slow roll and scale are taken out about the **smoothed** frame-centre trajectory, never about each frame's own centre: that centre shakes, and with the scale drift of a real clip (0.88–1.4 over 9 s) the rotation about it put 2.55 px of jitter back into a perfectly still path (measured; 0.73 px after the fix). The world always compensates fully; the slider does not scale it (scaling it reduced almost nothing: the edge cost, not the world, decides how much shake stays on a source without margin).
- Slider (`stabilize` = `world['strength']`): the cost of the circle leaving the frame, `EDGE_EXIT` 300 → 0.3, log-interpolated (0.25 → about 56, 1 → 0.3). For a source without margin (a round) stabilization *is* edge fill: removing the shake means painting what the shake uncovers, so the slider trades residual shake for painted area. The crop costs `CROP_SHARE` 0.5 × the edge cost, so a large source always crops (honest pixels) before it paints.
- Edge cap and pan caps ("spd2", owner's pick by eye 2026-10-28 from side-by-side renders on two clips: `hard` (caps as without stabilization), `spd1`, `spd2`, `all` (speed and accel caps soft); only with a world): (1) each edge slack `u_j` is bounded by `EDGE_CAP` 24 output px (per S unit: 24 / 320, so 24 px at a full window, more under a crop) and a second slack on the same rows takes the rest at `EDGE_DEEP` 1000 × the edge cost, so the painted crescent goes past 24 px only where the alternative is a much worse shake; (2) the x / y pan speed caps (`PAN_SPEED`) get a slack each at `PAN_SOFT` 3 × the edge cost; (3) the pan acceleration cap is `STAB_ACCEL` 2 × `PAN_ACCEL`. The zoom speed cap and the accel caps stay hard. One variant at every slider strength, the softness is not tied to the slider (owner: like the Google Gallery stabilizer on Android, on / off only). The variant was first a wrapper around `linprog` in a scratch script; the integrated `_lp` gives the same paths to 0.0000 px (2 clips × 3 strengths, with and without a track, measured 2026-10-28). One difference: the wrapper priced the speed slack from the crop cost, which is 0 with zoom on (free speed caps); `_lp` prices it from the edge cost, so zoom + stabilize keeps the caps.
- LP (`camera.solve(..., world=)`): subject positions and radii are mapped into the world at their tracking frame (parameters interpolated in time); the four hard "window inside the frame" rows are replaced by "circle inside the warped frame quad" rows, which stay linear in `(x, y, h)`: `n_e · (x, y) − c_e ≥ h − u_j` per edge of every source frame that falls on sample `j` (all of them, not only the sampled one: tremor is 4–12 Hz, the LP samples at 15 Hz). One slack `u_j` per sample costs the slider's edge cost (per S unit, ×q): the share of the circle that leaves the frame is what edge fill must paint. With stabilization the gap hold is off (a pinned velocity in the world would let a pan leave the frame) and `x, y` are free.
- Crop (owner 2026-10-27): only for sources whose short side is over 640, and only as far as the window stays ≥ 640 source px (no quality loss), capped at `STAB_CROP` 20 % of the short side (plus the per-frame scale compensation); each unit of `1 − h` costs `CROP_SHARE` × the edge cost. A source of 640 or less is never cropped: its margin comes from edge fill. With zoom on, the zoom bounds and framing apply as before (no crop cost).
- No selection (square source, `locate.follows` false): with stabilization the path is still solved, from an empty track, so the window is a pure stabiliser; without it `camera.still` as before.
- Checked (2026-10-27, locally, CPU): stabilization off gives the old path to 0.0000 px (4K and 9:16, zoom on and off, synthetic tracks with gaps and a cut); a synthetic square 384 source with 7 Hz / 5 Hz shake, 3 Hz roll and a slow pan + 4° roll: motion recovered exactly, window acceleration 7.8 → 0.57 px/frame², the fast roll removed and the slow 4° kept, the circle outside the frame on average 5.5 px (max 16 px of r = 192), solve 0.2 s. Not checked on Modal or on real tracked footage.
- Measured on the owner's test clip (2026-10-27, 384² round, 29.97 fps, 9 s, handheld with motion blur and duplicate frames): inter-frame shake median 3.4 px, p95 11.5 px, roll p95 0.72°, scale p95 1.6 % per frame; flows 36 ms/frame on a busy 6-core CPU, 19–600 points per pair (median 292); solve 0.2–0.8 s. Jitter = rms of the window centre in the scene above about 0.6 Hz (raw 10.3 px), painted = share of the circle's area outside the frame:

| `stabilize` | 384² round: jitter, painted mean / max | 1080p (same shake scaled): jitter, crop, painted mean / max |
|---|---|---|
| 0.25 | 7.8 px, 0.24 % / 2.7 % | 5.2, up to 7 %, 0.02 % / 0.6 % |
| 0.5 | 6.9 px, 0.29 % / 2.5 % | 4.4, up to 8 %, 0.06 % / 1.0 % |
| 0.75 | 5.0 px, 0.6 % / 5.5 % | 3.5, up to 9 %, 0.13 % / 1.8 % |
| 1 | 2.4 px, 5.2 % / 21 % | 1.0, 9–21 %, 0.9 % / 10 % |

  Measured before the edge cap and pan caps (above) existed; not re-measured with them. The jitter includes fast intentional movement, so 0 is not the goal. Painted crescents are thin up to 0.75; at 1 a round needs real fill (Edge fill).
- Rolling shutter, measured on the 384² clip (2026-10-27): per pair a full affine vs the similarity: median residual 0.66 → 0.54 px; the y/x scale anisotropy (p95 2.4 %) correlates with the vertical shift only +0.13 and the shear with the horizontal shift +0.07, so no usable rolling-shutter signature at this size (re-encoded, blurred). Plan, reasoned: on a high-resolution phone clip check the same correlations; if they are strong, fit homography mixtures (Grundmann, Kwatra, Castro, Essa, ICCP 2012: K row bands with blended homographies, what YouTube's stabilizer used) in `motion.params` and pass a per-band transform to the warp (the bicubic `grid_sample` grid already allows any per-pixel map); MeshFlow (Liu et al., ECCV 2016) only if mixtures leave visible jello; learned RS correction (DeepUnrollNet, RSSR) needs RS-specific training data, not justified until mixtures fail.
- Deblur (owner 2026-10-28): a 5-step control, built in `deblur.py` / `lucky.py`, see Deblur.
- Edge fill with ProPainter (owner 2026-10-28): built, not yet run on Modal (Propainter fill). Rolling shutter: parked in `BUGS.md`.

## Baked disc

Some square sources already carry the round: the owner's test clip (an old round exported as a file) has the area outside the inscribed circle baked in as flat white, in every frame. Real pixels are only inside the disc. `motion.flat` checks the first frame of the motion decode (square, the pixels beyond `DISC_OUT` 1.04 R nearly constant, std < `DISC_FLAT` 4); then features are detected only inside `DISC_IN` 0.94 R, and `flow['disc']` is confirmed if the last frame's corners still match the first. Why the feature mask: the static mask edge has strong corners that do not move, and they pulled the estimate toward zero (inter-frame shake median 3.42 → 3.53 px, p95 11.5 → 12.5 px once masked, measured on that clip). For a disc the LP frame rows are "output circle inside the warped source disc" instead of "inside the quad": `u_i · (c − d_k) ≤ (ρ_k − h)·cos(π/K)` over `DISC_SIDES` 16 directions (the inscribed 16-gon, conservative), `d_k` the warped disc centre, `ρ_k` = `DISC_SAFE` 0.98 R × the frame's scale (off the anti-aliased rim); the same row shape as the quad edges, so `camera` takes any edge count. A disc has no corners to spare: any shift uncovers a crescent, so it needs more fill than a full square at the same strength (measured, 384² clip: outside the disc mean 4.6 px at 0.5, 8.1 px at 0.75, 38 px at 1, max 173 px of 192). The renderer must treat everything outside the disc as missing (Edge fill); until fill lands, the white mask shows there.

## Motion decode

The transforms must belong to exactly the frames the render decodes, or the note jitters by one frame of shake. `locate.flowing` decodes with the render's own chain: `media.decode` with the output rate for CFR, `smooth.decode` (passthrough with `showinfo` stamps, `vf` before `showinfo`) when interpolating. Frame times are `k / rate` for CFR and the source stamps otherwise; `motion.placer` looks up the nearest time, which is exact in both cases. Fast seek first, slow only when the fast one gave no frame, like `media.retrying`. Do not: replicate the `fps` filter's frame choice from source stamps (its rounding of ties is ffmpeg's, not ours). Runs on a CPU thread from the start of `frame_path`, in parallel with SAM on the GPU; not cached yet (a Render.prepare precompute is possible, keyed by job, range and rate).

## Stabilization warp

`motion.placer` turns the world path into source rows `(cx, cy, side, angle)` per frame (the window centre mapped back, side divided by the frame's scale, angle −θ), so `smooth.frames` (`win[:3]`, `moved`) and `cfr` keep working unchanged. `render.crop` takes the old separable Lanczos path when the angle is 0 (stabilization off: bit-identical), else `render.turned`: Lanczos of the window's bounding box (side × (|cos| + |sin|) + `GUARD`) to `OVER` 2 × the output (the look applied there, on an axis-aligned box), bicubic `grid_sample` of the rotated grid at 2 ×, Lanczos 2:1 down. Keeps antialiasing of the big downscale and costs about one extra 1280² pass on the GPU. Outside the frame the edge is replicated (the `weights` clamp) until edge fill paints it.

## Proxy tonemap

`media.sdr_chain` (proxy and tracking frames). SDR: `scale` (bicubic, `out_range=tv`) → `format=yuv420p` → `setparams` BT.709. HDR: downscale first (cheap), then `zscale=tin=<arib-std-b67|smpte2084>:pin=2020:min=2020_ncl:t=linear:npl=100,format=gbrpf32le,zscale=p=709,tonemap=tonemap=mobius:desat=0,zscale=t=709:m=709:r=tv,format=yuv420p`. `tonemap` only works on linear float input (ffmpeg-filters, tonemap), hence `t=linear` + `gbrpf32le`. Input tags are given explicitly so untagged files do not fail with "no path between colorspaces". The mobius `param` (0.3) and `peak` (10, i.e. 1000 nits at `npl=100`) are given explicitly (`media.MOBIUS`, `PROXY_PEAK`) because the Mini App's WebGL preview inverts this curve for HDR jobs (Look preview; change together with `MOBIUS`/`PROXY_PEAK` in the Mini App's look mirror). For HLG they are ffmpeg's own defaults: the IMG_9065 proxy frame came out byte-identical with and without them (md5, 2026-10-26); for PQ the default peak was not checked, so old PQ proxies may differ slightly. `mobius` + `npl=100` came closest to the SDR original on a synthetic clip (luma of bars 61/164/204 vs SDR 62/172/217; `hable` 53/137/169, `npl=203` darker). Known limit: zimg applies the HLG OOTF per channel, not on luminance as BT.2100 does, so HLG proxy saturation differs slightly from the note; the proxy is only for picking.
Do not tag with the `-colorspace/-color_trc/-color_primaries` output options: in ffmpeg 9.0.2 they were ignored for frames without tags (the proxy came out `unknown`). Tags are set on frames with `setparams` (`media.BT709`), here and in the note encoder.

## Cfr decode

`media.decode` reads source frames on a CFR grid: tracking at `FPS`, the note at its output rate, both from the same `-ss start` (accurate seek, before `-i`), so the grids share time zero. `fps=<rate>:start_time=0` as the first filter (frame k = start + k/rate, duplicates and drops by nearest), `-frames:v N`. The only other reader is `smooth.decode` (Timed decode), which keeps the source frames as they are. Autorotate stays on (default), so frames are display-oriented. Callers read with `read_full` (a `readinto` loop; pipes return short reads) into preallocated buffers. If ffmpeg returns fewer than N frames (range past the end, ±1 rounding), the last frame is repeated. `track_frames` writes an `np.memmap` in `tempfile.mkdtemp()`; the caller deletes it (`pipeline.render_job`).

## Broken sources

`media.LENIENT` (`-max_error_rate 1 -fflags +genpts+discardcorrupt`) goes before every `-i` of the source, video and audio reads alike (`open_at`, `make_proxy`, `audio.chain` and its measuring passes): `genpts` makes up missing timestamps, `discardcorrupt` drops packets the demuxer flags as corrupt instead of decoding garbage (the gap is then held, or interpolated). The video stream is the one `probe` picked (`meta.stream`: the first video stream that is not cover art), mapped as `0:<index>` by `media.video` (`0:v:0` for jobs ingested before the field); a bare `0:v:0` can be a cover picture. `probe` takes the duration from the format, then the stream, then the packets, and raises a readable error if none has it.

Seek fallback: every frame reader is built by `media.open_at(src, start, slow)`. Fast: `-ss` before `-i`. If that yields no frame at all, the reader is rebuilt slow: no `-ss`, the whole file is decoded from the start and `trim=start=…,setpts=PTS-start/TB` drops what is before `start` (same time zero). `media.retrying` does it for the note frames (`render.cfr`, `smooth.frames`), `track_frames` for the tracking frames. Found on an MPEG-TS with one keyframe for the whole file (x264 default GOP 250): TS has no index, the seek landed mid-GOP and the decoder dropped every frame until a keyframe that never came. Phone MP4s have an index and a keyframe about every second, so the slow path should stay rare; it costs a decode of everything before `start`. A partial result (some frames, then nothing) is not retried: the last frame is repeated, as before.

Exit 69: ffmpeg returns 69 when one decoder's error rate, failed decodes / (decoded frames + failed decodes), exceeds `-max_error_rate` (default 2/3). Source (n9.0.2): `fftools/ffmpeg_dec.c`, `decoder_thread` ("Decode error rate %g exceeds maximum %g" → `FFMPEG_ERROR_RATE_EXCEEDED`), mapped to 69 in `fftools/ffmpeg.c` `main`; the default in `fftools/ffmpeg_opt.c`. The rate is per decoder, not over all inputs, and it is checked when that decoder ends, before the trailers are written: the outputs of a 69 run are complete. Every decoder counts, so a broken audio track alone fails a run whose video is fine; that was the owner's file (2026-10-26: `[0:1]` video, the audio first, as in `audio80.mp4` below). The check is `rate > max`, so `1` turns it off. It is a global option; each command carries `LENIENT` once. The frame readers (`decode`, `smooth.decode`) never checked the exit code; the proxy (`run`, `check=True`), the note encoder (`enc.wait()`) and the loudnorm pass did.

What is left when a stream does not decode at all:

- No video frame: the proxy command fails ("Could not open encoder before EOF", exit 183 on `video100.mp4`). `make_proxy` raises `source.Unreadable` (`media.NO_FRAMES`) when the thumbs file is empty and re-raises anything else; `track_frames` and `render` raise `Unreadable` (`media.NO_RANGE`) when the range gives no frame.
- No audio frame: ffmpeg writes the proxy without an audio track and exits 0 (`audio100.mp4`). `make_proxy` reads the proxy's tracks (`AUDIO_TRACK`) and returns `has_audio: False`, which replaces the probed value in `meta`, so render maps no audio. Audio broken only inside the chosen range: the note gets silence there (Audio chain).
- Loudnorm over a range with nothing measurable (digital silence, or no decodable audio) prints `input_i: -inf`, `target_offset: inf`; the second pass refused `measured_I=-inf` ("out of range [-99 - 0]", exit -34) on `audio80.mp4` and `audiorange.mp4`, and a clean silent clip measures the same values. `audio_filter` skips loudnorm when a measured value is not finite.

Errors the user sees: `source.Unreadable` (a `ValueError`) carries a short English reason: the file cannot be opened (`probe`: ffprobe fails, for example an MP4/MOV cut before its `moov`), no video track, no length, no decodable frame. `pipeline.fail` stores and sends only that text (`bot.TEXTS['failed']`); any other exception becomes `pipeline.UNEXPECTED`, never a command line. The Modal log gets the traceback plus the last `STDERR_TAIL` characters of ffmpeg's stderr for a `CalledProcessError` (the error itself or the cause of an `Unreadable`): `run` captures stderr and the traceback does not print it. The API shape is unchanged (`error: str | None`); the Mini App does not show `error`, the bot message does.

Rejected, measured with `LENIENT` on the files below (frames decoded with `-fps_mode passthrough`, PSNR against the clean file, both at 30 fps):

- `-err_detect ignore_err`: nothing reads `AV_EF_IGNORE_ERR` in the h264, hevc or aac decoders or in `decode.c` (n9.0.2); frames and PSNR identical on `video30`, `video90`, `hevc_video40`, `trunc_fast`.
- `-ec`: H.264 concealment is on by default (`guess_mvs+deblock`, `libavcodec/options_table.h`); `-ec 7` (+`favor_inter`) gave 16.0 dB on `video30` like the default,`-ec 0` 12.0 dB. HEVC has no error resilience in ffmpeg (`hevcdec.c` skips undecodable NAL units), so no flag changes it.
- A stream-copy remux as a repair step: the same demuxer reads the same packets, so it fixes nothing the direct read does not (same frame counts; `video30` 16.02 vs 15.99 dB), and a file without `moov` fails the remux like the probe ("moov atom not found"). Timestamps and seeking are already covered by `genpts` and the seek fallback.
- `-err_detect explode` hung ffmpeg 9.0.2 on `video30` (killed after 10 min).

Checked locally (2026-10-26, ffmpeg 9.0.2, torch CPU): `testsrc2` 720×1280 30 fps with an AAC beep every second, laid out like phone files (H.264 MP4 with the audio as stream 0; HEVC 10-bit MOV with the video first); packets overwritten with random bytes, or every 97th byte flipped. Probe, `make_proxy`, `track_frames`, `render` (CFR and RIFE, with and without loudnorm), range 1–3 s or 1–5 s:

- `audio80.mp4`, `hevc_audio80.mov` (80 % of the audio packets random, error rate 0.82): exit 69 in the proxy before (the owner's error); now everything passes, the audio kept where it decodes.
- `audio100.mp4` (all audio): exit 69 before; now no audio track in the proxy and the note.
- `audiorange.mp4` (all audio from 0.5 to 3.5 s): the note is silent until the audio returns, the beeps on time.
- `video90.mp4` (90 % of the video packets random, error rate 0.96): exit 69 before; now 10 frames decode and are held, the note renders.
- `video100.mp4`: "Not a single frame of the video could be decoded" at ingest.
- `trunc_nomoov.mov` (`moov` at the end, file cut at 60 %): "The file is damaged or incomplete and cannot be opened" at probe.
- `video30.mp4`, `hevc_video40.mov`, `audio30.mp4`, `trunc_fast.mp4` (faststart MP4 cut at 60 %): passed before and still do.

Repair: a recording cut before its `moov` (the phone stopped writing) keeps every frame but has no index. Only `untrunc` (GPL-2.0, github.com/anthwlock/untrunc) rebuilds it, and it needs an intact file from the same camera with the same settings, which the bot does not have; it also builds against the ffmpeg libraries (3.3.9 recommended, struct mismatches past 8.1), a separate build in the image. Not worth it today: such a file fails with a readable message and the owner can resend the original. For files that open, `LENIENT`, the default concealment and the held or interpolated gaps are already all ffmpeg offers for free.

Checked locally (2026-10-25, ffmpeg 9.0.2, torch 2.14 CPU) on MPEG-TS files with every 7919th byte flipped from 60 KB to 60 % of the file and the last 20 % cut off: probe, proxy, tracking frames and both render paths went through. With the single-GOP file the fast seek gave 0 frames and the slow path 39 of 39; with a 1 s GOP the first decodable frame after `-ss 0.5` was at 1.5 s (corruption ate the keyframe), held before it, interpolated after.

## Source cadence

`source.cadence` reads the pts of every video packet with ffprobe (demux only, no decode), sorted and deduplicated (B-frame reorder). Nominal rate = 1 / median interval: the capture rate, also for VFR phone files whose `avg_frame_rate` is lower because frames were dropped; `avg_frame_rate` / `r_frame_rate` only when the packets give nothing in 1..480 fps. Snapped to a standard rate within 1.5 % (`RATES`, `SNAP`), so 59.94 stays 59.94 and 59.98 becomes 60. `gaps` = missing frames / frames: an interval longer than 1.25 × the median (`JITTER`; iPhone timescale jitter stays below) counts `interval / median − 1` missing frames. The first version counted the share of uneven intervals instead; a 16-frame freeze is one interval, and a 60 fps file with 27 of 240 frames dropped scored 0.94 % (under the threshold). The missing-frame share gives 12.7 % for it. Test files (testsrc2 640×360, 2026-10-25): 30 / 24 fps → offered; clean 60 → not offered; 60 with 16 frames frozen → `dupes` 0.067, offered; 60 with 27 frames dropped → `gaps` 0.127, offered.

## Duplicate frames

Two detectors for one thing: a repeated (frozen) frame, as written by apps that turn VFR into CFR, or by a phone that lagged.

- Ingest (`source.dupes`, decides the offer): the proxy's ffmpeg also scales every native frame (before `fps`) to 32×32 `yuv444p` (`flags=area`) into a temp raw file (3 KB per frame); `dupes` reads the Y plane, which is the old grey thumb (same `dupes` on 17, 45, round2, IMG_4042; Segment cuts reads all three planes). A frame is a duplicate when no thumb pixel moved by more than 1 level (`DUP_LEVEL`) while the mean motion within ±0.5 s reaches 1 level (`MOTION`), so a still tripod shot is not a freeze. `dupes` = share of such frames. Measured: 60 fps testsrc2 with 16 frames frozen → 0.067; the clean test files 0.
- Render (`smooth.still`, decides what to drop): luma averaged over 4×4 pixels (`DUP_STEP`), compared only inside the circle the viewer sees: the camera window of the current frame (`at(t · FPS)`), its inscribed disc, 16×16 cells (`DUP_GRID`) over the window, cells at least a quarter inside the disc. A frame is dropped when the largest cell mean |diff| to the last kept frame is ≤ 2 levels (`DUP_LEVEL`, ×4 for 10-bit). Cells, not one global mean: a small moving part of a still frame (a hand, leaves) keeps the frame. Dropped frames are re-created by RIFE from their real neighbours. A run longer than `MAX_GAP` (1 s) is kept as a real still. Known limit: a perfectly static stretch (denoised and compressed to skip blocks) shorter than 1 s is dropped too; RIFE between two near-identical frames returns the same picture, so it only costs the grain. A false drop is cheap (RIFE redraws it), a missed duplicate is a visible stutter: tune toward dropping.
- Why the disc and the averaging (owner's IMG_4042, 2026-10-26: an Android round re-sent through Telegram, 384², VFR about 25 fps, 1 Mbps; the 60 fps note stuttered around a camera switch): the first version (every 4th pixel, 8×8 blocks over the whole frame, ≤ 0.5 level) dropped 0 of 469 frames although about 60 are frozen copies. Two reasons, measured on its frames: the Telegram send icon in the corner, outside the circle, changes every frame by up to 31 levels in a 12 px cell; and the copies carry codec noise, so per-pixel |diff| never falls near 0.5. Inside the disc, 4×4 averaged, 16×16 cells: the frozen copies score ≤ 1.46, the first real motion 3.47; the current settings drop 61 frames there, a moving testsrc2 0 of 59. The ingest detector (`source.dupes`, 32² thumbs of the whole frame) has the same blind spot for corner overlays; it only decides the offer, and a source under 60 fps is offered anyway.
- A stretch with no frames at all (IMG_4042: 494 ms after the camera switch) is not interpolated: it gets a seam (Seams).

## Segment cuts

Owner request 2026-10-27: a note is split into pieces at camera switches, each piece gets its own settings (mirror, denoise, zoom, object) in a segmented control. `source.switches` finds them at ingest (called by `media.make_proxy`, logged in `ingest.proxy`); `meta.switches` is the sorted list of cut times in seconds of the proxy timeline (the start of the new piece; 0 and the end are implied). Nothing reads it yet. Named `switches`, not `cuts`: `cuts` already means the tracking scene cuts in frame indices (`media.scene_cuts`, `camera.solve`, `smooth.frames`).

- Signature (measured on the owner's corpus: 100 iOS rounds `video (n).mp4`, round1/2, IMG_4042): Telegram on iOS (`Core Media Video`, time base 1/600) and Android restarts the camera on a front↔back switch, leaving 0.2–0.5 s with no frame, then black frames or an exposure ramp. Video 17: front camera on the ceiling until 1.033, nothing until 1.358, 4 black frames, the back camera fades in on the floor.
- Timestamps: the thumbs output of `make_proxy` writes one pts per frame with `-stats_enc_pre` and `-stats_enc_pre_fmt {t}` (`media.STAMPS`, checked with the image's ffmpeg 9.0.2), with `-fps_mode passthrough`: 191 stamps for 191 frames on video 17. No second ffprobe pass.
- Rule: a hole is a gap of at least `HOLE` 0.12 s and `HOLE_STEPS` 4 median frame steps. It is a cut when the frame `BEFORE` 0.1 s before the hole and the frame `AFTER` 0.3 s after it (past the black frames and the ramp) differ: `change` = structure (1 − correlation of the luma normalised inside the inscribed disc) + 2 × colour (L1 of a Y16 U8 V8 histogram, / 6) ≥ `CHANGE` 1.0. Labelled switches score 1.03–2.5, recording hiccups with the same scene (IMG_4042 @11.5, videos 34, 45, 66, 67, 75, 80) up to 0.88.
- Placement: Android shows one frame of the new camera before the hole (IMG_4042: 1.043, Seams), so the cut moves to the frame before the hole when that frame is closer to the after-frame than to the before-frame.
- Pieces shorter than `MIN_SEGMENT` 0.5 s (from either end or the previous cut) are merged into their neighbour by dropping the later cut.
- Not `seam.HOLE` (0.25 s): that one decides seams and misses round2's 0.217 and 0.250 s holes; the two thresholds serve different questions and are separate on purpose.
- Corpus result (2026-10-27): cuts in videos 2, 3, 4, 15, 16, 17, 24, 85, 99 (two), round1, round2 (three), IMG_4042; no hiccup hole cut. Dark scenes (24, 99, round1) cut on holes whose scene does change in the dark; they look like real switches but are not confirmed.
- Known limit: a seamless switch (no hole) is missed. Newer iPhones switch without restarting the camera, with a hard cut or a ~6-frame dissolve (video 90 @4.2, 60 @2.3, 87 @1.7, 95 @2.05, 16.6, 42.6, 59 @1.4).
- Rejected for the seamless case (2026-10-27, measured): low-level cut metrics (histogram jump, disc structure, residual of a linear mix of the end frames for dissolves, side stability) overlap fully between those switches and pans, RGB lights and exposure jumps. A face flip (YuNet 2023mar through `cv2.FaceDetectorYN`, a large face of at least 0.3 of the short side on one side of a structural jump and none on the other) found 7 of them among about 95 accepted jumps on the corpus. Its false ones: the back camera panning to or from a friend's face (59, 60, 89), the author's own face leaving the frame by motion (18, 89, round2 @37.75), faces seen in a shoe pattern (93), darkness (14, 26, 51). Face size, position and luma checks did not separate them. Not shipped as cuts. Owner decision (2026-10-27): face flips come back as hints in the manual cut editing (later; YuNet is approved as a dependency then), never as automatic cuts. A learned front/back classifier is the idea left.

## Output rate

`source.out_rate`: `MAX_FPS` (60) when `options.interpolate` and `meta.interpolable`, else the source rate capped at 60 (a 24 fps source gives a 24 fps note, 120 fps is decimated to 60). `meta.interpolable` (set at ingest): a rate under 60 (59.94 included: owner decision, anything under 60), `gaps` ≥ 0.5 %, or `dupes` ≥ 0.5 % (`SHARE`). Otherwise the Mini App shows the "Smooth to 60 fps" switch disabled ("Already a steady 60 fps"; the options seam disables, never hides). Interpolation always targets 60, never ×2 (owner decision). Tracking and the camera stay at `FPS` 30, so SAM costs the same; the path is resampled (Path sampler). The proxy stays 30 fps. x264 settings are unchanged: `-g 60` is 1 s at 60 fps, the size cap (Note size) is shared by twice the frames. Not yet checked: how the Telegram clients (iOS, Desktop) play a 60 fps note.

## Path sampler

`camera.sampler(path, cuts)` returns `at(frames)`: rows at fractional tracking frames (`t · FPS`, t from `start`), a `CubicSpline` per shot over its own frames, clamped to the shot's ends. A time belongs to the shot of `round(t · FPS)`, so the boundary sits half a tracking frame before the cut frame: the camera still jumps at the cut and never pans across it. Used for every output frame (CFR) and for every source frame (interpolation). Spline overshoot past the frame edge is sub-pixel and handled by the renderer's edge clamp.

## Upscale

Owner request 2026-10-26: an AI upscale for sources smaller than the note (old 384 or 400 px rounds, 480p clips), so the note is not just a bigger blurry picture. `options.upscale`, off by default; the Mini App offers it only when `min(meta.width, meta.height) < 640`, and `upscale.wanted` checks the same, so a stale or forged flag on a large source does nothing. That is the only case where the window is under 640 source px: the camera never zooms past 1:1 (Camera path, `h ≥ OUT_SIZE / 2`), so for a small source the window is the whole short side and constant.

- Model: FlashVSR v1.1 (OpenImagingLab, Apache-2.0; one-step diffusion on Wan2.1 1.3B, locality-constrained block-sparse attention), the **tiny-long** pipeline: `FlashVSRTinyLongPipeline` with the tiny conditional decoder (`TCDecoder`) instead of the Wan VAE, low-res frames kept on the CPU and every decoded step moved back to the CPU, so GPU memory stays flat in clip length. Code: `upscale.FLASHVSR`, a pinned commit cloned into `config.FLASHVSR_CODE` in its own image (Upscale image). Weights: three files of HF `JunhaoZhuang/FlashVSR-v1.1` at a pinned revision (`upscale.WEIGHTS`: the streaming DMD DiT, `LQ_proj_in.ckpt`, `TCDecoder.ckpt`), in the HF cache on the `rounds-models` Volume, downloaded by the first worker that needs them.
- Settings: the repo's own inference script values (`SETTINGS`: one step, `kv_ratio` 3, `local_range` 11 ("more stable" per the script, 9 is sharper), `topk_ratio` = 2.0 × 768 × 1280 / target², `color_fix` (AdaIN against the input)); the prompt tensor shipped in the repo (`PROMPT`) passed to `init_cross_kv` as a tensor, because the pipeline's default is a path relative to `examples/WanVSR` and the worker never changes its working directory.
- Scale: the model works at the target size: low-res frames are bicubic-upscaled to the target first (as the repo script does, here with `torch` on the GPU), the network sees them through its ×4 projector. Target = 4 × `upscale.side`, cut to a multiple of 128 and capped at `TARGET` 1536; the result goes to 640 with ffmpeg Lanczos (the same step the owner judged). Owner's choice (2026-10-27, side-by-side of the canonical bad Android clip `IMG_4042`, 384²): tiny at 1536 looked the same as the full pipeline (Wan VAE decoder) at 1536, and clearly better than SeedVR2 ("SeedVR2 fades next to it, as if just stretched"); targets 768 and 640 (×2, ×1.67) were visibly worse ("a defect we cannot let through"): do not lower `TARGET` to save time.
- Flow (`render.render`): the crop renders at `upscale.side` (the short side rounded up to 64, at most 640); `upscale.frames` wraps the frame stream: linear → gamma (BT.1886 2.4, plain video pixels, what the model was trained on), the whole stream is collected (10-bit in transit), split into chunks for parallel `Upscaler` workers (Upscale chunks), and the results come back in order, gamma → linear, then the usual `color.encode` and the encoder. With interpolation, RIFE still runs at the small size first and FlashVSR then upscales all 60 fps frames (twice the work of 30); upscale-before-RIFE is the next step (owner approved 2026-10-27).
- Measured on Modal L40S (2026-10-27, scratch app, 634 frames 384², 30 fps): model load 12–13 s per container (weights cached); one worker 144 s for all 634 frames (4.4 fps, including the transfer codecs); peak GPU memory 21.8 GB (fits A100-40GB; L4's 24 GB is too tight to rely on); the full pipeline at 1536 needed 60 GB and an A100-80GB (2.9 fps). Inference alone at 1536: 119 s on L40S (5.3 fps), so about $0.065 of GPU per 634 frames against about $0.10 for SeedVR2 on L4.
- Not deterministic: two runs over the same frames differ (PSNR 33–41 dB between them, drifting with distance from the start), so a chunked result is not bit-equal to a single run and never will be.
- Rejected: SeedVR2 3B (2026-10-26 to 27: 1.4 fps on L4, about 21 min of L4 for 60 s at 30 fps; the owner then preferred FlashVSR by eye); the full FlashVSR pipeline (same look, 60 GB, A100-80GB only); targets under 1536 (above). Other candidates noted on 2026-10-26, not run: SeedVR2 7B, Upscale-A-Video, RealBasicVSR (the "neural" look the owner rejected), Real-ESRGAN (per frame, flicker), mpv shaders through libplacebo (nothing invented, barely sharper than Lanczos).
- Known artifacts: a generative upscale invents detail that is not pixel-equal (fine strands, redrawn texture); judge it by eye, not by VMAF against a true 640.

## Upscale chunks

`upscale.plan(n)` cuts the clip into `k = max(⌈n / MAX_CHUNK⌉, min(WORKERS, n // MIN_CHUNK), 1)` equal parts; each part carries `LEAD` 16 earlier frames as context and the worker drops their output (`skip`).

- Why `MIN_CHUNK` 200: every worker pays a cold start plus about 13 s of model load and the transfer, so parts much shorter than 200 frames cost more than they save (the peer's advice from the Render warm measurements). Why `MAX_CHUNK` 600: a worker holds the bicubic input and the output of a chunk at 1536² in bf16 on the CPU (about 14 MB per frame each), so 600 frames are about 17 GB of the worker's 32 GB; longer clips get more parts than workers and the extra parts queue.
- `LEAD` 16 (two 8-frame steps of the causal model): measured on the 634-frame clip in 3 parts (2026-10-27), the frame-to-frame difference across a boundary is the same as elsewhere (no jump), and the parts differ from a single run as much as two single runs differ (Upscale, not deterministic). Wall time: 117 s for 3 parts against 228 s for one worker, cold starts included.
- `upscale.warm(job)`, called by `pipeline.render_job` in `render.load` before the tracker loads: spawns `Upscaler.warm` once per container the job will use, so the workers boot (cold start plus model load in `@modal.enter`) while the render tracks. `frames()` waits for these warm calls (`WARMING`, up to `WARM_WAIT`, errors ignored) before it spawns the parts: spawned while the warm workers were still loading, the parts counted as extra queued inputs and Modal started two more L40S containers that loaded the model and idled 60 s (job x2_qzmbF1-, 2026-10-27, 566 frames, about $0.09 wasted; the fix is not yet measured in production). `IDLE` 60 s scaledown afterwards, so a worker that warmed too early may be gone again; a longer window is a cost decision for the owner.
- Transport: each part travels as FFV1 `gbrp10le` (lossless 10-bit RGB, about 0.46 MB per 640² frame, 3× smaller than 16-bit) in the call's arguments and its return value: Modal moves payloads over 2 MiB through its blob store on its own (`MAX_OBJECT_SIZE_BYTES`, read in the Modal 1.6 source), so no Volume commit and reload between containers. A 60 s 60 fps clip is about 1.7 GB back; if a payload cap ever bites, the data Volume is the fallback.
- GPU budget: `WORKERS` 4 (`max_containers`) + `Render` 2 + `Lift` 1 + `Painter` 3 (Propainter worker) = all 10 GPUs of the Starter workspace. GPUs: L40S first (best price per frame, sm_89 runs the sm_80 kernels), then A100-40GB and A100-80GB; L4 is left out (24 GB is too tight, and L4 capacity waits were seen, Render gpus), H100 too (it would need sm_90 kernels: Upscale image).
- The render container's GPU idles while the workers run (it has no FlashVSR); doing the first part there would need FlashVSR in `gpu_image`, which the separate image avoids on purpose.

## Upscale padding

FlashVSR outputs `largest 8m + 1 ≤ N + 4`, minus 4 frames for `N` input frames (the repo script pads 4 copies of the last frame and cuts to `8m + 1`): 634 frames came back as 629, the last 5 lost (measured). `upscale.chunk` pads with copies of the last frame up to the smallest `8m + 1 ≥ N + 4` instead and keeps the first `N` outputs, the owner's idea (2026-10-27): every frame comes back, measured 634 of 634. The output is aligned to the input from the first frame (PSNR against the Lanczos reference peaks at offset 0).

## Upscale image

`upscale.vsr_image`, its own image, so the CUDA toolkit and the compiled kernels never slow the cold starts of `Render` and `Lift` (`gpu_image`).

- Layers, heaviest first so a change of the project lock never rebuilds them: `nvidia/cuda:12.4.1-devel-ubuntu22.04` with Python 3.12; torch 2.6.0 + torchvision 0.21.0 from the cu124 index (FlashVSR's versions; the kernels are built against them); FlashVSR's `requirements.txt` without its pins of torch, numpy, protobuf and `opencv-python` (they clash with the project and Modal) plus `modelscope` (imported by `diffsynth` but missing from the file); FlashVSR itself `-e --no-deps` (its `setup.py` re-reads the same requirements); Block-Sparse-Attention at a pinned commit (`upscale.BSA`) compiled with `BLOCK_SPARSE_ATTN_CUDA_ARCHS=80` (about 10 min; sm_80 code runs on sm_86 and sm_89, measured on L40S); then `cloud.image(base=…)` adds ffmpeg, the project venv and the package as in every image.
- Build traps met on the way (2026-10-27): `pkg_resources` gone in setuptools 81 (`setuptools<81` and `--no-build-isolation`); `bdist_wheel` missing (`wheel`); the cu124 `torchaudio` pin unresolvable through `setup.py` (`--no-deps`); BSA calls `clang++` unless `CC=gcc CXX=g++`; `import block_sparse_attn` alone fails with `libc10.so` not found (import torch first).
- The venv: `uv_sync` creates `/.uv/.venv` and puts it first on `PATH`, so packages installed with the system `pip` would be invisible. The image creates that venv first with `python -m venv --system-site-packages`; `uv sync` reuses it and installs the project's deps into it (numpy 2.5 from the lock shadows the system one), while torch, FlashVSR and the kernels stay visible from the system site-packages (checked: `import torch, block_sparse_attn, diffsynth, fastapi, aiogram, telethon` with the venv's python).
- Imports: `app.py` imports `upscale` at its end so the `Upscaler` class registers on the app; `upscale` imports `app` back (safe: it needs only `app`, `image`, `models`, `MODELS_DIR`, defined in `cloud.py` and re-exported by `app.py` before the snapshot block that may import `render` → `upscale` first). `upscale` imports torch only inside functions: the deploy runs `app.py` locally, where torch is not installed. In the worker container `app.py` runs too; its `gpu_image.imports()` block fails there on the SAM 2.1 module (transformers 4.46), and `Image.imports` swallows it because the container runs another image (read in the Modal 1.6 source).

## Interpolation

`smooth.frames`, only with `interpolate`:

1. Source frames as they are, each with its own pts (Timed decode); no `fps` filter.
2. Duplicates dropped (Duplicate frames).
3. Each kept frame cropped by the camera path at its own time to a padded side: the render size (`OUT_SIZE`, or `upscale.side` with Upscale) + `PAD` 32 px each side (704 for 640), a multiple of 64 (RIFE's input step, the reason `upscale.side` rounds to 64); same centre, window × padded / output, in gamma (BT.1886 2.4: plain video pixels, what RIFE was trained on), half precision on the GPU; `Head` features once per frame.
4. Output slot j at j / 60: a real frame within a quarter of a slot (`SNAP`) is used as is (30 fps: every even slot; 60 fps with gaps: all but the gaps); otherwise RIFE between the neighbouring kept frames at `(t − t_a) / (t_b − t_a)`, so VFR timing is honoured. A pair across a scene cut (the tracking cuts) is not morphed: the nearer frame is held. Slots before the first or after the last frame hold it. Holes after a camera switch, frozen across, or longer than `MAX_GAP` get a seam instead (Seams): the slot times there are remapped first.
5. The result is cropped back to the output size, brought back to linear light, then the usual `color.encode` and the encoder (Two-pass).

Measured on CPU (2026-10-25, testsrc2 640×360, a 200 px pan): output frame counts and `r_frame_rate` exact in every case; 30 → 60: `synth` 30 of 60 (every odd slot); 24 → 60: 38 of 48 (only every 5th slot meets a real frame); 60 with a 16-frame freeze: 16 dropped, 16 synthesized; 60 with 16 frames missing: 16 synthesized; the same gap with a tracking cut inside: 0 synthesized (held). Visually: a clean middle frame at 30 → 60; filling the 0.27 s freeze leaves slightly wavy edges on the moving bars, the expected cost of a long gap (owner: better than a freeze). CPU speed is about 1 s per RIFE frame at 704²; the L4 speed is not measured yet (`render.encode` logs `synth` and `fps`).

Why crop first: RIFE at 704² costs the same for every source, 4K included, and sees the camera move as smooth global motion; the margin keeps the warp's border padding outside the circle. Rejected: interpolating the whole source frame (4K needs `scale=0.5` and about 20× the work); ffmpeg `minterpolate` (block matching, the artifacts the owner wants to avoid); decoding on a 60 Hz `fps` grid and detecting the repeats (would quantize real timestamps by up to 1/120 s, a fifth of a frame interval at 24 fps; reasoned, not tried).

## Seams

Owner request 2026-10-26: a hole in the source (the phone recorded nothing for a while) must never become a still frame in the note ("an obvious defect"). Telegram for Android restarts the camera when a round switches between front and back. IMG_4042 shows the front camera fading to dark until 1.000 s, one frame of the back camera at 1.043, then nothing until 1.537. The audio track is continuous (AAC packets every 21 ms, no level drop). RIFE between 1.043 and 1.537 drew half a second of a nearly static pot: a freeze.

`smooth.frames` + `seam.py`, only with `interpolate`; the CFR path has no frame timestamps and still holds.

- Detection uses real decode timestamps: `gap` = this frame minus the previous decoded frame, not minus the last kept one, so frames dropped as duplicates of a still shot are not a hole. A gap over `HOLE` (0.25 s) gets a seam when one of these holds (`smooth.switch`):
  - a camera switch: the mean cell motion (`moved().mean()`) of the frame after the hole, or of a frame up to `LONE` (0.2 s) before it, is over `CUT_LEVEL` 50 (×4 for 10-bit);
  - the frame after the hole would be a duplicate of the one before (a frozen phone: RIFE would show a still);
  - the gap is over `MAX_GAP` (1 s).

  Any other hole (0.25–1 s of real motion) stays with RIFE, which keeps the timing exact. The frame right after a hole is never dropped as a duplicate.
- A switch moves the seam start `a` back to the last frame of the old camera. The lone new-camera frames before the hole are never shown; they would flash and then freeze.
- Remap (`seam.sources`): two slowed streams meet in the middle of the hole and fill the output times `[a − LEAD, b + LEAD]` (`LEAD` 0.75 s, clamped to the clip).
  - The old side plays `[a − LEAD, a]` until the end of the dissolve; the new side plays `[b, b + LEAD]` from the dissolve's start.
  - In IMG_4042 both sides play at 0.64×, so motion never stops.
  - The dissolve (`FADE` 0.3 s, smoothstep) is centred on the middle of the hole.
  - Every remapped time is a RIFE frame between real neighbours, so the slow motion is smooth.
- Dissolve (`seam.dissolve`): a mix of the two padded crops in gamma, then a separable Gaussian blur that peaks mid-dissolve.
  - Blur strength = `BLUR` × side (14 px at 704) × `soft`, where `soft` = motion between the two seam frames / `CUT_LEVEL`, capped at 1.
  - A camera switch blurs fully. A frozen phone (both sides alike) dissolves without blur.
  - The look follows iOS camera flips: blur plus cross-fade.
- Audio is untouched: in these files it is continuous.
  - Around a seam the picture is off sync by up to half the hole plus `FADE` / 2 (IMG_4042: about 0.27 s), back in sync at both ends.
  - A hole in the audio itself is still filled with silence (Audio chain). A cross-fade there belongs to the planned feature that joins two videos into one round; that feature will reuse `seam.dissolve`.
- Streaming:
  - A slot is drawn only when no future seam can reach it (`LONE + LEAD` behind the newest kept frame) and the frames it needs have arrived.
  - Kept frames behind the oldest needed time are released.
  - That holds about 1–1.5 s of crops on the GPU: 704² half plus RIFE features, about 5 MB each.
- Thresholds measured on IMG_4042 (2026-10-26, `moved().mean()` between consecutive frames):

  | Event | Value |
  |---|---|
  | camera switch | 88.3 |
  | fastest pans | 25–34 |
  | front camera's fade to dark | 28 |
  | median / p99 | 7.7 / 28 |

  `CUT_LEVEL` 24 marked a pan before the 11.2 s hole as a switch and dropped two real frames; 50 does not.
- Checked on CPU (2026-10-26, RIFE at 128 and 640):

  | Source | Result |
  |---|---|
  | IMG_4042, whole file | two seams: 1.000 → 1.537 (switch, soft 1) and 11.218 → 11.519 (frozen, soft 0). No output frame repeats except the tail after the video ends (21.07 s; the audio runs 0.3 s longer). |
  | testsrc2, 0.5 s cut out | no seam, RIFE as before |
  | testsrc2, 1.2 s cut out | a seam, no repeated frame |
  | testsrc2 → smptebars, no hole | hard cut, no seam |
  | testsrc2, 0.1 s of bars, a hole, bars | one seam from the last testsrc2 frame |
  | IMG_4042 0–3 s at 640 | frame-to-frame motion never drops to 0 through the seam; contact sheet: blur dissolve from the front camera into the pot |
- Known limits:
  - Two holes closer than `2 × LEAD` overlap: the first seam wins, the second jumps.
  - The thresholds come from one Android file. A switch on another phone with less change (both cameras on a white wall) is treated as a frozen or plain hole.

## Timed decode

`smooth.decode`: `-v level+info` and `showinfo` last in the chain; a thread reads stderr, queues each `pts_time` and forwards only `[error]` / `[fatal]` lines to the log. `showinfo` prints before the frame reaches the pipe, so the k-th stamp exists when the k-th frame is read (`STAMP_WAIT` 60 s). `trim=end=` (the clip plus two source frames, so the last slot has a right neighbour) instead of `-t`: `-t` cuts after the filters, after `showinfo` has printed. NOPTS or non-increasing stamps are repaired (previous + 1 / fps, or + 1 ms). With `-ss` before `-i` the stamps start near 0 even for MPEG-TS, whose timestamps do not (checked on the broken test file).

## Rife

`rife.py`: RIFE 4.25 (hzwer/Practical-RIFE: "4.25 by default for most scenes" in its README) IFNet + Head, adapted from HolyWu/vs-rife (`IFNet_HDv3_v4_25.py`, `warplayer.py`), both MIT; notices in `RIFE-LICENSE`. Same parameter names as the checkpoint, loaded strictly with only the `block*` and `encode.*` keys (the checkpoint also carries the training-only `teacher.*` and `caltime.*`). Input sides must be multiples of 64 (704 is). Checked on CPU (torch 2.14, 2026-10-25): strict load, 5.66 M + 6 k parameters; a disc moved 40 px: the middle frame differs from the true one by 0.0006 (mean, 0..1), a plain blend by 0.011; t = 0.25 by 0.0007.

## Rife weights

`cloud.RIFE`: `flownet_v4.25.pkl` from the vs-rife GitHub release `model` (the official links are Google Drive and Baidu, unreliable in an image build), checked by sha256 and baked into the GPU image at `config.RIFE_WEIGHTS`. 24.6 MB, torch zip format, loaded with `weights_only=True`. Not checked: that the release file is byte-identical to the archive on Practical-RIFE's Drive.

## Scene cuts

`media.changes` + `media.scene_cuts`: 512-bin RGB histogram (3 bits per channel, every 4th pixel); d = half L1 distance between consecutive frames. Cut at k when d > 0.3, d > 3 × median(d over ±15 frames, excluding k) + 0.05, and at least 6 frames since the last cut (flashes). Histograms miss cuts between shots of near-identical colour; motion-based scores were rejected because fast pans trigger them.

## Audio chain

`audio.chain(src, meta, start, dur, options, tmp) -> (inputs, af)`, called once by `encode.second_pass` before the fit loop: `inputs` are the ffmpeg input arguments of the audio (`[]` without audio), `af` the `-af` chain. The source audio is trimmed with `-ss start -t n/rate`, the same length as the video (DeepFilterNet replaces the input with its own WAV, Denoise). The chain is `GAPLESS` (`aresample=48000:async=1:first_pts=0`), then the noise reduction, then with `options.loudnorm` a two-pass `loudnorm=I=-16:TP=-1:LRA=7` (the first pass prints JSON on stderr, parsed between the last `{` and `}`; the second uses `measured_*`, `offset`, `linear=false`; skipped when a measured value is not finite, Broken sources). `GAPLESS` fills the holes left by undecodable audio with silence, timed by the frames' pts, and pads the start. Without it loudnorm stamped its first 3 s of output contiguously from the first frame (`af_loudnorm.c`, `activate`, `FIRST_FRAME`), so a hole there pulled the later audio forward: `audiogap.mp4` (0.4 s of audio missing at 1.3–1.7 s, range 1–5 s) had its beeps at 0.59 / 1.6 / 2.6 / 3.6 s instead of 1 / 2 / 3 / 4; plain `aresample` kept the timing but stored the hole as one AAC sample lasting 20480 samples in `stts`, which a player may not honour. With `GAPLESS`: 1 / 2 / 3 / 4 on both chains, contiguous packets; clean audio unchanged. AAC-LC 128k, 48 kHz, stereo (`-ac 2` folds 5.1 down). New audio filters are added to this chain.

## Loudness

Owner request 2026-10-26: "Even out loudness" (`options.loudnorm`, off by default) makes broken sound comfortable and standard: quiet parts louder, loud parts softer inside the note, and the whole note at the iPhone level. Target: Apple's −16 LKFS ±1 dB integrated, true peak ≤ −1 dBFS, BS.1770 (Apple Podcasts "Audio requirements", podcasters.apple.com/support/audio-requirements; Sound Check normalizes playback to −16 too). Noise is not this option's job: the noise slider (Denoise) runs before loudnorm in the chain, and the first loudnorm pass measures the denoised audio, so the levelling lifts less noise.

- `linear=false` forces loudnorm's dynamic mode for every clip: it steers the gain from the 3 s short-term loudness toward the target, so it levels inside the note, and limits true peaks. The old `linear=true` only levelled quiet clips (it falls back to dynamic when the peaks leave no room for a flat gain, which every quiet iPhone recording did) and turned loud clips down flat.
- `LRA=7` instead of the broadcast 11: phone listening. On the owner's 6–21 s clips the LRA target changed almost nothing (5 / 7 / 11 within 0.7 LU); the 3 s levelling dominates.
- Measured (2026-10-26, ffmpeg 9.0.2, the owner's files): a loud clip −6.2 LUFS, LRA 2.1 → −16.0, LRA 1.6 (was −16.1, LRA 2.1, flat); quiet iPhone clips −29.1 / −31.0 → −15.8 / −16.0, LRA 6.5 → 4.5 and 5.2 → 3.6, true peak −1.0; a silent clip keeps `GAPLESS` alone.
- Rejected: `dynaudnorm` (f 250 or 500 ms, g 11 or 15, max gain 6–8) before loudnorm: no gain on four clips, and on one it raised LRA to 13.3 (quiet stretches pumped); a flat gain plus a limiter (the iPhone peaks are so sharp that the limiter ate about 6 dB: −21.8 instead of −16); no gain cap: the owner wants quiet sources raised, noise is the separate option's job.
- Not verified: how it sounds (judge on the phone); loud events shorter than the 3 s window (a shout) are held by the true-peak limiter, not levelled.

## Denoise

Owner request 2026-10-26: noise reduction on one slider (`request.denoise`, 0..1, 0 = off), all of it DeepFilterNet3 of growing strength. Strength `s > 0`: `audio.voice` runs `deep-filter -D -a atten` with `atten` 6 → 100 dB on a log scale (6 · (100/6)^s; 100 = no limit). The trimmed audio goes through `GAPLESS` and −6 dB (`HEADROOM`) into `voice.wav` (f32, stereo) in the render temp dir; the enhanced file becomes the audio input, with `volume=2` (the 6 dB back) and `apad=whole_dur` (`-D` trims the 30 ms model delay from the end) in the chain. The headroom exists because `deep-filter` writes 16-bit PCM whatever the input format and warned "Possible clipping" on a clipped source (observed). DeepFilterNet keeps speech and removes everything else, **music included**: on the owner's `20230812_184416.mp4` (music or loud ambience) even the loud windows dropped 9 dB.

Rejected: FFmpeg `afftdn` for the light end (the first design gave it the left third of the slider). Its default `nf` (−50) and `tn=1` (noise tracking) did nothing measurable on phone audio; tuned to the clip (`nf` = the 5th percentile of 50 ms RMS windows + 8…20 dB, `nr` 12…40) it removed 10–38 dB in the pauses, but the owner heard it on IMG_4042 (strengths 0.15 and 0.33, with loudnorm) as "in a can", the typical cheap-denoiser sound (musical noise of spectral subtraction), and had it cut out entirely; DeepFilterNet from its lightest steps sounded fine. The per-band noise profile (`asendcmd` with `sn start` / `sn stop`) had no effect at all in ffmpeg 9.0.2, even on white noise. Do not bring a spectral-subtraction filter (`afftdn`, `anlmdn`) back as a "light" mode.

The binary: `deep-filter` 0.5.6 (Rikorose/DeepFilterNet, MIT / Apache-2.0, the DeepFilterNet3 model embedded), the static `x86_64-unknown-linux-musl` release asset, fetched in the GPU image build (`cloud.VOICE`, sha256-pinned) to `config.DEEP_FILTER`. The Python package was rejected: `deepfilternet` 0.5.6 (the last, 2023-08-31) needs numpy < 2, `deepfilterlib` has wheels up to cp311 only. Provenance, checked 2026-10-26: the release assets were uploaded by the maintainer's account, not by CI (no workflow of v0.5.6 builds them), unchanged since 2023-08-31; the musl binary is not stripped and holds no socket / exec / fork symbol; its crates are tract (ONNX), hound, rubato, tar / flate2, clap, env_logger, nothing networked; the Windows build of the same release imports no network DLL and Defender found nothing. Building from source in the image would remove the trust in the uploaded file; not done (Rust toolchain + tract compile in the image build).

- Measured locally (2026-10-26, 15 s from 1.0 s, 50 ms windows p5 / p90 in dB, Windows build of the same release): IMG_4042 −51 / −27 → atten 12 dB −63 / −28, no limit −120 / −29; 5670FAB1 −63 / −30 → no limit −120 / −35. With loudnorm every strength lands at −16 ± 0.7 LUFS. Duration unchanged (15.000 s).
- Time: DeepFilterNet ran at about 3 × real time for stereo on the owner's PC (5 s per 15 s); on the 8-CPU render container not measured. It runs inside `second_pass` after the frame loop, so the progress bar waits at `FRAMES_SHARE` meanwhile.
- Not verified: how each strength sounds (judge on the phone); the time on Modal.

## Render options

`encode.second_pass` is the seam: audio options (`loudnorm`, `denoise`) go through `audio.chain` (computed once, before the fit loop). `options.metadata` adds `creation_time` to the encoder and `tags.write` after it (Note metadata). `options.zoom` goes to `camera.solve` in `pipeline.render_job` (Zoom option). `options.interpolate` picks the frame source in `render.render` (`render.cfr` or `smooth.frames`) and the rate (`source.out_rate`). `options.look` and `options.exposure` build one `look.Look` per render, handed to `render.crop` through the `cut` partial, so both frame sources get it before RIFE (Look). `stabilize` goes to `locate.frame_path`, which returns the world next to the path; `render.render(..., world=)` maps the path back to source rows (Stabilization). `deblur` wraps the decoded buffers of either frame source (Deblur).

## Note metadata

`options.metadata` ("Keep original metadata", off by default): the note carries the source's date, place and camera, so iOS Photos can show them after "Save" instead of "No camera information". `tags.py`; `# [DOC: note-metadata]`.

- Read at ingest: `source.probe` calls `tags.read(path, format_tags)` and keeps the result in `meta.tags` (`{key: string}`, `{}` when the source has none; jobs ingested before the field have no key, `tags.kept` and the Mini App treat that as none). Written by `render`: `creation_time` through the encoder's `-metadata` (ffmpeg puts it into `mvhd`, `tkhd`, `mdhd`), the rest by `tags.write(out, tags)` after x264.
- What an iPhone writes (observed with ffprobe and a box dump of the owner's `IMG_0402.MOV`, iPhone SE 2, software 27.2): `moov/meta` (QuickTime form: no version field, `hdlr` `mdta`, `keys`, `ilst`, UTF-8 values) with `com.apple.quicktime.creationdate` (`2026-10-25T23:57:45+0100`, local time with offset), `location.ISO6709` (`+52.3207+021.0548+092.015/`), `location.accuracy.horizontal`, `make`, `model`, `software`, `full-frame-rate-playback-intent` (int); the video `trak/meta` with `camera.lens_model` (`iPhone SE (2nd generation) back camera 3.99mm f/1.8`), `camera.focal_length.35mm_equivalent` (`29`), `camera.lens_irisfnumber` and two `apple-maker-note` ints; four timed metadata tracks (`mebx`: video orientation, detected faces, Live Photo info, segment id). ffprobe (9.0.2) shows only the `moov` keys (format tags), not the `trak/meta` ones, so `tags.read` parses the video trak's `meta` itself.
- Copied (`tags.MOVIE`, `tags.CAMERA`, `creation_time`): the six string keys of `moov/meta` and the three `camera.*` keys, verbatim; ISO 6709 and the creation date keep Apple's exact strings (Photos shows the local time from `creationdate`; `creation_time` is UTC). ffmpeg's `location` (an Android `©xyz`) becomes `location.ISO6709` when the Apple key is absent. Values that ffmpeg reports twice are joined with `;` (observed: `creation_time` of a file written with `use_metadata_tags`); the part before `;` is kept.
- Not copied: `full-frame-rate-playback-intent` (how Photos plays the source), `apple-maker-note` (Apple-private ints), the `mebx` tracks (face boxes and orientation are in source-frame coordinates, wrong after the crop; ffmpeg's mp4 muxer cannot write `mebx`), anything that identifies the original asset (`live-photo-info`, `segment-identifier`, `uuid`, `content.identifier`): reasoned, Photos could pair the note with the original or a Live Photo.
- How it is written: `tags.write` appends a `meta` box in Apple's form (its 34-byte `hdlr`, UTF-8 data type 1, locale 0) to `moov` and the camera keys to the first video `trak`, the same places as the source. `+faststart` puts `moov` before `mdat`, so every `stco` / `co64` offset behind the `moov` grows by the added bytes (the `moov` is built twice: once to measure the growth, once with the shifted offsets), then the file is replaced through `note.mp4.tmp`.
- Rejected: `-movflags use_metadata_tags`. ffmpeg's `movenc.c` (release/8.0, `mov_write_udta_tag`) writes the `mdta` `meta` inside `moov/udta` for mp4 and mov, while iPhones write `moov/meta`; ffmpeg trac #4209 (open since 2015) reports that Apple apps do not show tags written that way. It also writes every global key, `creation_time` and `encoder` included.
- Checked locally (2026-10-26, ffmpeg 9.0.2): a 1080p MOV with the Apple keys set through `use_metadata_tags`, rendered with `metadata` at 640 (and 1080, High resolution, retired): ffprobe reads every key back, `creation_time` lands in `mvhd` and both tracks, the file grows by exactly the `meta` box (545 B), the `framemd5` of both streams equals the render without the option, a `-c copy` remux works; without the option the note has no source tags (as before). On the real `IMG_0402.MOV`: the nine keys plus `creation_time` are read, and the note carries them (`moov/meta` and video `trak/meta`, box dump).
- Owner-confirmed on the iPhone (2026-10-26): the option works, the saved note shows the source's metadata, so iOS Photos reads `moov/meta` in our MP4 (`isom` brand) and Telegram delivers the container metadata.
- Made-here mark (`tags.MARK`, `tags.kept`): with the option on, the note also says it came from this bot. ` (Round from Telegram)` is appended to `com.apple.quicktime.model` (`iPhone SE (2nd generation) (Round from Telegram)`), the device name Photos shows as the camera; a source without a model gets `com.apple.quicktime.software` instead (appended if present, else set to `Round from Telegram`), so even a tagless source carries one tag. Every other tag is copied unchanged. Added in `kept` at render time, so `meta.tags` (what the Mini App sees) stays the source's and jobs ingested earlier get the mark too. Not `camera.lens_model` (the owner's "Back Camera (Round from Telegram)" idea): Photos turns `iPhone SE (2nd generation) back camera 3.99mm f/1.8` into "Back Camera" and the focal length / aperture line, apparently by parsing it, so a suffix there risks losing that line (reasoned); `model` is plain text. Not ffmpeg's `encoder` / `comment`: they land in `udta` (the form Apple apps ignore, see Rejected below). Checked locally (2026-10-26, ffmpeg 9.0.2, CPU render): the note's `moov/meta` carries the marked model, every other key and the `trak/meta` lens key unchanged, video `framemd5` identical to the render without the option; without a model only `software` = `Round from Telegram`; option off: no source tags. Open, owner-testable only: how Photos displays the marked model (whole string, or the lens line suffers).
- Privacy: the location goes to everyone who receives the note. The Mini App hint says so, and the option is off by default.

## High resolution

Retired for good (owner, 2026-10-26): 640 is the ceiling. Two rounds of tests: a 1080×1080 note of unknown size arrived as a regular video; then, with every variant under the 10 MB cap (Note size), the owner's 720 and 1080 notes (H.264 and HEVC switches) still arrived as regular videos, while 640 notes under the cap stay rounds. So the side, not the size, is what Telegram rejects. The switches `hd720`, `hd1080`, `hevc` and the older `hires` are gone; old requests that carry them are ignored (`options` is read with `.get`). Do not bring back a larger side or HEVC without a Telegram change.

## Lanczos matrix

Why our own renderer: ffmpeg `crop`/`zoompan` move only in whole pixels (2 px on yuv420p). Measured on a 4K dot with a 0.3 px/frame pan: integer crop jumps 0 or 1.0 output px (ideal 0.15, error up to 0.48 px); ours errs at most 0.005 px before encoding. libplacebo would do it, but it needs Vulkan, which the Modal GPU container may not have.
`render.weights` builds, per frame and axis, a dense `size × span` matrix (`size` = the output side) of Lanczos-3 weights. Output pixel j samples source coordinate `c − side/2 + (j + 0.5)·side/size − 0.5` (index space, pixel centres are integers). The kernel is widened by `max(1, side/size)` for antialiasing, rows are normalized. Only the touched rows and columns `[lo, hi)` are uploaded and multiplied: `out = Wy @ img @ Wx.T`. Coordinates float64, matrices float32. Dense matmul wastes the zeros (about 20 taps of 2160) but is a few GFLOP per frame at full tensor speed; a gather/unfold version was rejected for memory (about 350 MB per frame at a 4K window).
Resampling happens in linear light: downscaling in gamma space darkens fine bright detail. The cost is full-window chroma upsampling and per-pixel colour conversion before the matmul. Resampling the Y'CbCr planes separately and converting at 640² would be about 4× cheaper; rejected because it resamples non-linear signals, also before HDR tone mapping. Expect slightly stronger Lanczos halos around highlights; negative ringing is clamped.
Measured (CPU, 6 cores, torch CPU): `frame()` 0.47 s at a 1280 window, 0.86 s at 2160 SDR, 1.16 s at 2160 HLG. GPU estimate (not run): 20–30 ms per frame worst case; the bottleneck is likely software 4K HEVC 10-bit decode and the encoder (Codecs).

## Chroma siting

`color.up2`/`down2`: 2× polyphase Lanczos-3 as `conv1d` (an `unfold @ w` version was 3–5× slower on CPU because of per-batch copies). Siting is the H.264/HEVC default "left": chroma i sits at luma x = 2i, vertically between rows 2j and 2j+1. `chroma_location` is not read; top-left or centre siting would be off by a quarter chroma pixel. The chroma crop extends 3 samples beyond the luma span, so crop edges are exact. Output 4:2:0 uses the same kernel widened ×2 as an antialiasing filter, not point sampling.

## Linear light

`color.yuv_to_rgb`: matrix from `meta.matrix` (fallback 709 SDR, 2020 HDR), range from `meta.full_range`. 10-bit frames arrive as `yuv420p10le`, read as int16. SDR: BT.1886 gamma 2.4 both ways, so SDR round-trips exactly. PQ: SMPTE ST 2084 EOTF in nits (matches zimg exactly). HLG: BT.2100 inverse OETF, then the OOTF on luminance, `1000 · Ys^0.2 · E` (γ 1.2 for a 1000-nit display); verified on a synthetic clip encoded to the spec (65.8/184.5/17.6 nits vs expected 65.9/184/17.6). zimg differs here: it applies the OOTF per channel.

## HDR tonemap

On the output frame only: BT.2390 EETF in the PQ domain, source peak `HDR_PEAK` 1000 nits (MaxCLL is not read), target `SDR_WHITE` 203 nits (BT.2408 reference white), no black lift. Applied to max(R,G,B) and scaling all channels by the same ratio, which keeps hue. Below about 100 nits the image is untouched; 203-nit white lands at about 0.84 linear. Then BT.2020→709 with a 3×3 matrix and `soft_gamut`: chroma distance d relative to the 709 boundary along the line to grey (luma kept), compressed above `KNEE` 0.9 with tanh; knee 0.8 visibly desaturated pure primaries. SDR sources skip all of this (clamp only).

## Look

Owner request 2026-10-26: an "HDR" slider and a smart exposure slider that recover what the video holds (darker blown areas, lighter shadows) without inventing anything, previewed live in the Mini App. `look.py`; `render.window` calls the request's `look.Look` on the linear frame after the Lanczos resample and before `color.to_sdr`. With `look` and `exposure` both 0 the object is off (`Look.on`) and the pipeline is exactly the old one.

- Working space: linear light with 1.0 = SDR white: SDR as decoded (BT.1886), HDR in nits / `SDR_WHITE` (BT.2020 luminance). HDR sources then go through the usual EETF (HDR tonemap); SDR sources through `look.shoulder` instead of the bare clamp, because the rebuild and exposure can push values above 1.
- Everything acts on luminance through a gain `2^(L' − L)` on all three channels, so hue is kept; exposure is a shift of the base layer, not of the pixels, which is why highlights are compressed instead of clipped.
- Rejected: Mertens-style exposure fusion of synthetic exposures (Laplacian pyramids: many more passes for the WebGL mirror), generative inpainting of blown areas (invents content; owner's rule), an EMA over the per-frame maps (ghosts on handheld motion; only the global `top` is smoothed).
- Measured (CPU, 2026-10-26): about +160 ms per 640² frame at 720p on CPU, almost all in the full-frame pooling and the guided filter at 256 px; GPU cost not measured (expected a few ms). Stability on IMG_7045 (30 frames, look 0.4): the per-frame mean follows the source smoothly (no pumping); frame-to-frame difference rises from 2.9 to 5.1 levels only because the frame is brighter. Not verified: how each strength looks on the phone; temporal behaviour on scene cuts (the `top` EMA crosses a cut in about `TAU`).

## Look zones

`look.split`: the slider's first `HONEST` (0.4) ramps the honest part (`t` 0 → 1: rebuild, local tone mapping, detail), the rest is the AI repair strength `r` 0 → 1 (Repair) on top of a full honest part. The Mini App mirrors the split (its look mirror).

## Look maps

Per source frame, from the whole display-oriented frame (not the crop), so the maps live in source coordinates: a moving camera window does not change them, and the Mini App computes the same maps from the proxy. `look.maps`: the Y'CbCr planes are area-averaged to a grid of long side `GRID` (256), converted to working linear RGB (gamma-domain pooling, then linearize: the Mini App pools the proxy's R'G'B' the same way), `log2(luminance + FLOOR)`. A self-guided filter (He et al.) on that log luminance, replicate-padded boxes of radius `RADIUS` (8 grid px, about 6.6 % of the long side), `EPS` 0.3 (log2 units squared: edges over about half a stop stay sharp), gives the coefficient maps A, B; `top` = the max of the box mean, the bright-region level (robust to small speculars). For SDR the map also carries the colour ratio of the surroundings (rgb / luminance, box radius `SPREAD` 16, weights 0 where any channel is near clipping) for the rebuild. At an output pixel the maps are sampled bilinearly at its source coordinate (`look.coords`, `grid_sample` with `align_corners=False`, the texel-centre convention WebGL also uses) and the base is `A · L + B` with the pixel's own log luminance (fast guided filter: edges stay at full resolution).

## Look rebuild

SDR only (HDR keeps real values above white). `look.rebuild`: a channel is clipped by `smoothstep(CLIP)` of its gamma value (0.93 → 0.985). The luminance is re-estimated from the unclipped channels and the surroundings' colour ratio (least squares: Σ keep·x / Σ keep·ratio), and only the clipped channels are raised to ratio × estimate, never lowered, scaled by `t`. Where every channel is clipped nothing is rebuilt (`smoothstep(0, 0.5, Σ keep)`): there is no information, and the owner does not want invented content. What this fixes: a sky whose blue channel clipped turns cyan, a face clipped in red turns yellow; the rebuilt values above 1 then go through the curve and the shoulder.

## Look curve

`look.curve` on the base layer (log2 luminance), detail `L − base` kept and boosted by `t · DETAIL` (0.2):

- Exposure first: `base + ev`.
- Shadows: lifted toward `PIVOT` (log2 0.18) by `t · LIFT` (0.75) of their distance, faded in over `DARK` (0.0005 → 0.008 linear) so black and the noise floor stay put (noise there would only be amplified).
- Highlights: `peak = top + ev`; the cap is `max(top, WHITE)` (an exposure push never goes past where the brightest region already was, or white), pulled toward `TARGET` (log2 0.8) by `t`. When the peak exceeds the cap, everything above `KNEE` (log2 0.3) is compressed linearly in log by `(cap − KNEE) / (peak − KNEE)`, with a soft max (`SOFT` 0.5) so there is no kink at the knee.
- `top` is smoothed over time in the render (EMA, `TAU` 0.3 s at the output rate): per-frame stats would pump the brightness.
- SDR display: `shoulder` on max(R, G, B) from `SHOULDER` 0.9 (exponential, C1): white 1.0 lands at 0.963, 1.3 at 0.998.
- Tuned by eye on contact sheets (2026-10-26) of IMG_8784 / IMG_9065 / IMG_5582 (iPhone HLG), IMG_7045, IMG_1037, IMG_7985, IMG_2326 (SDR). `LIFT` 0.5 and `DARK` from 0.001 were too weak to see at full strength; 0.75 lifts the dark background faces of IMG_7045 and the hair of IMG_1037 visibly with no halo at 320 px.

## Look cors

The Mini App draws the proxy `<video>` into WebGL (Look preview), which needs a CORS-clean video: `crossOrigin='anonymous'` on the element and `Access-Control-Allow-Origin` on the media responses, which `CORSMiddleware` adds for the Mini App origin. `Range` is in `allow_headers` in case a preflight happens; not verified on the device.

## Look preview

Owner choice 2026-10-26: the honest part of the slider (`t`) and `exposure` are previewed live in WebGL on the phone (the Mini App's look mirror over the proxy), the AI part (`r > 0`, Repair) as an exact frame from the server, made by the same functions as the note.

- `POST /api/jobs/{id}/look`, body `api.LookRequest` `{time ≥ 0, look: 0..1, exposure: −2..2 (default 0)}` → `{image: 'data:image/jpeg;base64,…', width, height}` (the proxy size). 409 'The video is not ready yet' until the proxy exists or when `time` is past the duration; 502 'The preview is not available' when the GPU call fails (log `look <id> failed: …`). Shares `api.lift` with `/segment` (Lift). The handler passes `job.source` and `job.meta` to the GPU: `Lift` gets no access to the jobs Dict.
- `Lift.look(job_id, at, name, meta, value, ev, size)` reloads the data Volume when the source is not visible yet, then `render.preview`: `WINDOW` (5) frames at the source's own rate (`meta.fps`) through `render.cfr` (the note's decode, raw format, `render.layout` and slow-seek fallback), starting `k / fps` before `at` with `k = min(2, round(at · fps))`, so the frame at `at` is in the middle except in the first two frames; frames missing at the ends are replicated. Each frame goes through `render.still` (the whole display-oriented frame resampled to the proxy size) with one `look.Look(value, ev, transfer, fps)`; with `r > 0`, `repair.middle` runs FastDVDnet over the five and Zero-DCE++ on the result (no α EMA: the first frame of a note gets the same); otherwise the middle frame as is. JPEG quality 85 (`render.JPEG`), pixels = the BT.1886 2.4 inverse of the linear frame, the R'G'B' the note's Y'CbCr is made from.
- Snapshot: `Lift.load` loads both networks on the CPU and imports `render` (scipy, cv2 and the rest end up in the snapshot); `to_gpu` moves them (`repair.to`, FastDVDnet in half precision).
- Checked locally (2026-10-26, CPU, 3 threads): IMG_7045 and IMG_1037 at 0 s, 7 s and the last frame, look 0.3 / 0.8 / 1.0, 540×960: images decode, 39–74 KB of data URL, 10–15 s with repair and 3–4 s without. The endpoint through FastAPI's `TestClient` with a stub GPU call: 200 with the arguments `(job, time, source, meta, look, exposure, (540, 960))`, 409 without a proxy and past the duration, 422 for look 1.2, 502 with the log line when the call raises.
- Not verified: the call on Modal and its latency (estimate: well under a second warm on L4; decode from the previous keyframe dominates for 4K HEVC on the class's 2 CPUs).

## Preview tail

`render.preview` clamps `at` to `duration − TAIL / fps` (`TAIL` 1.5 frames). The Mini App stops playback on `end`, which defaults to the duration, so the paused `time` is often exactly `meta.duration`. On a low-rate source (device log 2026-10-27, job `pZoYthWy7y`: 384², 8.29 fps, 6.4 s) the decode then starts `k / fps` before the end, past the last real frame, `-ss` drops everything and `cfr` yields nothing: `Unreadable(NO_RANGE)`, 502, no exact frame. The cause is reasoned from the log and the code (the `-ss` start after the last frame's pts); the clamp is not verified on that file. A source whose video stream ends well before `meta.duration` (audio longer) can still miss.

## Repair

The AI part of the HDR slider (`r` of `look.split`, Look zones), for old, cheap, dark and noisy phone videos; owner approved both models 2026-10-26. `repair.py`; `render.render` wraps the frame source (`cfr`, or `smooth.frames` after RIFE) in `repair.frames` when `r > 0`, before `upscale.frames`, so FlashVSR gets the cleaned frames. Frames in and out are linear SDR [0, 1] `(3, S, S)` on the device, same count and order; both networks run in gamma (`v = lin^(1/2.4)`, plain video pixels, what they were trained on) and the result goes back to linear.

1. FastDVDnet (Tassano, Delon, Veit, CVPR 2020; `fastdvdnet.py`, `model.pth`, trained for AWGN σ 5–55): two stages of the same U-Net (`DenBlock`) over 5 frames with a noise map; σ = `r × SIGMA_MAX`, a uniform map. Sides are reflect-padded to a multiple of 4 (`ALIGN`) and cropped back. A stage-1 output (`temp1` over a triplet) is computed once per centre frame and fed to three stage-2 calls (`repair.triples`, `repair.stage`): 2 `DenBlock`s per frame instead of 4. The ends are replicated (upstream reflects): the first output sees x0, x0, x0, x1, x2. The stream holds two frames of lookahead.
2. Zero-DCE++ (Li, Guo, Loy, TPAMI 2021; `zerodce.py`, `Epoch99.pth`): α maps from the frame downscaled by `SCALE` 12 (as its `lowlight_test.py`), then 8 curve steps `x += α(x² − x)`. Two changes from upstream, both from the contact sheets: one map (the mean of the three) applied to max(R, G, B) with every channel scaled by the same ratio, as in HDR tonemap (upstream's per-channel curve turned dark faces pink and washed colours out); and α × r × `LIFT` 0.5 (the full curve on top of the honest lift flattened faces to white). The low-resolution map is smoothed over time (EMA, `TAU` 0.5 s at the output rate, starting from the first frame's map) so the brightness does not pump. The EMA is in frame coordinates: a fast pan smears the map for a moment (low frequency; not seen in the tests).

- Tuned by eye (2026-10-26, 640² crops of IMG_7045 and IMG_1037, sheets at σ 0 / 10 / 15 / 20 / 25 / 30 / 45 and look 0.4 / 0.6 / 0.8 / 1.0): `SIGMA_MAX` 15/255. The suggested 25–35 turned faces and curls to plastic; already 10 smooths these sources visibly, because their noise is mostly compression, not sensor grain. A grainier source may want more: owner to judge. `model_clipped_noise.pth` (same repo) was a little smoother and darker in the shadows; not used. Running the curve before the denoiser looked about the same; denoise first was kept.
- Numbers (CPU, 15 consecutive frames mid-clip, gamma levels 0..255; r 0 → 1): mean R/G 1.43 → 1.46 and B/G 0.765 → 0.758 (IMG_7045), 1.135 → 1.148 and 0.918 → 0.924 (IMG_1037): no visible colour shift. Mean frame-to-frame difference 5.19 → 5.91 (IMG_7045) and 5.04 → 5.00 (IMG_1037) while the mean level rises by 33 % and 44 %, so relative to the level it falls (7.9 → 6.7 %, 8.7 → 6.0 %); the frame-mean jitter grows only with the level (1.31 → 1.25 %, 1.11 → 1.04 % of it): no added flicker.
- Checks: strict loads; 2 479 096 parameters (FastDVDnet, plus the BatchNorm running stats) and 10 561 (Zero-DCE++); outputs identical to the upstream definitions on random input (max difference 0.0, CPU); the stream returns n frames for n = 0, 1, 2, 12; odd sizes (482×270) come back unpadded. `render.render` end to end on CPU (IMG_7045, 8–10 s, look 0.8, AV1, still camera): 60 of 60 frames, a 640² AV1 note of 3.7 MB, 312 s in all (the frame loop with repair dominates).
- Time: measured on CPU (6 threads, torch 2.14): one `DenBlock` 1.19 s at 640², the stream 2.8–4.5 s per frame, Zero-DCE++ with the curve 69 ms. L4: not measured; estimate (about 65 GMAC per `DenBlock` at 640², two per frame, fp16) 15–40 ms per frame, so 1–2.5 min more for a 60 s note at 60 fps. Zero-DCE++ runs in fp32 (tiny at 53²; the curve at full size in fp32).
- Licences: FastDVDnet MIT (its `LICENSE`, "Copyright 2024 Matias Tassano"). Zero-DCE++: the repository has no licence file; its README says "The code is made available for academic research purpose only. Under Attribution-NonCommercial 4.0 International License." This bot is personal and non-commercial, which CC BY-NC allows; "academic research purpose only" is narrower, and the owner accepted it (2026-10-27) because the project is personal and non-commercial, and keeps StableLLVE (MIT) in mind as a replacement if the result or the licence becomes a problem. Never use the bot commercially with Zero-DCE++ in it. Notices in `FASTDVDNET-LICENSE` and `ZERODCE-LICENSE`.
- Why two vendored files: they carry different licences (MIT and CC BY-NC), so the CC BY-NC code stays in its own file.

## Repair weights

`cloud.REPAIR`: `model.pth` (9 971 551 B, sha256 `9d9d8413…5d2a17`) from m-tassano/fastdvdnet at commit `c8fdf618`, and `Epoch99.pth` (52 395 B, sha256 `ca8855b9…7f3b84`) from Li-Chongyi/Zero-DCE_extension at commit `09f202b6`, fetched from raw.githubusercontent.com at the pinned commits, sha256-checked and baked into the GPU image at `config.DVD_WEIGHTS` and `config.DCE_WEIGHTS` by `cloud.fetch` (the same two commands as the RIFE weights and `deep-filter`). Hashes computed 2026-10-26 from both a git clone and the raw URLs (identical; the files are plain blobs, not Git LFS). The FastDVDnet checkpoint was saved from `DataParallel`: `fastdvdnet.load` strips `module.`. Both are legacy pickles, loaded with `weights_only=True` and `map_location='cpu'` (they hold CUDA storages).

## DSTNet+

The network behind deblur steps 2–4 (Deblur): DSTNet+ L with the GoPro weights (Pan, Sun, Xu, Dong, Tang; sunny2109/DSTNet-plus).

- `dstnet.py`: `load(path, size='base')` (`SIZES`: `base` 64 / 3 / 15 from `test_base_GoPro.yml`, `L` 96 / 5 / 25 from `test_large_BSD.yml`; we use `L`), strict load of the checkpoint's `params`, `weights_only=True`. `run(frames, model, clip=10, overlap=2, half=True)`: frames `(t, 3, h, w)` RGB, uint8 or float in 0..1 (no mean / std, as upstream `img2tensor`); returns float `(t, 3, h, w)` in 0..1 on the CPU; moves the model to `cuda`. The model adds its output to the input (residual), `run` clamps.
- Port: the architecture of `dstnetplus_deblur_arch.py`, `prog_dynconv.py`, `blocks.py`, `arch_util.py` at commit `54363c15`, with the CuPy kernel of `IDynamicDWConv` (per-pixel 3×3 depthwise conv, `group_channels=1`) replaced by `F.unfold` × weight summed over the taps (same sum, other summation order; runs in fp16 too). It costs a transient of 9 × the feature map per call; a sum of 9 shifted slices would be the cheaper exact alternative. Dropped: `nonblind_denoise` (the denoise weights are not used), einops, the `DWT` / `IWT` helpers, the random init. `ForwardProp` / `BackwardProp` are one `Propagation` with `reverse`, and `ResBlock` / `ResidualBlockNoBN` (identical maths) one `ResBlock`.
- Do not rename modules: the state-dict keys are upstream's, typo and nesting included (`resblock_bcakward2d.main.0.N`, a `Sequential` inside a `Sequential`, `Block1..3`, `wave.haar_weights`).
- Padding: frames are reflect-padded to a multiple of `PAD` 16: the Haar step halves the size and `IDynamicDWConv` pools the half-size map down to 1/8, so 16 keeps the pool windows exact (as the 256 training crops and the 1280×720 test frames).
- Clips: `clip` 10 frames overlapping by `overlap` 2, the overlap crossfaded with linear weights. Upstream tests 30-frame clips with no overlap, which leaves seams at clip boundaries.
- Precision: fp16 is fine on the GPU: fp32 vs fp16 on 10 frames max 1.84, mean 0.032 8-bit levels. Speed: 1429 ms per frame at 384² on the throttled local GPU (not an L4 figure).
- Checks (2026-10-28, CPU, 3 threads, torch 2.14): strict load of `DSTNetPlus_L_gopro.pth`; on 12 real frames at 68×60 (`run`, fp32) and on an odd 33×29 clip (`forward`) the output is identical to the first literal port (max difference 0.0).
- Trap: uniform random noise as input gives NaN on the last frame of a clip in fp32 (upstream maths too, not the port): test with real frames.
- Weights: `https://huggingface.co/Meloo/DSTNetPlus/resolve/main/pretrained_models/DSTNetPlus_L_gopro.pth` (56 497 994 B, sha256 `28beafbae0c2f6353d97c560d15d102b844785bab8cb16b3fb0a6f833f430f42`, equal to HF's `X-Linked-ETag`, repo commit `044df7d7`); a file of the same name is in the GitHub release `v0.1.0` (not hashed). Loads with `weights_only=True`. Baked into the GPU image at `config.DSTNET_WEIGHTS` by `cloud.DEBLUR` through `cloud.fetch`, like the repair weights. The URL points at `main`, not the commit: a replaced file fails the sha256 check at build time and the image does not build; then re-check the new file and update the hash, never drop the check.
- Licences: code Apache-2.0 (the repository's `LICENSE.txt`, BasicSR's, "Copyright 2018-2022 BasicSR Authors"; GitHub reports `Apache-2.0`). The HF repository has no model card and no licence tag. The weights were trained on GOPRO (Nah, Kim, Lee, CVPR 2017), "released under CC BY 4.0" (its page). Notices in `DSTNET-LICENSE`.
- Weights licence: none is stated for the weights, which by default means all rights reserved (GitHub Docs, "Licensing a repository": without a licence "default copyright laws apply"). The owner accepted the risk (2026-10-28) because the bot is personal and non-commercial and the weights are fetched from the authors' own repository at build time, never redistributed. Do not ship them in a public image or use the bot commercially with them; ask the authors for a licence first.

## Deblur

Motion-blur repair, one control `deblur` 0..4 (`api.RenderRequest`, owner 2026-10-28, picked by eye from side-by-side renders of the 384² doc clip):

| Step | What runs on a problem frame |
|---|---|
| 0 | nothing |
| 1 | classical: sharp-pixel transfer from aligned neighbours (Deblur classical) |
| 2 | DSTNet+ L GoPro on the source (DSTNet+) |
| 3 | DSTNet+ on a 50/50 luma mix of the source and the classical result (`FEED`) |
| 4 | classical, then DSTNet+ on its result |

Measured earlier on the doc clip (whole-clip runs, scratch): sharpness 304 (step 2), 291 (step 3), 322 (step 4); flicker 0.149 for step 3.

- Files: `deblur.py` (detection, run plan, steps, the stream wrapper, the model call), `lucky.py` (classical). `render.render` builds `deblur.cleaner(...)` and hands it to `render.cfr` / `smooth.frames` as `clean`, which wraps `media.reader`: the deblur sees the decoded YUV buffers, before `cut` (window resample, look, stabilization warp) and so before fill, RIFE, repair and upscale. The free tier wraps `crop.frames` the same way (`crop.render`).
- Why first: blur lives on source pixels. Any resampling first (the rotation warp, the lanczos window, RIFE's synthesis) smears the blur streak and the sharp donor pixels differently, and the flow between neighbours gets worse. In `smooth.frames` the deblur runs on every decoded source frame at `meta['fps']`, before the duplicate drop.
- Steps 2–4 run DSTNet+ in-process in the `Render` container (weights baked into the GPU image at `config.DSTNET_WEIGHTS`, loaded once per container by `deblur.network`). Rejected for now: a parallel `Deblurrer` class with chunk fan-out like `Upscaler` (Upscale chunks). It is the fallback if DSTNet+ on an L4 is too slow for long notes: the stream would then split into chunks with a lead of `OVERLAP` frames.
- Stats: `render.render` returns `deblurred` (frames processed, crossfade included) and `deblur_nan` (Deblur model).
- Free tier: `api.FREE_DEBLUR` 0, the one switch. Step 1 there needs OpenCV on the Oracle VM (`opencv-python-headless` is only in the `gpu` group; a new dependency, owner's call) and `crop.render` imports `deblur` lazily so the VM does not need it while the switch is 0. Steps 2–4 never run there (no GPU).
- Not wired yet: `pipeline.render_job` must copy `deblur` from the request into `options` (as `denoise`, `look`, `exposure`); the weights fetch in `cloud.py`; the Mini App control.
- Unknown: classical cost on Oracle arm64; DSTNet+ L speed and VRAM on the Modal GPU at the working size (Deblur stream); how DSTNet+ behaves on HDR (PQ / HLG) code values: it was trained on SDR GoPro frames.

## Deblur detect

Which frames get the heavy work. Per frame, at the working size: Tenengrad (mean squared Sobel of luma, `lucky.sharpness`) and the motion to the previous frame (median of the DIS flow magnitude over the whole frame, scaled so the crop side is `REF` 384 px, `lucky.speed`).

- Rule: flagged if speed ≥ `SPEED` 2 px / frame at 384 OR ln(peak Tenengrad within ±`WINDOW` 0.3 s) − ln(own) ≥ `DEFICIT` 0.15.
- `SPEED` measured (2026-10-28, scratch `deblur/detect.py`, doc clip, 259 unique frames; gain = log Tenengrad of DSTNet+ over the source): mean gain by speed < 1: 0.03, 1–2: 0.08, 2–4: 0.18, 4–8: 0.36, > 8: 0.46; speed ≥ 2 picks 69 % of frames and 96 % of the gain above the floor. Spearman with the gain: speed 0.90, deficit 0.86.
- Speed estimate: the scratch used dense DIS central-difference velocity over the disc on unique frames. Ours is the mean of the two adjacent frame-to-frame medians, or the larger one when one side is a duplicate (`STILL` 0.05 px). Against the scratch numbers on the same clip: Spearman 0.955, median ratio 0.975, 70 % flagged vs 69 % (observed). The max of the two (rejected) read 18 % high and flagged 79 %. Not `motion.flows`: its sparse LK pairs reach `render.render` only when stabilization is on, and the speed belongs at the deblur's own rate and size; one small DIS per frame is cheap.
- Scale: `REF / crop side` with the crop side from the median of the camera path (`render.render`), 640 on the free tier. A 1080 crop thus needs 2 × 1080 / 384 ≈ 5.6 source px / frame. Reasoned: blur shows relative to the circle, and the 384 clip was a whole round.
- `DEFICIT` 0.15 (≈ 14 % below the local peak): picked from the same data, weakly. Slow frames (speed < 2) with deficit 0.1–0.2 gained 0.141 (7 frames) against 0.050 below 0.05 (55 frames). On the doc clip it adds only 3 frames to the speed rule. Uncalibrated beyond that one clip.
- Run plan (`weights`): flags dilated by `DILATE` 1, gaps ≤ `GAP` 4 merged, then `CONTEXT` 2 frames each side processed and crossfaded back to the source (weights 2/3, 1/3). Weight-0 frames come out bit-exact.
- Full doc clip (273 frames, observed): 218 raw flags, 21 frames left untouched (a very shaky clip).

## Deblur classical

`lucky.py`, ported from the scratch (`deblur/common.py`, `run.py`), after Cho, Wang, Lee (SIGGRAPH 2012). Luma only, in 8-bit limited-range levels (`deblur.frames` converts 10-bit and full range in and out).

- Donors: up to `DONORS` 4 frames within ±0.3 s with Tenengrad > `MARGIN` 1.1 × own, the sharpest first; their gain ramps over `RAMP` 0.4 of the ratio. Each is aligned by DIS (medium preset, finest scale 0) with a forward-backward check (`FB_SIGMA` 2 px).
- Re-blur: the donor is blurred along `TAU` × velocity in linear light (gamma 2.4), velocity from the nearest neighbours that differ (central difference); `TAU` 0.5 is the median exposure fraction fitted on 46 frames of the doc clip (observed). What is transferred is the detail the re-blur removes, weighted by a photometric check (`PHOTO_SIGMA` 8 levels) and Tenengrad^`POWER`; the result is clamped to the 3×3 range of the frame and the donors (no halo).
- Differences from the scratch: no disc masks (the bot deblurs the whole frame); "inside the frame" replaces the disc test for the warped donor.
- Self-gating: a frame without a sharper donor stays as it is. On the doc clip, of 90 processed frames 37 changed (frames 0–89) and of 65 processed 21 changed (95–184).
- Cost (observed, Windows x86 CPU, 3 threads, 384²): 185–234 ms per processed frame; the stream with detection 200–280 ms per frame. Scales with area: about 0.6 s at 640².
- Frame-to-frame Tenengrad flicker (std of Δln) on the doc clip went 0.062 → 0.046 and 0.042 → 0.031 with step 1 (observed); the median sharpness hardly moves, since the gain sits on the worst frames.

## Deblur model

`deblur.modelled`: the model sees RGB built from the step's luma (source, mix or classical) and the source chroma (upsampled bilinear, siting ignored) with the source matrix, in gamma, clamped to 0..1, as GoPro frames. Only the luma change `luma(out) − luma(in)` is kept and added to the step's luma: the round trip and the clamp cancel, and chroma stays the source's.

- NaN guard: DSTNet+ can return NaN on the last frame of a clip (DSTNet+, Trap). A frame with any non-finite value falls back to the step's input (classical for step 4, the mix for step 3, the source for step 2) and counts in `deblur_nan`.
- `run` gets `half=True`, `clip` 10, `overlap` 2, and moves the model to CUDA itself.

## Deblur stream

`deblur.frames(stream, geo, rate, step, side, stats, net)`: same buffers in, same count and order out.

- Trap: `media.reader` recycles `DEPTH` 4 buffers. The stream copies each buffer before holding it; an unflagged frame is that copy, unchanged.
- Working size: the whole frame scaled so the crop side is at most `WORK` 640 px. The luma change is upsampled bilinear to the source and added, rounded and clipped to the code range. A landscape source deblurs the area outside the crop too (about 1.8× the work of the crop alone for 16:9); restricting it to the union of the windows is a possible saving.
- Blocks of `BLOCK` 24 frames are decided once the stream is `reach + 1 + DILATE + GAP + CONTEXT` frames ahead (the flags of a frame depend on its ±0.3 s peak and the next frame's motion, the weights on flags ±7). Behind, `reach + OVERLAP` frames of working luma stay for donors and model context. The model gets the processed frames of the block plus `OVERLAP` 2 context frames each side; a run that crosses a block boundary is two model calls with 2 frames of context (a possible seam, not seen with the identity check, not checked with the real model).
- Memory: `BLOCK` + ahead source buffers (about 50 at 60 fps): about 1.2 GB for 4K 10-bit, plus working luma and chroma.
- Checks (2026-10-28, CPU, doc clip, scratch `deblur/check_bot.py`): through recycled buffers, step 1 equals a whole-clip reference bit for bit (90 / 90 frames, two ranges); steps 2–4 with an identity net equal source / mix / classical exactly; a +0.04 net gives luma changes 9 / 6 / 3 at weights 1 / 2/3 / 1/3; a NaN net leaves all frames finite and counts 4; weight-0 frames are bit-exact; 10-bit buffers keep chroma unchanged. `render.render` on CPU, 2 s at step 1: 60 frames, 51 processed, AV1 note written.

## Output encode

`color.encode`: BT.1886 inverse, BT.709 Y'CbCr limited, 4:2:0 as above, then a static dither (uniform ±0.5 LSB, fixed seed, the same pattern every frame: temporal noise would cost bitrate). Raw yuv420p 640² frames leave the GPU through a bounded writer queue (`encode.writer`) and are encoded in two passes (Two-pass) with the codec of the request (Codecs). Tags come from `setparams` (`media.BT709`) + `setsar=1` in both passes. Decode, GPU work and the first pass overlap: a reader thread with `DEPTH` reusable buffers, the writer thread feeding both the raw file and the first pass; on any exception the first pass is killed and the queue is closed.

Trap: libx265 converted untagged `rawvideo` input to full range. Tag the frames (`setparams ... range=tv`) whenever raw frames go into an encoder.

## Note size

A note file over the size limit arrives as a regular square video, not a round, even with `round_message=True` and `length=640` (owner, 2026-10-26: job `WKRXzRMgDi`, 18.9 s at 60 fps, 13.2 MB, twice, with and without metadata; the last round that worked, `pRBvJxLSTr`, was 8.4 s, 5.7 MB). The exact threshold is not verified; the server config recommends `max_size` 12 MiB = 12 582 912 B (Telegram limits).

Owner decision 2026-10-26: every note spends its budget (short notes get far more bits, long ones are trimmed and never go over), and the budget is `encode.NOTE_BYTES` = 10 000 000 B. It was 12 000 000 B (0.58 MB under 12 MiB) for a few hours: the AV1 and VP9 test notes of 12.8 s, which filled that budget to about 11.6 MB (reasoned from the target, the files were not measured), arrived as regular videos, while every round that worked (the HEVC one included) was under 10 MB. So the owner (2026-10-26) put the cap back to 10 MB to tell size from codec, and under it AV1 and VP9 notes stayed rounds and played on the iPhone (owner, 2026-10-26): the size was the whole problem, 10 MB is the ceiling. The earlier design (CRF 16 with a VBV maxrate cap, 10 MB) left short notes at CRF quality and gave long ones an uneven clamp.

- `encode.target`: `bits/s = min(MAX_RATE 14M, (NOTE_BYTES × 8 × HEADROOM 0.97 − audio 128k × dur) / dur)`. A 60 s note gets 1.17 Mbit/s of video, 18.9 s gets 4.0 (1.42 and 4.8 under the 12 MB budget). `MAX_RATE` is the "reasonable" ceiling: H.264 High at level 4 allows 25 Mbit/s and beyond about 14 Mbit/s nothing is visible at 640² (reasoned, not measured); notes up to about 5.5 s hit it and stay under the budget.
- Two-pass ABR lands within about 1 % of the target (measured below), `HEADROOM` 0.97 covers that and the MP4 overhead. Short notes overshoot more (4 s at 14 Mbit/s: AV1 +16 %, VP9 +12 %, H.264 −5 %), harmless under the ceiling.
- Hard ceiling (owner: always a round, never a regular video): `encode.second_pass` checks the file after every second pass; over `NOTE_BYTES` it reruns the second pass from the same raw frames and first-pass stats with the target scaled by `SHRINK` 0.95 × limit / size, up to `FIT_TRIES` 3, then fails the job. No second generation of lossy frames any more (the old `render.shrink` re-encoded the note itself). `fit` in the result and the log is the final scale. Runs before `tags.write`, so the kept metadata is added to the final file.
- Measured under the 12 MB budget (local ffmpeg 9.0.2, 6 cores, 2026-10-26; the 18.9 s note `WKRXzRMgDi` as the source, looped to 60 s; two passes at the target, video only): 18.9 s → x264 11.57 MB, x265 11.24, SVT-AV1 11.42, VP9 11.35 for an aim of 11.34; 60 s → 10.66–10.78 MB for an aim of 10.68. With audio the 60 s note ends near 11.6 MB.
- Do not raise `NOTE_BYTES` or `MAX_RATE` without a send test on the phone; the 10 000 000 B budget is the one known to keep rounds, the threshold lies between 10 and about 11.6 MB (Telegram experiment).

## Codecs

Owner request 2026-10-26: a codec choice in the Mini App (`RenderRequest.codec`, Mini App `CODECS`, `encode.CODECS`), AV1 by default, HEVC and VP9 to pick (owner, 2026-10-26, third round, after AV1 and VP9 notes under 10 MB stayed rounds and played on the iPhone). Every codec goes through the same two passes and budget; MP4 sample entries `av01`, `hvc1` (`-tag:v hvc1`, Apple players need it), `vp09`, checked with ffprobe. The list order is the Mini App's segment order, default first.

Dropped keys, accepted nowhere: `h264` (owner, second round: "an old format, only modern codecs"; it stayed a round in every test) and `h266` (owner, third round: nothing played it). `RenderRequest.codec` rejects both with 422; the Mini App falls back to its first codec (`av1`) for a stored draft with either.

| key | encoder | settings | VMAF at 60 s, 1.42 Mbit/s | passes, 60 s at 60 fps (local, 6 cores) | status |
|---|---|---|---|---|---|
| `av1` | libsvtav1 | preset 6 | 95.5 | 25 + 70 s | default; a round, plays on iOS (owner) |
| `hevc` | libx265 | slow, Main, `slow-firstpass=0` | 93.6 | 71 + 137 s | a round (owner) |
| `vp9` | libvpx-vp9 | good, cpu-used 4, row-mt, alt-ref, lag 25 | 91.8 | 14 + 153 s | a round, plays on iOS (owner) |
| (dropped) `h266` | libvvenc | preset faster, Main 10 (`yuv420p10le`, the only input vvenc takes) | not run | 32 + 240 s at 18.9 s | not a round; played neither on iOS nor on Desktop |
| (dropped) `h264` | libx264 | slower, tune film, High | 91.7 | 11 + 46 s | a round (every note before 2026-10-26) |

- VMAF is against the source note, which is itself H.264, so x264 is favoured; HEVC and AV1 are probably better than the table says. At 18.9 s (4.8 Mbit/s) x264, x265, SVT-AV1 and VP9 score 98.2–98.5: the codec matters for long notes.
- Speed: the first pass runs while the GPU renders, so the cost on top of the old single encode is mostly the second pass. x265 `slow` with its default slow first pass took 144 + 136 s; `medium` 61 + 78 s for 92.1 (the lever if HEVC renders feel slow). VP9 at cpu-used 2 scored 92.3 for 16 + 320 s, so cpu-used 4. AV1 preset 5 gave the same 95.5 as preset 6, slower. The Modal `render` function has 8 CPUs; not measured there yet.
- Who can play what (primary sources, 2026-10-26): Telegram iOS builds FFmpeg with `--enable-decoder=h264,libvpx_vp9,hevc,...,libdav1d,av1` and `--enable-hwaccel=h264_videotoolbox,hevc_videotoolbox,av1_videotoolbox` (`submodules/ffmpeg/Sources/FFMpeg/build-ffmpeg-bazel.sh`) and vendors `third-party/dav1d` and `libvpx`; Telegram Desktop builds dav1d and libvpx (`Telegram/build/prepare/prepare.py`). Neither enables a VVC decoder, which is why H.266 was dropped. Not verified: Telegram Android (MediaCodec, per device) and Desktop for AV1 and VP9 notes.
- Why H.266 stays out (do not re-add without a client decoder): VVC at 18.9 s scored 97.7 at `faster`, 99.0 at `fast`, but pass 2 took 240 s and 468 s (local, 6 cores), it undershot short notes (4 s: 2.3 MB for a 7 MB aim), and the clients above cannot decode it. Android 17 has a platform VVC decoder only where the SoC vendor ships one.
- SVT-AV1 prints its banner to stderr; `encode.QUIET` sets `SVT_LOG=1` (errors only).

## Two-pass

`render.render` opens a temp dir (`tempfile.TemporaryDirectory`, the container's local disk, never the Volume) and starts `encode.first_pass` (stats only, `-f null`) before the frame loop. `encode.writer` writes every frame both to `frames.yuv` in that dir and into the first pass. After the loop: the first pass must exit 0, then `encode.second_pass` encodes `frames.yuv` + the source audio (`audio.chain`: inputs and filter computed once, Audio chain) into the note, with `-progress pipe:1` parsed for `frame=` lines. Progress in the chat: the frame loop maps to 0–`FRAMES_SHARE` 0.6, the second pass to the rest.

- Disk: raw 640² yuv420p is 0.6 MB a frame, 2.2 GB for 60 s at 60 fps; deleted with the dir.
- Rejected: two passes both from a pipe (the GPU work would run twice) and a lossless intermediate (an extra encode, and raw is cheap on local disk).
- `-pass` / `-passlogfile` work for all four encoders in ffmpeg 9.0.2 (x264 `.mbtree`, x265 `.cutree`, SVT-AV1 and libvpx their own stats), all inside the temp dir.

## Ffmpeg build

Modal image (`cloud.FFMPEG`): BtbN static build, linux64 gpl n9.0, a month-end autobuild (kept 2 years; daily builds only 14 days), checked by sha256. Its configure strings (checked 2026-10-26 on the pinned tarball) include `--enable-libx264 --enable-libx265 --enable-libsvtav1 --enable-libvpx --enable-libaom --enable-libdav1d --enable-libvvenc --enable-libvidstab --enable-libvmaf --enable-libzimg --enable-libplacebo --enable-vulkan`. The Linux binary has not been run outside Modal.

## Tracking

`track.track(frames, index, points, box, mask='', progress=None)`: SAM 2.1 video (HF transformers `Sam2VideoModel`), two passes from the prompt frame, forward to `N-1` and backward to `0`, each in its own `Sam2VideoInferenceSession`. `progress(fraction)` every `PROGRESS_EVERY` (30) frames.

- `present` = object score logit > 0 and mask area ≥ `MIN_AREA` (1e-4 of the frame). `cx`, `cy`, `r` are NaN wherever `present` is False (`camera` treats non-finite as absent); `area` is always filled.
- CUDA: model and session in bf16 (`DTYPE`); CPU: fp32. bf16 on CUDA ran clean in the Lift spike (2026-10-26, L4, the same `_pass` loop, 90 frames, no dtype error); the original repo uses autocast instead.
- The HF processor is not used: `Sam2ImageProcessor` needs torchvision + pillow, which are not installed. `_pixels` and `_prompt` reproduce it (bilinear antialiased resize to 1024², /255, ImageNet mean/std; points scaled by `1024/W`, `1024/H`; a box becomes two corner points labelled 2 and 3 placed before the clicks, as `processing_sam2_video.py` does). If the processor is ever adopted, compare masks before switching.
- Do not construct `Sam2VideoInferenceSession` without `dtype`: its default is the string `'float32'` and `add_new_frame` crashes on it.
- A single click makes SAM pick among three candidate masks and may return a part of the object (measured: the inner part of a disc, r 15 instead of 28). A box or two or more clicks give the whole object. With Lift the owner sees the three candidates and the chosen one goes to the tracker as a mask, so the tracker no longer guesses.
- Weights are cached in the `rounds-models` Volume (`HF_HOME`); `pipeline.render_job` loads the model (`track.load`, cached per container) and commits the Volume before the job, so only the first run downloads (~0.9 GB for large).
- Measured on CPU only (tiny, synthetic 512×384 clip, full 10-frame occlusion, a look-alike distractor): `present` False on all occluded frames, no switch to the distractor, centre error 0.8 px mean. GPU speed: large in bf16 on L4, 9.5 fps on 576×1024 frames, one pass (Lift spike, 2026-10-26); the same with a point or a mask prompt.

## Tracking memory

Streaming mode keeps every frame and every per-frame output in the session forever: about 6 MB per frame of output state (`high_res_masks` 1024² fp32 alone is 4 MB) plus the input frame, ~10 GB for 1800 frames. `_pass` pops `processed_frames[k]` right after the step and drops non-conditioning outputs `max_object_pointers_in_encoder` (16) frames behind the current one. The model reads only the last `num_maskmem - 1` (6) outputs for memory and the last 15 for object pointers, plus the prompt frame's conditioning output, which stays. Measured: at most 16 kept outputs and 0 kept frames per session. A model that reads older frames would need a wider window.

## Tracking circle

The 256² mask logits are upsampled bilinearly to the frame size and thresholded at 0. Connected components smaller than `KEEP_BLOB` (0.2) of the largest are dropped: a far spurious blob would double `r` and pull the camera, while dropping a small true fragment only shrinks the circle slightly. `cv2.minEnclosingCircle` on the kept contours; `+0.5` converts pixel indices to pixel-centre coordinates. The circle centre is returned, not the mask centroid: `(cx, cy, r)` must be a circle that contains the object, which is exactly the camera's constraint; jitter is the camera solver's job.

## Track preview

Owner request 2026-10-27: in the Mini App the selection dot and box move with the object while the playhead moves (`miniapp/src/features/viewer/README.md`, Follow). `POST /api/jobs/{id}/track`, body `api.Span` `{start, end, prompt}` (the range and prompt rules of `RenderRequest`, which now extends `Span`; 422 without `prompt.time` or past the duration) → `Lift.follow` → `follow.follow` → `{fps, start, boxes}`. Sample `k` is at `start + k / fps`. `boxes[k]` is `[x0, y0, x1, y1]`, normalized to the display frame, or `None` where the object is hidden or gone. A JSON `null` answer means a newer follow superseded this one. Errors go through `api.lift`: 409 before the proxy exists, 502 'The object cannot be followed here' with the log line `follow <id> failed`.

- Same tracker as the render (SAM 2.1 large video, `SAM_MODEL`), so the preview shows what the note will follow. `follow.load()` builds a second copy of the weights next to the `Segmenter` in `Lift.load` (snapshot, CPU, bf16, about 0.45 GB; Lift has `memory=8192`, not measured). `to_gpu` moves it to CUDA.
- `follow` imports `track` inside the call, never at module level: `track` decides `DEVICE` at import, and the snapshot phase has no GPU (Lift).
- It reuses `track._pass` (Tracking memory), `_prompt`, `_mask`, `KEEP_BLOB` and `MIN_AREA`, so a change there changes the preview too.
- Grid: anchored on the proxy frame `floor(time × FPS)` that `segment` showed, so a mask prompt lands on its own frame. The rate is the highest of `RATES` (10, 6, 5) with `(end − start) × rate ≤ STEPS` (360): up to 36 s at 10 fps, up to 60 s at 6 fps.
  - The rates divide 30, so every sample is a real proxy frame.
  - 10 Hz, interpolated linearly in the Mini App, reads as smooth motion.
  - SAM 2's training data (SA-V) is annotated at 6 fps, so its memory copes with that spacing (reasoned from the paper, not measured).
- Frames: `media.decode` at the sample rate into a memmap over a `TemporaryFile`. That needs up to about 560 MB of temp disk and keeps RAM bounded. A `TemporaryDirectory` failed on Windows with the memmap still open.
- Boxes come straight from the 256² low-res logits, about 1/256 of the frame (3.75 px on the 960 side). Components below `KEEP_BLOB` are dropped, as in Tracking circle.
- Concurrency: `Lift` has `@modal.concurrent(max_inputs=3)`, so sync inputs run in a thread pool (Modal's `_container_entrypoint.py`, `DaemonizedThreadPool`, read by the backend agent).
  - `segment` and `look` share the `quick` lock: they run one at a time as before, and the Segmenter's LRU is not thread-safe. `follow` takes `slow`, so a tap never queues behind a 40 s follow.
  - The GPU is shared, so a tap during a follow is somewhat slower (reasoned).
  - Each follow bumps `latest`. An older follow sees the change within one step and returns `None`, so re-selecting never stacks calls. Do not drop this generation check: without it, three quick re-selections queue about 2 minutes of GPU.
- Cost (reasoned from the spike's 9.5 steps/s on L4, bf16): n + 1 steps per pass, so a 10 s range is about 11 s and the worst case (361 steps) is about 38 s, plus 1–3 s of decode. On L4 that is roughly $0.01 per call (price from memory). `timeout=120` covers it.
- The same request also spawns `Render.prepare` with its span before the follow is awaited, so the render's full 30 fps track starts with the preview (Track cache). The preview itself stays on `Lift` at 6–10 Hz.
- Not cached on the Volume: the result is about 15 KB and cheap to redo, and a cache key would have to hash the mask. The Mini App keeps the last path and asks again only for a new selection or a wider trim.
- Rejected:
  - The image model per sample with the previous box as prompt: about 13 fps, no memory, drifts to look-alikes.
  - SAM 2.1 tiny: about 2.3× faster on paper, but the preview would disagree with the render.
  - A separate GPU class: a second cold start and double the idle cost.
- Checked: `follow.follow` end to end on the CPU (tiny model, fp32, the mock proxy, 2 s range: 21 boxes for a point and for a box prompt, `None` where the object is gone, `stop()` → `None`; the mask-prompt path not exercised). The route through FastAPI's `TestClient` with a stub GPU call: 200 with `(job, time, prompt, start, end, (w, h))`, 422 without `time`, past the duration, and with `time` outside the range, 502 with the log line. Not verified: anything on Modal (snapshot memory, the thread pool with the GPU, latency).

## Lift

Tap-to-lift: the owner taps the object and sees its outline lifted from the frame (iOS "lift subject" look), cycles through SAM's candidates, and the chosen outline becomes the tracking prompt. Owner decision 2026-10-26: about $8 a month of the Starter credits is fine if it looks good; approved after a demo on the iPhone.

- `Lift` (`app.py`): a Modal class on `LIFT_GPUS` (L4 first, Render gpus), `max_containers=1`, `scaledown_window=LIFT_IDLE` (120 s), `enable_memory_snapshot=True`. `load` (snapshot phase, no GPU) builds `segment.Segmenter` on the CPU, `to_gpu` moves it to CUDA after every restore. `warm()` does nothing: calling it starts the container. `segment` reloads the data Volume when the proxy is not visible yet. Since 2026-10-27 it also holds the follow tracker and runs up to 3 inputs at once (`@modal.concurrent`, two locks: Track preview).
- `POST /api/jobs/{id}/warm` → 202: spawns `Lift.warm`. The Mini App calls it when the editor opens, so the cold start overlaps with choosing the frame. `bot.video` also spawns it as soon as a video up to `WARM_FILE` arrives (Warm start).
- `POST /api/jobs/{id}/segment` with a `Prompt` body (`time`, `points`, `box`; `mask` ignored) → `{candidates: [{mask, area}], best}`. 409 until the proxy exists, 502 with a readable detail when the GPU call fails (the Mini App then keeps the plain point).
- `segment.Segmenter`: SAM 2.1 large image model (`Sam2Model`, the same checkpoint as the tracker, `SAM_MODEL`), bf16. The frame is the proxy frame `floor(time × FPS)`, the one the `<video>` shows at that time; the image embedding is cached per (job, frame), `EMBEDDINGS` (8) frames LRU, so more taps on the same frame run only the prompt decoder. One point without a box asks for 3 candidates (`multimask_output`); two points or a box give one. Candidates are cleaned (Lift mask), sorted by area (part → whole → surroundings), near-duplicates dropped (IoU ≥ `SAME` 0.9). `best` is the middle one: SAM's own `iou_scores` did not match what looked right (the clean whole sheet scored 0.06, a part of the face 0.51), the middle candidate was the whole object in 2 of 3 spike taps.
- `POST /api/jobs/{id}/look` → `Lift.look` (Look preview). `api.lift` is the one helper both endpoints call: the 409 (no proxy yet, or `time` past the duration), the GPU call with the proxy size as the last argument, the log line `<call> <job> failed: …` and the 502 with the endpoint's own detail.
- `track.py` must not be imported here: it decides `DEVICE` at import, and the snapshot phase has no GPU. `render` (imported by `load` for the preview) does not import it; checked with `sys.modules` after `import rounds.render`.

Measured in the spike (2026-10-26, ephemeral `modal run` of a copy of this setup, L4, proxies of IMG_0402 / IMG_0406): cold start 21.7 s without a snapshot (6.1 s scheduling and boot, 12.3 s imports, 2.2 s weights to CPU, 0.5 s to GPU); image encoder 1.07 s on the first frame (cold kernels), 0.07 s after; prompt decoder 0.008 s; a warm call from the owner's PC 0.59 s round trip. So a warm tap is network-bound, about 0.5–0.8 s (reasoned). The snapshot should cut the imports; it is only taken for deployed apps, so it is not measured yet (`render.wait`-style numbers: read the first `Lift` start in the Modal log). Cost of the spike: about $0.02.

Rejected: SAM in the browser (20–45 MB download, no WebGPU in iOS 18 WKWebView, single-thread WASM); precomputed embeddings at ingest (about 8.4 MB per frame, so only a few keyframes); the encoder on the `web` CPU container (seconds per frame).

## Lift mask

`segment.clean` turns 256² logits into the outline the Mini App shows and the tracker gets: bilinear upsample to half the proxy size, threshold 0, a 3×3 opening (SAM leaves speckles along the edge), connected components below `KEEP_BLOB` (0.2) of the largest dropped (as Tracking circle), holes filled, then `EDGE` (4) px cleared along the frame border. `png` feathers it (Gaussian `FEATHER` 1.2 px) into the alpha of a white RGBA PNG.

- The border inset is for the look: where the object runs off the frame, the outline would coincide with the frame edge and WebKit clips the glow there (seen on the owner's iPhone); 4 px in from the edge the rim is drawn inside the picture. The tracker loses those 4 px (1.5 % of the short side), which does not move the circle noticeably.
- Raw masks were 4–105 KB with visible speckles; cleaned 2–5 KB (measured on the spike masks), well under `MASK_CHARS`.
- `track._mask` decodes the PNG alpha, resizes it to 1024² (antialiased, ≥ 0.5, as `processing_sam2_video.add_inputs_to_inference_session` does) and `_pass` adds it with `add_mask_inputs` instead of the points. A PNG that does not decode or is empty falls back to the points.
- Spike, mask prompt vs point prompt on 90 frames of IMG_0402 (the drawing): both present on 90 of 90, per-frame IoU between the two runs 0.94–0.998, same speed. The mask is there so the tracker follows the candidate the owner picked, not SAM's own pick.

## Tracker swap

`SAM_MODEL` (`config.py`, shared with `segment.py`) and `load()` are the seam. SAM 2.1 sizes: `facebook/sam2.1-hiera-{tiny,small,base-plus,large}`. SAM 3 tracker (`Sam3TrackerVideoModel` in `transformers.models.sam3_tracker_video`) has the same session/forward API family: swapping means changing the imports, `SAM_MODEL` (gated: `HF_TOKEN`; `segment.py` then needs the SAM 3 image model too), and checking that its config still has `image_size` and `max_object_pointers_in_encoder`, the session constructor arguments and the output fields `pred_masks` / `object_score_logits`. DAM4SAM is a different code base: it would replace `_pass` and keep `_measure` and `track`.

## Warm start

Cold starts cost the owner most of the waiting that is not the GPU work itself, so they are hidden or shortened where it is free.

- Memory snapshots: `web`, `ingest` and `Render` have `enable_memory_snapshot=True` (as `Lift`). A plain function snapshots what its module imports at global scope, so `app.py` imports `api` at the top (it was inside `web`), and the block under `gpu_image.imports()` imports `SNAPSHOT_IMPORTS` (`render`, `upscale`, the SAM 2.1 video model of transformers) only in GPU containers; in the CPU image the first one fails with `ImportError`, which `Image.imports` swallows (read in the Modal 1.6.2 source). The loop is empty under `modal.is_local()`: locally torch is installed too, and importing `render` there added 25 s to every `modal deploy` / `serve` / `run` (measured).
- `track` must stay out of `SNAPSHOT_IMPORTS`: it decides `DEVICE` at import, and the snapshot phase has no GPU (as Lift). Nothing else in the import tree touches CUDA at import (grep for `cuda` at module level).
- Snapshots exist only for deployed apps, Modal takes several during the first invocations after a deploy (about 6 for a CPU function, 2–3 per GPU type, Modal docs, Memory Snapshot), so the first runs after a deploy are not faster. State made at import is frozen: nothing random is created at import (`bot` uses `secrets` at call time, `os.urandom`).
- Early GPU warm-up: `bot.video` spawns `Lift.warm` right after `ingest` when the file is at most `WARM_FILE` (100 MB, reasoned: download, proxy and opening the Mini App fit into `LIFT_IDLE`); a bigger or unsized file waits for the editor's own warm-up, so a long download does not keep an idle L4 running.
- Measured before the snapshots (2026-10-27, `fn.remote('cold-probe')` from the owner's PC, the call fails at once on the missing job): `ingest` cold 14.4 s, warm 0.9 s. From the stage logs (2026-10-26): `ingest.wait` 11–42 s, `render.wait` 23–30 s cold (83–325 s when it queued behind another render, `max_containers=1`). 2026-10-27: `render.wait` 1720 s with `waiting to be scheduled on a GPU_L4 worker` in the log (Render gpus).
- Kept cold on purpose (owner 2026-10-27): `web` and `ingest` scale to zero. Kept warm all month (`min_containers=1`), `web` costs about $6 and `ingest` with its `cpu=4`, 4 GB request about $160 before the EU region surcharge, or $5–9 with a 0.125-core request (reasoned from the Modal price list: billing is the larger of the request and the use, idle time included), for about 35 s saved per video. A note costs about $0.40–0.55 of the $30 Starter credits (2–5 min in the editor, render, `RENDER_IDLE`), so warm containers would take 12–40 notes a month.

## Render gpus

`app.RENDER_GPUS` = L40S, A100-40GB, L4, H100 and `app.LIFT_GPUS` = L4, L40S, A100-40GB: Modal GPU fallback lists, tried in order (Modal docs, GPU guide). Owner's speed plan 2026-10-27.

- Why a list: L4 capacity runs out. 2026-10-27 `render.wait` was 1720 s with `waiting to be scheduled on a GPU_L4 worker` in the log, `Lift` waited too, and a benchmark container on L4 waited over 20 min while L40S, A100 and H100 started at once.
- Measured (2026-10-27, scratch app with this `gpu_image`, `cpu=8`, 32 GB; job `FU92F7nT5Q`, 4K60 HEVC, 13.8 s, AV1; job `qbtO81fF8Z`, 1080p30 with RIFE, 304 synthesized frames):

| GPU | $/s (GPU) | SAM track fps | render 4K60 (frame loop + 2 passes) | render with RIFE |
|---|---|---|---|---|
| L4 (production log) | 0.000222 | 8.5 | 41.7 s | 22.8 s (HEVC) |
| L40S | 0.000542 | 19.6–22.7 | 16.2 s (loop 77 fps) | 11.4 s |
| A100-40GB | 0.000583 | 20.3–21.9 | 14.6 s | 11.0 s |
| H100 | 0.001097 | 19.0–28.6 | 10.6 s (loop 112 fps) | 7.7 s |

- SAM tracking stops scaling at L40S (one frame at a time, launch-bound): H100 tracks no faster. The container's 8 CPUs and 32 GB cost $0.000176/s whatever the GPU, so a job on L40S costs less than on L4 (4K60 render: about $0.012 vs $0.017; track 21 s vs 48.5 s: about $0.015 vs $0.019, Modal price list). Hence L40S first for `Render`; H100 is last, only so a render never waits.
- `Lift` keeps L4 first: its taps are network-bound (Lift) and it idles warm for `LIFT_IDLE` after every editor session, where the cheapest GPU matters most.
- Not verified: how long Modal tries a type before it falls back, and the render speed on L4 of the same build (taken from production logs of the same jobs, other code version). Each GPU type takes its own memory snapshots (Warm start), so the first runs on a new type start cold.
- `render.load` prints `gpu=` so the type a job got is in the log.

## Render warm

The render is the `Render` class, not a function, so the GPU container the note is made in is the one warmed while the owner edits (2026-10-27, owner's speed plan).

- `POST /warm` (the editor opened) spawns `Render.warm` next to `Lift.warm`; `POST /track` (a selection) spawns `Render.prepare` (Track cache). `Render.run` is the render (`POST /render`). `bot.video` warms only `Lift`: a render container idling through a long download would be paid for nothing.
- `RENDER_IDLE` (240 s) keeps the container after its last input. The owner spent about 3 min in the editor in the 2026-10-27 log; each warm-up that no render follows costs up to `RENDER_IDLE` of the container (about $0.10 on L4 with 8 CPUs and 32 GB, by the Modal price list).
- `@modal.concurrent(max_inputs=2, target_inputs=1)`: a prepare and a run share one container (the run waits for the prepare's track instead of tracking again), while the autoscaler still gives a second run its own container up to `RENDERS` (2). Two runs that do end up in one container (bursting at `max_containers`) take turns on `self.running`: two renders on one GPU could run out of VRAM with upscale, and their encoders would fight for the 8 CPUs.
- Async methods in a concurrent class share one event loop; all heavy work in `render_job` and `locate` goes through `asyncio.to_thread`, so a prepare and a run interleave.
- `render_job` and `prepare_job` reload the data Volume inside `contextlib.suppress(RuntimeError)`: with two inputs in one container, the other one may hold the source open, and `reload` then raises `there are open files preventing the operation` (seen in `web`, Signed urls). The file is visible already in that case.

## Track cache

`locate.located` + `locate.prepare_job`: the track of the selected object is computed while the owner is still in the editor and reused by every render of that selection (owner's speed plan 2026-10-27; before, every render, even a codec-only re-render, decoded and tracked again: 50 s for 14 s and about 3.5 min for 60 s of 4K on L4).

- Key: `track:<job>:<sha256 of the prompt JSON, sorted keys>` in the `rounds-state` Dict. The prompt is `time`, `points`, `box`, `mask`, exactly as the Mini App sends it to both `/track` and `/render` (`viewer/follow.js`, `editor.jsx`); pydantic tuples and stored lists dump to the same JSON. Value: `{start, n, found (source pixels), d (media.changes)}` on the grid `start + k / FPS`, about 90 KB for 60 s.
- The range is not in the key: the Mini App does not ask `/track` again when the trim narrows (`follow.js`, `covered`), so the render slices the cached range. `sliced` takes frames `j … j + N` with `j = round((start − cached start) · FPS)` and recomputes the cuts from the sliced `d` (`d[0] = 0`), which equals a fresh run on those same frames (`changes` only compares neighbours; the cut rule's window then sees exactly the frames a fresh run would). A range not covered is computed afresh and replaces the entry.
- The slice's frames sit up to half a tracking frame (1/60 s) off the requested range's own grid. The path is then that much early or late; the tracking timeline already quantizes a 60 fps source to 30 fps, so this is the same order (reasoned, not measured).
- One computation per key: `transfer.held` (Dict lease) around the compute. A run that finds a prepare of its key running waits for its lease and then reads the cache. The run shows "Following the object… 0%" meanwhile: the prepare's progress is not relayed.
- Cancel: every `located` writes `latest:<job>` = its key. A prepare (`cancellable=True`) watches it every `WATCH` (3) s and raises `Superseded` from the tracker's progress callback (every 30 frames) once a newer selection or a run of another selection took over. A run is never cancelled.
- A prepare that fails is logged and swallowed; the run then tracks itself and fails with the readable error if the source is broken.
- Not verified on Modal yet: the whole flow end to end. Checked locally (2026-10-27, scratch test with a fake Dict): slice and cuts, the waiter served from the cache without a second compute, a superseded prepare releasing its lease, a run not superseded, the `rounds.app` import graph.

## Stuck jobs

`retry.start` + `retry.watch`, the scheduled function `watch` in `app.py`: an ingest or a render whose Modal call died outside our `try` (a redeploy dropping the input, a container killed, OOM, the 3600 s timeout) is started again, and the user sees "The server stopped, starting again (attempt n of 3)…" in the status message (owner 2026-10-27: retry and tell, never just lose the job). Before this, job DstPz_viAe stayed in `rendering/queued` for good after a redeploy: `POST /render` refuses a busy job, so even a manual retry was impossible.

- `web` spawns `ingest` and `Render.run` only through `start` (`app.starter`), which stores `call:<job>` = `{id, kind, attempt}` in `rounds-state`. `watch` runs every `WATCH_MINUTES` (2) and checks only these entries, never the whole `rounds-jobs` Dict (requests carry masks up to 90 KB).
- Alive: `FunctionCall.get(timeout=0)` raising the built-in `TimeoutError` (no output yet; source: `modal/_functions.py`, `poll_function`). Any other exception (cancelled, timed out, crashed, `OutputExpiredError`, which is a Modal `TimeoutError`, not the built-in one) or a normal return means the call is over.
- An alive call is still stuck when the job sat at stage `queued` longer than `QUEUE_LIMIT` (900 s): the body never started (no GPU, an orphaned input of an old version). It is cancelled first, so two renders never send two notes.
- Over: the job is read again; if it is no longer `ingesting` / `rendering` (it finished or failed through `fail`), the entry is dropped. Otherwise it is retried with `queued_at` reset (and `stage: queued` for a render) up to `ATTEMPTS` (3), then failed with the readable `Interrupted` reason and the editor button.
- Cost (reasoned from the Modal price list): one CPU container every 2 min for a few seconds, `scaledown_window=2`, well under $1 a month; one of the 5 Starter crons.
- Jobs from before this change have no `call:` entry and are not watched.
- Checked locally (2026-10-27, scratch test with fake Dicts and calls): a finished call dropped, a dead one retried, a running one left, a stale queued one cancelled and retried, the last attempt failed with the message. Not verified on Modal yet.

## Bot session

`bot.session`: closes the aiohttp session of the cached `get_bot()` when a container is done with it. Without it every `web`, `ingest` and `Render` container logged `Unclosed client session` about a minute after its last input, when it shut down (2026-10-27, `modal app logs --show-function-id --show-container-id`: the warning came from those three functions only; an earlier guess blamed Modal internals because the merged log put it in the middle of a render).

- `web`: FastAPI `lifespan=bot.session`; Modal runs the ASGI lifespan shutdown when the container stops (`modal/_runtime/user_code_imports.py`). Not per request: `web` serves 20 inputs at once on one session.
- `ingest`, `watch`, `setup`: around the call. `Render.run`: inside `self.running`, so no other run is using the session when it closes; `prepare` and `warm` never touch the bot. The next call opens a new session (aiogram's `create_session` recreates a closed one), one TLS handshake per job.
- aiogram's `close` sleeps 250 ms for the SSL shutdown; it runs after the note or the status is sent, so the user does not wait for it.

## Dict lease

`transfer.held(state, name)`: an exclusive lease `lease:<name>` in the `rounds-state` Dict, for work that must not run twice at once across containers (an MTProto session, Mtproto sessions; a track computation, Track cache). `put(skip_if_exists=True)` is the atomic claim, the holder refreshes it every `LEASE / 4` s, a lease older than `LEASE` (60 s) is a container killed while holding it and is taken over; waiters poll every `WAIT` (1) s. Known gap: two waiters that both see the same stale lease can both take it (only after a hard kill, accepted). It lives in `transfer` because `locate` imports `transfer` and `pipeline`, and `pipeline` imports `transfer`: anywhere else would be an import cycle.

## Stage timings

Every step of a job prints one line to the Modal log: `[<job id>] <function>.<step> <seconds>s key=value …`, read with `uv run modal app logs rounds --timestamps` (grep the job id). `pipeline.timed` wraps a step and prints when it ends; a tuple fact `(amount, unit)` is printed as a rate, `amount / seconds` (`speed=(mb, 'MB/s')`, `fps=(frames, '')`, `speed=(duration, 'x')` = times realtime). A step that raises prints nothing (`fail` prints the traceback).

- `ingest.wait`, `render.wait`: from `queued_at` (the webhook or `POST /render`) to the function body. Covers Modal scheduling and the container cold start (image, imports). Jobs created before the field existed print 0.
- `ingest.download` (`mb`, `speed`): the MTProto download alone, without the login. `ingest.probe` (the source: size, fps, gaps, codec, transfer, bit depth, duration, audio, `tags` = number of kept tags), `ingest.proxy` (`speed` in × realtime of the whole source, `dupes`, `has_audio` after the proxy, `interpolable`), `ingest.commit`, `ingest` (the whole function).
- `render.load`: the SAM weights to the GPU; near 0 in a warm container (`@cache`), so it tells a cold start from a warm one. `render.locate` (`cached=True` when the track came from the cache, a prepare included, `cuts`), around `render.decode` (`frames`, `size` of the tracking frames, `fps`), `render.track` (`fps`), `render.cuts` (the histogram changes) when the render tracks itself; `render.camera`, `render.encode` (`fps` of the frame loop plus both passes, `mb` of the note, `codec`, `fit` (below 1 when the fit loop had to retry), `rate` of the note, `upscale`, and with interpolation `synth` = RIFE frames, `dupes` = dropped source frames, `seams` = holes covered by a seam), `render.commit`, `render.send` (Bot API `sendVideoNote`, `speed`), `render` (the whole function, with `clip` length and the source facts).
- `prepare` (`cached`), `prepare.decode`, `prepare.track`, `prepare.cuts` (the same facts as the render's), `prepare.superseded` (a newer selection stopped it), and `prepare failed: …` (swallowed: the render then tracks itself).
- `render.load` also prints `gpu=` (the CUDA device name), so the GPU fallback list (Render gpus) can be read from the log.

Keep it to one line per step and only numbers that point to a lever (bandwidth, fps, cold or warm); progress percentages stay in the chat, not in the log.

## Mtproto sessions

`transfer.client(state, name)` logs in with the bot token over MTProto (Telethon, `receive_updates=False`: updates still come through the Bot API webhook) and keeps the session string in the `rounds-state` Dict under `session:<name>`. One session per name (only `ingest` since the note goes through the Bot API, Note send): the same auth key used from two places at once risks `AUTH_KEY_DUPLICATED` (Telegram then kills the key), and a fresh login per job risks `FLOOD_WAIT` on `auth.importBotAuthorization`. `client` holds the lease `lease:<name>` (Dict lease) for as long as the session is open, so a function with more than one container (it was made for `render`, `RENDERS` 2) never shares the key. `ingest` has `max_containers=1`, so today the lease only guards against a killed container. Messages are fetched with `get_messages(None, ids=...)`, which calls `messages.getMessages` without a peer (private chats need no access hash).

## Mtproto lanes

`transfer.download` moves the source in `PART` (512 KB, the MTProto maximum) pieces over `LANES` (4) concurrent requests on the one connection, in contiguous ranges through `iter_download(offset, limit, request_size)`, each lane writing at its offset. The note upload had the same lanes (`upload.saveFilePart` / `saveBigFilePart`) until it moved to the Bot API (Note send); the upload columns below are kept as the record. Telethon's own `download_media` / `upload_file` send one request at a time with 128 KB parts up to 100 MB and 256 KB up to 750 MB (`utils.get_appropriated_part_size`), so every part waits a full round trip; Modal's default region was `us-west` / `us-east`, 130 ms from Telegram's Amsterdam DC 2 (where the bot and the owner's files live), 5 ms from `eu-west`.

Measured 2026-10-27 (probe on Modal, a 256 MB source, a 9.9 MB upload), MB/s:

| | download, 1 lane | download, 4 lanes | download, 4–8 connections | upload, Telethon | upload, 4 lanes |
|---|---|---|---|---|---|
| `us-east` | 3.0 | 5.6 | — | 3.5 | 7.3 |
| `eu-west` | 5.2 | 5.0 | 4.9–5.3 | 9.6 | 27.2 |
| `uk` (real `transfer`) | 5.5 | 5.0, same SHA-256 | — | — | 10.7 (9.5 MB), 27.4 (30 MB, big parts) |

Unpinned containers land in any region (seen: `us-west`, `us-east`, `eu-west`, `uk`, and `af` on Azure for a probe on 2026-10-27), and production downloads of large files ran at 1.5–1.8 MB/s against about 5 MB/s in `eu-west`. So `ingest` is pinned to `region='eu'` (Mtproto keys); it costs 1.15× on what that CPU function spends (Modal docs, Region selection; about $0.002 per job), and works on the Starter plan (checked 2026-10-27). `ingest.download` logs `region=` (`MODAL_REGION`, set by Modal in every container).

In production before the lanes: downloads 1.2–5.2 MB/s, uploads 0.4–1 MB/s (8–17 s per note). Downloads stop at about 5 MB/s whatever the region, the lanes or the number of connections with the same auth key: that is Telegram's limit per auth key, not the network. It is worked around with more keys (Mtproto keys). More than 4 lanes made uploads slower (8 lanes: 2.2 MB/s from `us-east`).

## Mtproto keys

`transfer.clients(state, 'ingest')` opens `KEYS` (3) sessions, `ingest`, `ingest1`, `ingest2`: separate bot logins, so separate auth keys, each with its own lease (Dict lease). `transfer.download` splits the file into `LANES × KEYS` contiguous ranges and deals them round robin, every session fetching the message itself (its own `file_reference`).

Measured 2026-10-27 (scratch probe, `region='eu'` → `eu-west`, the 146 MB source of `FU92F7nT5Q`), MB/s: 1 key 5.1 (and 4.9, 5.1), 2 keys 10.5, 3 keys 18.5 and 14.8, 4 keys 16.3, 6 keys 18.1. The speed grows with keys up to 3 and stops near 15–18 MB/s (the container's network or the 4 CPUs, not checked). A 450 MB minute of iPhone 4K60 then downloads in about half a minute instead of 4–5 min at the 1.7 MB/s seen in production.

- The first ingest after the deploy logs in `ingest1` and `ingest2` once (`auth.importBotAuthorization`); the sessions are kept in the Dict as `session:ingest1` / `session:ingest2`, like `session:ingest`.
- Do not raise `KEYS` without measuring: 4 and 6 keys were not faster, and every key is one more bot authorization.
- The probe also created `session:probe2` … `session:probe6` in `rounds-state`; nothing uses them.

## Init data

The Mini App sends `Authorization: tma <initData>`. Validation follows core.telegram.org/bots/webapps: secret key = HMAC-SHA256(key `WebAppData`, message = bot token); the hash is HMAC-SHA256 over the sorted `key=value` lines except `hash`. `auth_date` older than 24 h is refused, and the user must be in `ALLOWED_USER_IDS` and own the job. Lives in `auth.py` (`from_init_data`).

## Auth header

`auth.user_of` reads every API call's `Authorization`: `web <session>` is a browser session (Web session), anything else is Mini App `initData` (`tma <initData>`, Init data). Both end in the same user id, checked against `ALLOWED_USER_IDS` on every call, and `own_job` then requires the job to be that user's. So a job sent to the bot opens in the browser too, and removing an id from `ALLOWED_USER_IDS` locks both doors at once.

## Web session

The browser version keeps `<user id>.<expiry>.<hex HMAC-SHA256>` from `POST /api/auth` and sends it as `Authorization: web …`. The key is derived from the bot token (label `Session`, like `Files` for signed URLs), so there is no session store and no new secret; rotating the bot token signs everyone out. Lifetime `SESSION_TTL` = 30 days (chosen 2026-10-27: a personal tool, and the allow-list check on every call is the real revocation). Not a cookie: the API is on Modal and the page on GitHub Pages, two sites, so a cookie would be third-party and blocked by Safari.

## Telegram login

OpenID Connect, authorization code with PKCE (core.telegram.org/bots/telegram-login, read 2026-10-27), ported from w2w (`what-to-watch/functions/src/telegram.ts`, its README `telegram-auth`), where the same traps were found:

1. The page makes the PKCE verifier and `state` itself (kept in its `sessionStorage`) and navigates to `GET /api/auth/start?redirect&challenge&state`, which answers 302 to `oauth.telegram.org/auth` with `client_id` = the bot id (the part of the bot token before `:`; the docs: the client id is the bot id) and `scope=openid profile telegram:bot_access`. The endpoint only exists so the page needs no build-time bot id; it refuses a `redirect` outside the Mini App origin (`MINIAPP_URL`), so it is no open redirector.
2. Telegram returns to the page with `?code&state`; the page checks `state` and posts `{code, verifier, redirect}` to `POST /api/auth`.
3. `auth.exchange` posts to `oauth.telegram.org/token` (form body, `client_id` in the body and HTTP Basic `bot id : TELEGRAM_CLIENT_SECRET`, as the docs list both). **A token error comes back as HTTP 200** with `{"error": …}` (w2w, observed 2026-10-10), so the answer is checked for `id_token`, not for the status; the log line omits `access_token`. Stdlib `urllib` in a thread: no HTTP client in the project's own dependencies.
4. The profile is the id token (no userinfo endpoint). The user is the `id` claim (the `profile` scope), not `sub`: only `id` equals the Mini App's `user.id`. Not signature-checked, by design: it comes straight from the token endpoint over TLS in a request authenticated with the client secret (OpenID Connect Core 1.0, 3.1.3.7 (6)); `iss`, `aud` (the bot id) and `exp` are checked. A token handed in by a client must never take this path.

- `telegram:bot_access` is the "Allows your bot to send direct messages to the user after login" scope (owner: ask for it at sign-in; no welcome message is sent). No claim says whether it was granted.
- BotFather: Bot Settings → Login Widget → Allowed URLs must list the page (`https://l1nway.github.io/rounds/`), and the signing algorithm must stay `RS256` (or `ES256`): `EdDSA` / `ES256K` allow only `openid` and the `id` claim disappears.
- A user outside `ALLOWED_USER_IDS` signs in at Telegram and gets 403 "This bot is private" from `/api/auth`.
- No refresh and no revoke endpoint: the session is ours (Web session); the user removes the site from Telegram's active sessions themself.
- Not signed in against the real Telegram yet (2026-10-27).

## Signed urls

`<video src>` and `<img src>` cannot send headers, so `GET /api/jobs/:id` returns proxy and filmstrip URLs (null while the job has no `proxy`: ingesting, or a failed ingest, which the Mini App shows as "could not be prepared" with `error`) signed with HMAC (a key derived from the bot token, label `Files.pro` on Modal and `Files.free` on Oracle, so the router can tell them apart: `router/README.md`, Router files) and valid for 6 h. The URL starts with the `x-rounds-base` header the router sets (its own origin, since Modal answers only through the router), else the request's own base. The route lives in `files.py`. Starlette's `FileResponse` serves HTTP Range requests, which video seeking needs. A file missing in the web container triggers `volume.reload()`, retried up to `RELOADS` times (observed: the first request in a cold container got a 500, `RuntimeError: there are open files preventing the operation`, because a parallel `FileResponse` held a file open; the error is swallowed and the existence check decides) (the ingest container commits before marking the job ready).

## Ready notice

Editing a message never notifies (owner's observation: the editor became available without a push). So the two outcomes the owner waits for, `ready` and `failed`, go through `bot.announce`: a new reply to the source video with the `Open editor` button, then the progress message is deleted, so the chat still holds one message per phase; the job's `status_message_id` moves to the new message. Send first, delete second: a failed send must not leave the chat empty. Progress stays silent edits (`bot.status`); `done` is an edit too, the note itself is the notification. A late progress edit aimed at the deleted message fails with `TelegramBadRequest`, which `bot.status` swallows.

## Launch aspect

`bot.editor(job)` builds the `Open editor` URL as `?job=<id>&a=<width / height>` (display-oriented, rounded to 6 digits) once the job has `meta`; before the probe (a failed download) there is no `a`. The Mini App gives its placeholder that shape before `GET /api/jobs/:id` answers, so a vertical video opens in its final shape with no layout movement (owner decision 2026-10-26, `miniapp/src/services/README.md`, Launch aspect). The value is a layout hint only: the job's `meta` stays the truth, and buttons sent before the change (no `a`) fall back to 16:9.

## Chat action

Every stage has its own status text (`bot.TEXTS`), edited into one message per phase (ingest: reply to the video; render: a new reply made by the API at the moment of "Render", so the GPU cold start and the model load are not silent). A long step with no progress callback (probe, proxy, decoding, scene cuts, the camera solver) still gets a text of its own, because "silent" was the owner's complaint.

The chat header shows the matching action: `typing` during ingest, `record_video_note` from decoding to the end of the render, `upload_video_note` while the file is sent (Note send). A Bot API chat action lasts about 5 s and is dropped as soon as the bot sends a message, so `bot.acting` repeats it every `ACTION_EVERY` = 4 s until the block ends. Failures of `sendChatAction` are swallowed: it is decoration. The `queued` stage has no action: the GPU container is not up yet, so nothing runs the pulse.

Ideas for later modes (owner): "no subject" (a plain centre or a slow auto-crop with nothing to track, so the prompt becomes optional), and more audio and video options next to `loudnorm`. The seams are `Prompt` (its validator `check` accepts an empty selection, Square source; `render` allows it only for square sources today), `pipeline.render_job` (the tracking and camera stages are skippable: `camera.solve` only needs a found track) and `options`.

## Note send

`bot.send_note`: the finished note goes out through the cloud Bot API `sendVideoNote` (multipart upload, `length` 640, `duration` in whole seconds, as a reply to the source), not MTProto. The note is at most `encode.NOTE_BYTES` (10 MB, Note size), well under the Bot API's 50 MB upload limit, so the render needs no MTProto login and no session lease. Before (2026-10-26/27 logs) `render.send` took 8–34 s for about 9 MB, mostly login and lease; the 4-lane MTProto upload was faster on paper but never verified end to end.

- The Bot API, like TDLib, uploads the file untouched (Telegram limits); `length` over 640 is rejected.
- `duration` is an integer in the Bot API (MTProto took a float): 13.76 s is sent as 14. The clients play the file's own length; only the label can differ by under half a second.
- The file name is the source's with the extension swapped for `.mp4` (`IMG_4359.MOV` → `IMG_4359.mp4`, `round.mp4` if the source has no name): `job.name` is stored by `bot.video` from the Bot API message (`video.file_name` / `document.file_name`; a video note has none), and goes in as the multipart file name. Jobs from before the field get `round.mp4`. Telegram clients do not show it on a round, it surfaces when the note is saved.
- `send_video_note` passes `request_timeout=UPLOAD_TIMEOUT` (600 s): aiogram's default is 60 s, and a 9 MB upload from Modal exceeded it (`TelegramNetworkError: Request timeout error`, job TOyGyWV2yD, 2026-10-28) after a 15 min render, so the finished round was lost.
- Not verified yet (owner's phone): that a note sent this way arrives as a round on iOS and Desktop, as the MTProto one did.

## Restricted notes

A Telegram Premium user can restrict who sends them voice and video messages, and then `sendVideoNote` fails. `bot.deliver` treats a failure as that restriction when the error text has `VOICE_MESSAGES_FORBIDDEN` (MTProto `messages.sendMedia`, 400: "This user's privacy settings forbid you from sending voice messages"; the Bot API lists no such error, so the exact Bot API text is not verified) or when `getChat` then reports `has_restricted_voice_and_video_messages` (Bot API, ChatFullInfo: "the privacy settings of the other party restrict sending voice and video note messages"). Any other failure still fails the job.

- Then the job is `done` with `held = {at, duration}` (the note stays at `jobs/<id>/note.mp4`), and `bot.finish` announces (a new message, so it notifies: Ready notice) how to allow the bot plus a `Resend` button (`resend:<job id>`). A delivered note sets `held` to `None` and edits `done` as before.
- `Resend` (a callback query, so `setup` subscribes to `callback_query` as well as `message`: `bot.UPDATES`; rerun `setup` after the deploy that adds it, or Telegram keeps the old list) runs in `web`: owner check, `HOLD` = 10 minutes from `held.at`, `volume.reload()`, the same `deliver`. Still restricted: an alert (≤ 200 characters) and the button stays. Delivered: the message becomes `done` with the editor button. Expired, or a newer render cleared `held` (`POST /render` resets it): an alert "no longer kept".
- `HOLD` (owner asked for about five minutes, "safe and economical", 2026-10-27): 10 minutes, since the path to the exception (Settings → Privacy and Security → Voice Messages → exceptions) takes a while on first use, and the window costs nothing: notes are never deleted from the Volume, the retry is one Bot API upload from the warm `web`, no GPU.
- Not verified against a real restricted account yet.

## Telegram limits

Verified in sources (2026-10-25): TDLib rejects a video note `length` over 640 (`td/telegram/MessageContent.cpp`, "Wrong video note length"); the Bot API and TDLib upload the file untouched, the circle size comes from `length` only; the server-recommended `round_video_encoding` is 384 px / 1000 kbps / `max_size` 12 MiB (help.getAppConfig), recommended, not enforced by any client; clients record 384–480 px at 30 fps; expanded on a phone the circle covers about 1000–1340 device pixels, so 640 is visibly better than 480. Bots may use MTProto `upload.getFile` / `upload.saveBigFilePart` (2000 MB).

## Telegram experiment

Done (2026-10-26, owner's test): 720 and 1080 notes arrive as regular videos, not rounds, even under the 10 MB cap (High resolution); the note keeps its metadata (Note metadata).

Done (2026-10-26): a 640² note of 13.2 MB arrives as a regular video (Note size). Owner (2026-10-26): a 640 HEVC note works, so HEVC became the default (Codecs). Done (2026-10-26): AV1 and VP9 notes of 12.8 s that filled the 12 000 000 B budget arrived as regular videos (they played on iOS 18); an H.266 note was not sent as a round and played neither on iOS nor on Desktop. The budget went back to 10 000 000 B (Note size), and AV1 and VP9 notes under it stayed rounds and played on iOS (owner, 2026-10-26); H.266 was dropped (Codecs). An upscaled note looked right on the phone (owner's IMG_4042). Open: AV1 and VP9 notes on Desktop and Android; the exact size threshold (between 10 and about 11.6 MB), a note longer than 60 s; each checked on iOS, Android and Desktop, and the downloaded file hashed against the uploaded one (server re-encoding).

## Tiers

Owner (2026-10-27): the bot is public. Users in `ALLOWED_USER_IDS` get the full version on Modal; everyone else the free tier on an Oracle VM (`free.py`, `deploy/README.md`), with no Modal spend. The router (`router/README.md`) picks the backend from the verified caller.

- Modal stays private by two locks: `requires_proxy_auth=True` on `web` (only the router holds the proxy token) and `auth.allowed` / the bot's `private` handler on every call. `setup` points the webhook at `ROUTER_URL`, never at Modal: Telegram cannot send the proxy token.
- The open mode is a code flag, `config.PUBLIC`, set only by `free.py` at import; Modal never imports `free.py`. Not an env variable on purpose: the root `.env` is pushed to the Modal secret, so a variable put there for Oracle would open Modal too. `config.admits` reads it at call time.
- `create(..., tier)`: `free` has no `segment`, `look`, `follow`, `prepare` calls, so those routes answer 403 `PRO_ONLY` (`pro()`); `render` refuses `PRO_OPTIONS`, non-zero `PRO_LEVELS` and `deblur` above `FREE_DEBLUR` (403, Deblur) and accepts a job without a selection (centre crop). `GET /api/jobs/:id` returns `tier`, which the Mini App uses to lock PRO rows (`miniapp/src/features/editor/README.md`, Tiers). A new option that needs the GPU goes into `PRO_OPTIONS` / `PRO_LEVELS` and gets `pro: true` in `draft.js`.
- Free for now: crop (centre, or centred on the selection), zoom by the selected box, loudness, noise reduction (DeepFilterNet3 on the CPU, owner), metadata, the codec. PRO: tap-to-lift, tracking, track preview, HDR and exposure (both run in torch, `look.py`; a numpy port of the honest part would free them), 60 fps, upscale, stabilization.
- Later, owner (2026-10-27): a free CPU tracker. Candidates: OpenCV CSRT or KCF, YOLO11-nano / YOLOv8-nano + ByteTrack, MobileSAM / NanoSAM (ONNX), MediaPipe face / pose detection, motion centroid / optical flow.

## Free server

`free.py` builds the same FastAPI app as Modal's `web` (`create(jobs, disk, spawn, tier='free')`) and runs it under uvicorn (`deploy/README.md`). `spawn` maps `ingest` and `render` to asyncio tasks behind semaphores (`INGESTS` 2, `RENDERS` 1: an FFmpeg encode already takes all 4 cores) and `warm` to a no-op, since `bot.video` always calls it. Ingest is `pipeline.ingest_job` unchanged (MTProto from this host). A restart loses running tasks, so the lifespan first fails every job still `ingesting` / `rendering` with "The server restarted" (`pipeline.fail` tells the user), then starts the sweep. There is no stuck-job watch here: tasks run in-process, so a job either finishes or dies with the process.

## Free store

`store.Store` gives SQLite the `modal.Dict` surface the shared code uses: `get`, `put` (with `skip_if_exists`, the lease of `transfer.held`), `pop` (KeyError without a default, as Modal) and `items`, each as `.aio`. Values are JSON, so a job must stay JSON-shaped (it already is: Modal pickles, but nothing stores non-JSON). `Disk` is the Volume stand-in: `commit` and `reload` are no-ops on one local disk. One file, `/data/rounds.db`, WAL mode; the calls are synchronous inside async functions, which is fine at this size (microseconds per call).

## Free sweep

Sources are up to 2 GB and the VM's disk is 200 GB, so every hour `sweep` drops jobs whose `queued_at` is older than 48 h (`KEEP`) and are not active, with their folders. The editor link of an older job then says the job is not found.

## Free frame

Without tracking the note is one fixed square for the whole range (`crop.frame`): centred on the box, else on the mean of the positive points, else on the frame centre, then clamped inside the frame. Side: the short side of the source; with zoom and a box, the box's long side × `ZOOM_MARGIN` (1.6), never under `ZOOM_FLOOR` (a quarter) of the short side. Points carry no size, so zoom needs a box.

## Free render

`crop.render`: one FFmpeg decode with `crop` + `media.sdr_chain` (the proxy's tone map for HDR sources) to 640² yuv420p at the source rate (`source.out_rate` without interpolation), piped into the same two-pass encoder as the GPU render (`encode.first_pass` / `second_pass`: the size fit, the audio chain with loudness and DeepFilterNet3, metadata). The frame loop copies each buffer (`tobytes`), because `media.reader` reuses its buffers as soon as the loop moves on. The loop mirrors the encode half of `render.render`: change both together. Checked 2026-10-27 on the owner's PC: a 4 s 1080p30 clip with a box and zoom gave a 640² AV1 note in 3.7 s; through the API, a VP9 note with loudness. Not yet measured on A1.

## Browser upload

The browser sends a file in parts, because the router accepts at most 100 MB per request (`router/README.md`, Limits):

1. `POST /api/uploads {name, size}` (size ≤ 2000 MB) creates a job (`upload: true`, `status: 'uploading'`, `chat_id` = the user) and posts the first status message in the bot's chat. It answers 409 "Start the bot in Telegram first" when the bot cannot write to the user; the reply carries `chunk` (50 MB).
2. `PUT /api/jobs/:id/parts/:k`: raw bytes of part `k`, each saved as its own file (`part0000`…), so parts can go in parallel (3 lanes in the client) and land on different Modal containers without overwriting each other; each part commits the Volume. A part can be sent again; the last write wins. `PUT` must be in `CORS['allow_methods']` (`api.py`): the browser preflights a cross-origin PUT with `Authorization`, and without it the page only sees "No connection to the server" (found 2026-10-28, the first browser test; the job and its status message were already created by the POST).
3. `POST /api/jobs/:id/uploaded`: after a Volume reload the sizes must add up to `size` (409 otherwise), the parts are joined into `source.<ext>`, the job becomes `ingesting`, and `ingest_job` skips the MTProto download (`job['upload']`) and builds the proxy as usual. The bot then sends the editor button as for a video sent in Telegram.

## Client note

A round rendered on the user's device: `POST /api/jobs/:id/note` (a job of this user, not busy) or `POST /api/notes?name=` (no job: a local file that was never uploaded). The body is the MP4, at most `encode.NOTE_BYTES`. ffprobe must find a square video no bigger than 640 and no longer than the duration cap (422 "This is not a round" otherwise). Delivery is the server's (`bot.deliver`, with Resend when the user restricts video messages, Restricted notes); a job without a source has its status message removed instead of being turned into an editor button.
