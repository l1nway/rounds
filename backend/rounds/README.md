# rounds (backend package)

One Modal app (`app.py`) that receives the source video, serves the Mini App and renders the video note. Every module below is owned by one concern; the contracts in this file are what the modules agree on, so a change to a contract updates this file and every side in the same step.

## Files

| File | Concern | Runs in |
|---|---|---|
| `app.py` | Modal app: images, Volume, Dict, secret, functions (`web`, `ingest`, `render`, `setup`) | — |
| `config.py` | env (from the `rounds` secret) and shared constants | everywhere |
| `api.py` | FastAPI: Telegram webhook, Mini App API, `initData` auth, signed file URLs | `web` |
| `bot.py` | aiogram handlers: accept videos, Mini App button, progress messages | `web`, `ingest`, `render` |
| `transfer.py` | MTProto (Telethon) download of the source and upload of the note | `ingest`, `render` |
| `pipeline.py` | job orchestration: `ingest_job`, `render_job`, progress | `ingest`, `render` |
| `media.py` | ffprobe, proxy + filmstrip, tracking frames, scene cuts, audio | `ingest`, `render` |
| `render.py` | GPU renderer: subpixel crop + resample + colour pipeline → x264 | `render` |
| `color.py` | torch colour pipeline: YUV↔RGB, transfer functions, HDR→SDR, chroma resampling | `render` |
| `track.py` | object tracking (SAM 2.1 video, HF transformers) | `render` |
| `camera.py` | virtual camera path (L1 optimal path, HiGHS LP) | `render` |

## Contracts

**Time and space.** All backend coordinates are in source pixels of the *display-oriented* frame (rotation metadata applied, as ffmpeg's autorotate does), origin top-left. The API and the Mini App use normalized coordinates (0..1 of the display-oriented frame). Times are seconds (float, millisecond precision) on the source timeline. A job's working timeline is CFR at `FPS` (config, 30): frame `k` is at `start + k / FPS`, `N = round((end - start) * FPS)`; every per-frame array has length `N`.

**Volume** `rounds-data`, mounted at `/data`; one folder per job, `/data/jobs/<job_id>/`:

- `source.<ext>`: the original file, untouched.
- `proxy.mp4`: for the Mini App only. SDR BT.709, long side 960, CFR 30, keyframe every 15 frames (fast accurate seeking), H.264 + AAC 96k, `+faststart`.
- `filmstrip.jpg`: `tiles` frames evenly spread over the whole source, side by side in one row, each `tile_width × tile_height` (height 96).
- `note.mp4`: the result. Debug artifacts (`track.npz`, `path.npy`) may sit next to it.

**Job** (`modal.Dict` `rounds-jobs`, key = job id, 10 url-safe chars):

```
id, user_id, chat_id, source_message_id, status_message_id
status: 'ingesting' | 'ready' | 'rendering' | 'done' | 'failed'
stage: None | 'tracking' | 'framing' | 'rendering' | 'sending',  progress: 0..1,  error: str | None
meta: probe() result
proxy: {width, height, fps},  filmstrip: {tiles, tile_width, tile_height}
request: None | {start, end, prompt: {time, points: [[x, y, label]], box: [x0, y0, x1, y1] | None}, options: {loudnorm: bool}}
```

`label` is 1 for "this object", 0 for "not this". `prompt.time` lies inside `[start, end]`; `end - start ≤ MAX_DURATION`.

**Module functions** (pure of Modal, so they run and test locally):

- `media.probe(path) -> dict`: `duration`, `fps` (average), `width`, `height` (display-oriented), `rotation`, `transfer` (`'sdr' | 'hlg' | 'pq'`), `matrix` (`'bt709' | 'bt2020' | 'bt601' | ''`), `full_range` (bool; full-range Android H.264 passes through `-pix_fmt yuv420p` untouched, so the renderer must know), `bit_depth`, `has_audio`, `codec`. Without `matrix` the renderer assumes 709 for SDR and 2020 for HDR.
- `media.make_proxy(src, job_dir, meta) -> {'proxy': {...}, 'filmstrip': {...}}`.
- `media.track_frames(src, meta, start, end, long_side=1024) -> np.ndarray` `(N, H, W, 3)` uint8 RGB SDR, a memmap in a local temp dir.
- `media.scene_cuts(frames) -> list[int]`: indices of frames that start a new shot.
- `track.track(frames, index, points, box) -> dict` of `(N,)` arrays in `frames` pixels: `present` (bool), `cx`, `cy`, `r` (minimum enclosing circle of the mask), `area`. `points` / `box` are in `frames` pixels; `index` is the prompt frame.
- `camera.solve(track, width, height, cuts=(), fps=FPS, out_size=OUT_SIZE) -> np.ndarray` `(N, 3)`: `cx, cy, side` of the square window per frame, source pixels (`track` scaled to source pixels by the caller).
- `render.render(src, meta, start, end, path, out, options, progress=None) -> dict` (`size`, `duration`): `path` from `camera.solve`; `progress(fraction)` optional.

**Output** (`config`): `OUT_SIZE` 640, `FPS` 30, `MAX_DURATION` 60. H.264 High, yuv420p, BT.709 limited range tagged, AAC-LC 48 kHz, `+faststart`; sent with `length=OUT_SIZE`.

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

## Edge fill

Later step (owner: honest pixels first, an unnoticeable fill where the circle leaves the frame, maybe an AI outpainting model): let the window leave the frame for a subject at the frame edge, at a high cost, so the render stage fills the outside. Plug-in points: `# [DOC: edge-fill]` in `camera._lp`, where the window is held inside the frame (`x − h ≥ 0`, `x + h ≤ W`, same for y), and in `render`, where samples outside the frame are clamped today. Plan: give each of the four rows a slack with a cost between `SAFE_EXIT` and `CIRCLE_EXIT`, widen the variable bounds on `x, y`, keep `_clamp` in `_shot` and `_fallback` in sync, and fill the outside in `render`. Today a subject in a corner stays outside the safe circle 100 % of the time (measured: +0.52h; the best window inside the frame is still about +0.57h at the worst frame).

## Stabilization

Later option for shaky handheld sources: compensate global camera motion. Plug-in point: `# [DOC: stabilization]` in `camera._lp`, next to the data term. Plan: estimate a per-frame global transform (feature tracks or optical flow in `media`), express the subject positions and the smoothness terms in stabilised coordinates and the frame-bound rows in source coordinates via the per-frame transform (Grundmann et al., Section 3); `render` then warps instead of cropping. Today the smoothness terms smooth only the virtual camera, not the shake already in the source.

## Proxy tonemap

`media.sdr_chain` (proxy and tracking frames). SDR: `scale` (bicubic, `out_range=tv`) → `format=yuv420p` → `setparams` BT.709. HDR: downscale first (cheap), then `zscale=tin=<arib-std-b67|smpte2084>:pin=2020:min=2020_ncl:t=linear:npl=100,format=gbrpf32le,zscale=p=709,tonemap=tonemap=mobius:desat=0,zscale=t=709:m=709:r=tv,format=yuv420p`. `tonemap` only works on linear float input (ffmpeg-filters, tonemap), hence `t=linear` + `gbrpf32le`. Input tags are given explicitly so untagged files do not fail with "no path between colorspaces". `mobius` + `npl=100` came closest to the SDR original on a synthetic clip (luma of bars 61/164/204 vs SDR 62/172/217; `hable` 53/137/169, `npl=203` darker). Known limit: zimg applies the HLG OOTF per channel, not on luminance as BT.2100 does, so HLG proxy saturation differs slightly from the note; the proxy is only for picking.
Do not tag with the `-colorspace/-color_trc/-color_primaries` output options: in ffmpeg 9.0.2 they were ignored for frames without tags (the proxy came out `unknown`). Tags are set on frames with `setparams` (`media.BT709`), here and in the note encoder.

## Cfr decode

`media.decode` is the only way the backend reads source frames, so tracking frames and render frames share one timeline. `-ss start` before `-i` (accurate seek), `fps=FPS:start_time=0` as the first filter (frame k = start + k/FPS, duplicates and drops by nearest), `-frames:v N`. Autorotate stays on (default), so frames are display-oriented. Callers read with `read_full` (a `readinto` loop; pipes return short reads) into preallocated buffers. If ffmpeg returns fewer than N frames (range past the end, ±1 rounding), the last frame is repeated. `track_frames` writes an `np.memmap` in `tempfile.mkdtemp()`; the caller deletes it (`pipeline.render_job`).

## Scene cuts

`media.scene_cuts`: 512-bin RGB histogram (3 bits per channel, every 4th pixel); d = half L1 distance between consecutive frames. Cut at k when d > 0.3, d > 3 × median(d over ±15 frames, excluding k) + 0.05, and at least 6 frames since the last cut (flashes). Histograms miss cuts between shots of near-identical colour; motion-based scores were rejected because fast pans trigger them.

## Audio chain

`media.audio_input` trims the source audio with `-ss start -t N/FPS`, the same length as the video. `media.audio_filter` returns the `-af` chain: `aresample=48000`, or with `options.loudnorm` a two-pass `loudnorm=I=-16:TP=-1.5:LRA=11` (the first pass prints JSON on stderr, parsed between the last `{` and `}`; the second uses `measured_*`, `offset`, `linear=true`). AAC-LC 128k, 48 kHz, stereo (`-ac 2` folds 5.1 down). New audio filters are added to this chain.

## Render options

`render.encoder` is the seam: audio options go through `media.audio_filter(options)`. Stabilization belongs in the camera path (`# [DOC: stabilization]` in `camera`), not in the renderer: render only follows `path`.

## Lanczos matrix

Why our own renderer: ffmpeg `crop`/`zoompan` move only in whole pixels (2 px on yuv420p). Measured on a 4K dot with a 0.3 px/frame pan: integer crop jumps 0 or 1.0 output px (ideal 0.15, error up to 0.48 px); ours errs at most 0.005 px before encoding. libplacebo would do it, but it needs Vulkan, which the Modal GPU container may not have.
`render.weights` builds, per frame and axis, a dense `OUT_SIZE × span` matrix of Lanczos-3 weights. Output pixel j samples source coordinate `c − side/2 + (j + 0.5)·side/OUT_SIZE − 0.5` (index space, pixel centres are integers). The kernel is widened by `max(1, side/OUT_SIZE)` for antialiasing, rows are normalized. Only the touched rows and columns `[lo, hi)` are uploaded and multiplied: `out = Wy @ img @ Wx.T`. Coordinates float64, matrices float32. Dense matmul wastes the zeros (about 20 taps of 2160) but is a few GFLOP per frame at full tensor speed; a gather/unfold version was rejected for memory (about 350 MB per frame at a 4K window).
Resampling happens in linear light: downscaling in gamma space darkens fine bright detail. The cost is full-window chroma upsampling and per-pixel colour conversion before the matmul. Resampling the Y'CbCr planes separately and converting at 640² would be about 4× cheaper; rejected because it resamples non-linear signals, also before HDR tone mapping. Expect slightly stronger Lanczos halos around highlights; negative ringing is clamped.
Measured (CPU, 6 cores, torch CPU): `frame()` 0.47 s at a 1280 window, 0.86 s at 2160 SDR, 1.16 s at 2160 HLG. GPU estimate (not run): 20–30 ms per frame worst case; the bottleneck is likely software 4K HEVC 10-bit decode and x264 `slower`.

## Chroma siting

`color.up2`/`down2`: 2× polyphase Lanczos-3 as `conv1d` (an `unfold @ w` version was 3–5× slower on CPU because of per-batch copies). Siting is the H.264/HEVC default "left": chroma i sits at luma x = 2i, vertically between rows 2j and 2j+1. `chroma_location` is not read; top-left or centre siting would be off by a quarter chroma pixel. The chroma crop extends 3 samples beyond the luma span, so crop edges are exact. Output 4:2:0 uses the same kernel widened ×2 as an antialiasing filter, not point sampling.

## Linear light

`color.yuv_to_rgb`: matrix from `meta.matrix` (fallback 709 SDR, 2020 HDR), range from `meta.full_range`. 10-bit frames arrive as `yuv420p10le`, read as int16. SDR: BT.1886 gamma 2.4 both ways, so SDR round-trips exactly. PQ: SMPTE ST 2084 EOTF in nits (matches zimg exactly). HLG: BT.2100 inverse OETF, then the OOTF on luminance, `1000 · Ys^0.2 · E` (γ 1.2 for a 1000-nit display); verified on a synthetic clip encoded to the spec (65.8/184.5/17.6 nits vs expected 65.9/184/17.6). zimg differs here: it applies the OOTF per channel.

## HDR tonemap

On the 640² frame only: BT.2390 EETF in the PQ domain, source peak `HDR_PEAK` 1000 nits (MaxCLL is not read), target `SDR_WHITE` 203 nits (BT.2408 reference white), no black lift. Applied to max(R,G,B) and scaling all channels by the same ratio, which keeps hue. Below about 100 nits the image is untouched; 203-nit white lands at about 0.84 linear. Then BT.2020→709 with a 3×3 matrix and `soft_gamut`: chroma distance d relative to the 709 boundary along the line to grey (luma kept), compressed above `KNEE` 0.9 with tanh; knee 0.8 visibly desaturated pure primaries. SDR sources skip all of this (clamp only).

## Output encode

`color.encode`: BT.1886 inverse, BT.709 Y'CbCr limited, 4:2:0 as above, then a static dither (uniform ±0.5 LSB, fixed seed, the same pattern every frame: temporal noise would cost bitrate). Raw yuv420p 640² goes through a writer thread into x264 (`render.X264`: slower, CRF 16, tune film, High, g 60, maxrate 6M / bufsize 12M). Tags come from `setparams` + `setsar=1`. Decode, GPU work and encode overlap: a reader thread with `DEPTH` reusable buffers and a bounded writer queue; on any exception both ffmpeg processes are killed.
Trap: libx265 converted untagged `rawvideo` input to full range. Tag the frames (`setparams ... range=tv`) whenever raw frames go into an encoder.

## Ffmpeg build

Modal image (`app.FFMPEG`): BtbN static build, linux64 gpl n9.0, a month-end autobuild (kept 2 years; daily builds only 14 days), checked by sha256. It has `--enable-libzimg --enable-libx264 --enable-libx265 --enable-libplacebo --enable-vulkan`. The Linux binary was checked by its configure strings, not run yet.

## Tracking

`track.track(frames, index, points, box, progress=None)`: SAM 2.1 video (HF transformers `Sam2VideoModel`), two passes from the prompt frame, forward to `N-1` and backward to `0`, each in its own `Sam2VideoInferenceSession`. `progress(fraction)` every `PROGRESS_EVERY` (30) frames.

- `present` = object score logit > 0 and mask area ≥ `MIN_AREA` (1e-4 of the frame). `cx`, `cy`, `r` are NaN wherever `present` is False (`camera` treats non-finite as absent); `area` is always filled.
- CUDA: model and session in bf16 (`DTYPE`); CPU: fp32. bf16 on CUDA is not verified yet (the original repo uses autocast instead).
- The HF processor is not used: `Sam2ImageProcessor` needs torchvision + pillow, which are not installed. `_pixels` and `_prompt` reproduce it (bilinear antialiased resize to 1024², /255, ImageNet mean/std; points scaled by `1024/W`, `1024/H`; a box becomes two corner points labelled 2 and 3 placed before the clicks, as `processing_sam2_video.py` does). If the processor is ever adopted, compare masks before switching.
- Do not construct `Sam2VideoInferenceSession` without `dtype`: its default is the string `'float32'` and `add_new_frame` crashes on it.
- A single click makes SAM pick among three candidate masks and may return a part of the object (measured: the inner part of a disc, r 15 instead of 28). A box or two or more clicks give the whole object; the Mini App nudges towards a box.
- Weights are cached in the `rounds-models` Volume (`HF_HOME`); `app.render` loads the model and commits the Volume before the job, so only the first run downloads (~0.9 GB for large).
- Measured on CPU only (tiny, synthetic 512×384 clip, full 10-frame occlusion, a look-alike distractor): `present` False on all occluded frames, no switch to the distractor, centre error 0.8 px mean. GPU speed is estimated, not measured: large ~8–12 fps on L4, ~20–28 fps on A100 (published compiled A100: 39.5 fps).

## Tracking memory

Streaming mode keeps every frame and every per-frame output in the session forever: about 6 MB per frame of output state (`high_res_masks` 1024² fp32 alone is 4 MB) plus the input frame, ~10 GB for 1800 frames. `_pass` pops `processed_frames[k]` right after the step and drops non-conditioning outputs `max_object_pointers_in_encoder` (16) frames behind the current one. The model reads only the last `num_maskmem - 1` (6) outputs for memory and the last 15 for object pointers, plus the prompt frame's conditioning output, which stays. Measured: at most 16 kept outputs and 0 kept frames per session. A model that reads older frames would need a wider window.

## Tracking circle

The 256² mask logits are upsampled bilinearly to the frame size and thresholded at 0. Connected components smaller than `KEEP_BLOB` (0.2) of the largest are dropped: a far spurious blob would double `r` and pull the camera, while dropping a small true fragment only shrinks the circle slightly. `cv2.minEnclosingCircle` on the kept contours; `+0.5` converts pixel indices to pixel-centre coordinates. The circle centre is returned, not the mask centroid: `(cx, cy, r)` must be a circle that contains the object, which is exactly the camera's constraint; jitter is the camera solver's job.

## Tracker swap

`MODEL_ID` and `load()` are the seam. SAM 2.1 sizes: `facebook/sam2.1-hiera-{tiny,small,base-plus,large}`. SAM 3 tracker (`Sam3TrackerVideoModel` in `transformers.models.sam3_tracker_video`) has the same session/forward API family: swapping means changing the imports, `MODEL_ID` (gated: `HF_TOKEN`), and checking that its config still has `image_size` and `max_object_pointers_in_encoder`, the session constructor arguments and the output fields `pred_masks` / `object_score_logits`. DAM4SAM is a different code base: it would replace `_pass` and keep `_measure` and `track`.

## Mtproto sessions

`transfer.client(state, name)` logs in with the bot token over MTProto (Telethon, `receive_updates=False`: updates still come through the Bot API webhook) and keeps the session string in the `rounds-state` Dict under `session:<name>`. One session per function (`ingest`, `render`), and each of those functions runs at most one container (`max_containers=1`): the same auth key used from two places at once risks `AUTH_KEY_DUPLICATED`, and a fresh login per job risks `FLOOD_WAIT` on `auth.importBotAuthorization`. Messages are fetched with `get_messages(None, ids=...)`, which calls `messages.getMessages` without a peer (private chats need no access hash); the same call before `send_file` caches the user's access hash so the note can be sent.

## Init data

The Mini App sends `Authorization: tma <initData>`. Validation follows core.telegram.org/bots/webapps: secret key = HMAC-SHA256(key `WebAppData`, message = bot token); the hash is HMAC-SHA256 over the sorted `key=value` lines except `hash`. `auth_date` older than 24 h is refused, and the user must be in `ALLOWED_USER_IDS` and own the job.

## Signed urls

`<video src>` and `<img src>` cannot send headers, so `GET /api/jobs/:id` returns proxy and filmstrip URLs signed with HMAC (a key derived from the bot token, label `Files`) and valid for 6 h. Starlette's `FileResponse` serves HTTP Range requests, which video seeking needs. A file missing in the web container triggers one `volume.reload()` (the ingest container commits before marking the job ready).

## Telegram limits

Verified in sources (2026-10-25): TDLib rejects a video note `length` over 640 (`td/telegram/MessageContent.cpp`, "Wrong video note length"); the Bot API and TDLib upload the file untouched, the circle size comes from `length` only; the server-recommended `round_video_encoding` is 384 px / 1000 kbps / `max_size` 12 MiB (help.getAppConfig), recommended, not enforced by any client; clients record 384–480 px at 30 fps; expanded on a phone the circle covers about 1000–1340 device pixels, so 640 is visibly better than 480. Bots may use MTProto `upload.getFile` / `upload.saveBigFilePart` (2000 MB).

## Telegram experiment

Open until run (needs the bot token): a note over 12 MiB, a 1080×1080 file sent with `length=640`, a note longer than 60 s, HEVC; each checked on iOS, Android and Desktop, and the downloaded file hashed against the uploaded one (server re-encoding).
