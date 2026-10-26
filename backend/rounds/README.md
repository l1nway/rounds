# rounds (backend package)

One Modal app (`app.py`) that receives the source video, serves the Mini App and renders the video note. Every module below is owned by one concern; the contracts in this file are what the modules agree on, so a change to a contract updates this file and every side in the same step.

## Files

| File | Concern | Runs in |
|---|---|---|
| `app.py` | Modal app: images, Volume, Dict, secret, functions (`web`, `ingest`, `render`, `setup`) and the `Lift` class | — |
| `config.py` | env (from the `rounds` secret) and shared constants | everywhere |
| `api.py` | FastAPI: Telegram webhook, Mini App API, `initData` auth, signed file URLs | `web` |
| `bot.py` | aiogram handlers: accept videos, Mini App button, progress messages | `web`, `ingest`, `render` |
| `transfer.py` | MTProto (Telethon) download of the source and upload of the note | `ingest`, `render` |
| `pipeline.py` | job orchestration: `ingest_job`, `render_job`, progress | `ingest`, `render` |
| `source.py` | the source: ffprobe, frame cadence (gaps), duplicate frames, output rate | `ingest`, `render` |
| `media.py` | proxy + filmstrip, frame decode, tracking frames, scene cuts, audio | `ingest`, `render` |
| `render.py` | GPU renderer: subpixel crop + resample + colour pipeline → raw frames for `encode` | `render` |
| `encode.py` | note encoder: codecs, two passes to the size budget, audio, fit loop | `render` |
| `upscale.py` | AI upscale of a small source to 640 (SeedVR2 3B, code in the GPU image, weights in `rounds-models`) | `render` |
| `smooth.py` | 60 fps interpolation: timed decode, duplicate drop, retiming with RIFE | `render` |
| `rife.py` | RIFE 4.25 network, vendored (MIT, `RIFE-LICENSE`) | `render` |
| `color.py` | torch colour pipeline: YUV↔RGB, transfer functions, HDR→SDR, chroma resampling | `render` |
| `track.py` | object tracking (SAM 2.1 video, HF transformers) | `render` |
| `segment.py` | tap-to-lift: candidate outlines of the tapped object on one proxy frame (SAM 2.1 image) | `Lift` |
| `camera.py` | virtual camera path (L1 optimal path, HiGHS LP) | `render` |
| `tags.py` | source metadata for the note: read at ingest, MP4 box rewrite after the encode | `ingest`, `render` |

## Contracts

**Time and space.** All backend coordinates are in source pixels of the *display-oriented* frame (rotation metadata applied, as ffmpeg's autorotate does), origin top-left. The API and the Mini App use normalized coordinates (0..1 of the display-oriented frame). Times are seconds (float, millisecond precision) on the source timeline. A job's tracking timeline is CFR at `FPS` (config, 30): frame `k` is at `start + k / FPS`, `N = round((end - start) * FPS)`; the tracking frames, the track and the camera path have length `N`. The note has its own CFR rate (`source.out_rate`, Output rate); `camera.sampler` maps the path onto it.

**Volume** `rounds-data`, mounted at `/data`; one folder per job, `/data/jobs/<job_id>/`:

- `source.<ext>`: the original file, untouched.
- `proxy.mp4`: for the Mini App only. SDR BT.709, long side 960, CFR 30, keyframe every 15 frames (fast accurate seeking), H.264 + AAC 96k, `+faststart`.
- `filmstrip.jpg`: `tiles` frames evenly spread over the whole source, side by side in one row, each `tile_width × tile_height` (height 96).
- `note.mp4`: the result. Debug artifacts (`track.npz`, `path.npy`) may sit next to it.

**Job** (`modal.Dict` `rounds-jobs`, key = job id, 10 url-safe chars):

```
id, user_id, chat_id, source_message_id, status_message_id, queued_at (unix s, set when ingest / render is spawned)
status: 'ingesting' | 'ready' | 'rendering' | 'done' | 'failed'
stage: None | 'queued' | 'decoding' | 'tracking' | 'cuts' | 'framing' | 'rendering' | 'sending',  progress: 0..1,  error: str | None
meta: source.probe() result (tags included) + dupes, has_audio (re-checked on the proxy), interpolable (set by ingest after the proxy)
proxy: {width, height, fps},  filmstrip: {tiles, tile_width, tile_height}
request: None | {start, end, prompt: {time | None, points: [[x, y, label]], box: [x0, y0, x1, y1] | None, mask: str | None}, options: {zoom: bool, loudnorm: bool, interpolate: bool, metadata: bool, upscale: bool}, codec: 'hevc' | 'av1' | 'vp9' | 'h266'}
```

`options` is a free `dict[str, bool]` read with `.get`, so an unknown or retired key (`hires`, `hd720`, `hd1080`, `hevc` of older Mini App builds, High resolution) is ignored. `label` is 1 for "this object", 0 for "not this". `prompt.time` lies inside `[start, end]`; `end - start ≤ MAX_DURATION`. `codec` (default `hevc`; requests stored before the field have none, `pipeline` reads it with `.get` and the same default) must match the keys of `encode.CODECS` and the Mini App's `CODECS` (Codecs). `prompt.mask` is the outline the owner picked in the Mini App (Lift mask), a `data:image/png;base64,` URL of at most `MASK_CHARS` (90 000) characters; jobs and clients without it send `None`.

**Module functions** (pure of Modal, so they run and test locally):

- `source.probe(path) -> dict`: `duration`, `fps` (nominal, Source cadence), `gaps` (share of missing frames), `stream` (index of the video stream), `width`, `height` (display-oriented), `rotation`, `transfer` (`'sdr' | 'hlg' | 'pq'`), `matrix` (`'bt709' | 'bt2020' | 'bt601' | ''`), `full_range` (bool; full-range Android H.264 passes through `-pix_fmt yuv420p` untouched, so the renderer must know), `bit_depth`, `has_audio`, `codec`, `tags` (source tags the note can carry, Note metadata). Without `matrix` the renderer assumes 709 for SDR and 2020 for HDR.
- `media.make_proxy(src, job_dir, meta) -> ({'proxy': {...}, 'filmstrip': {...}}, {'dupes', 'has_audio'})`. `probe`, `make_proxy`, `track_frames` and `render` raise `source.Unreadable` with a readable reason for a source they cannot use (Broken sources).
- `media.track_frames(src, meta, start, end, long_side=1024) -> np.ndarray` `(N, H, W, 3)` uint8 RGB SDR, a memmap in a local temp dir.
- `media.scene_cuts(frames) -> list[int]`: indices of frames that start a new shot.
- `segment.Segmenter().segment(job_id, at, points, box, (w, h)) -> {candidates: [{mask, area}], best}` (Lift).
- `track.track(frames, index, points, box, mask='') -> dict` of `(N,)` arrays in `frames` pixels: `present` (bool), `cx`, `cy`, `r` (minimum enclosing circle of the mask), `area`. `points` / `box` are in `frames` pixels; `index` is the prompt frame; a decodable `mask` replaces both as the prompt (Lift mask).
- `camera.solve(track, width, height, cuts=(), fps=FPS, zoom=False) -> np.ndarray` `(N, 3)`: `cx, cy, side` of the square window per frame, source pixels (`track` scaled to source pixels by the caller).
- `camera.still(n, width, height) -> np.ndarray` `(n, 3)`: the centred full-frame window, for an untracked square source (Square source).
- `camera.sampler(path, cuts) -> at(frames)`: path rows at fractional tracking frames (Path sampler).
- `render.render(src, meta, start, end, path, cuts, out, options, codec, progress=None) -> dict` (`size` in bytes, `duration`, `rate`, `frames`, `codec`, `fit` (the bitrate scale the fit loop ended at, 1.0 = first try), `upscale` (bool, Upscale), plus `synth`, `dupes` when interpolating): `path` from `camera.solve` on the tracking timeline; `progress(fraction)` optional.

**Output** (`config`): `OUT_SIZE` 640 (the ceiling, High resolution), `MAX_DURATION` 60, rate by Output rate (≤ `MAX_FPS` 60). The codec of the request (Codecs), yuv420p (yuv420p10le for H.266), BT.709 limited range tagged, AAC-LC 48 kHz, `+faststart`, at most `encode.NOTE_BYTES` (Note size); always sent with `length=OUT_SIZE`.

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

## Edge fill

Later step (owner: honest pixels first, an unnoticeable fill where the circle leaves the frame, maybe an AI outpainting model): let the window leave the frame for a subject at the frame edge, at a high cost, so the render stage fills the outside. Plug-in points: `# [DOC: edge-fill]` in `camera._lp`, where the window is held inside the frame (`x − h ≥ 0`, `x + h ≤ W`, same for y), and in `render`, where samples outside the frame are clamped today. Plan: give each of the four rows a slack with a cost between `SAFE_EXIT` and `CIRCLE_EXIT`, widen the variable bounds on `x, y`, keep `_clamp` in `_shot` and `_fallback` in sync, and fill the outside in `render`. Today a subject in a corner stays outside the safe circle 100 % of the time (measured: +0.52h; the best window inside the frame is still about +0.57h at the worst frame).

## Stabilization

Later option for shaky handheld sources: compensate global camera motion. Plug-in point: `# [DOC: stabilization]` in `camera._lp`, next to the data term. Plan: estimate a per-frame global transform (feature tracks or optical flow in `media`), express the subject positions and the smoothness terms in stabilised coordinates and the frame-bound rows in source coordinates via the per-frame transform (Grundmann et al., Section 3); `render` then warps instead of cropping. Today the smoothness terms smooth only the virtual camera, not the shake already in the source.

## Proxy tonemap

`media.sdr_chain` (proxy and tracking frames). SDR: `scale` (bicubic, `out_range=tv`) → `format=yuv420p` → `setparams` BT.709. HDR: downscale first (cheap), then `zscale=tin=<arib-std-b67|smpte2084>:pin=2020:min=2020_ncl:t=linear:npl=100,format=gbrpf32le,zscale=p=709,tonemap=tonemap=mobius:desat=0,zscale=t=709:m=709:r=tv,format=yuv420p`. `tonemap` only works on linear float input (ffmpeg-filters, tonemap), hence `t=linear` + `gbrpf32le`. Input tags are given explicitly so untagged files do not fail with "no path between colorspaces". `mobius` + `npl=100` came closest to the SDR original on a synthetic clip (luma of bars 61/164/204 vs SDR 62/172/217; `hable` 53/137/169, `npl=203` darker). Known limit: zimg applies the HLG OOTF per channel, not on luminance as BT.2100 does, so HLG proxy saturation differs slightly from the note; the proxy is only for picking.
Do not tag with the `-colorspace/-color_trc/-color_primaries` output options: in ffmpeg 9.0.2 they were ignored for frames without tags (the proxy came out `unknown`). Tags are set on frames with `setparams` (`media.BT709`), here and in the note encoder.

## Cfr decode

`media.decode` reads source frames on a CFR grid: tracking at `FPS`, the note at its output rate, both from the same `-ss start` (accurate seek, before `-i`), so the grids share time zero. `fps=<rate>:start_time=0` as the first filter (frame k = start + k/rate, duplicates and drops by nearest), `-frames:v N`. The only other reader is `smooth.decode` (Timed decode), which keeps the source frames as they are. Autorotate stays on (default), so frames are display-oriented. Callers read with `read_full` (a `readinto` loop; pipes return short reads) into preallocated buffers. If ffmpeg returns fewer than N frames (range past the end, ±1 rounding), the last frame is repeated. `track_frames` writes an `np.memmap` in `tempfile.mkdtemp()`; the caller deletes it (`pipeline.render_job`).

## Broken sources

`media.LENIENT` (`-max_error_rate 1 -fflags +genpts+discardcorrupt`) goes before every `-i` of the source, video and audio reads alike (`open_at`, `make_proxy`, `audio_input`, the loudnorm pass): `genpts` makes up missing timestamps, `discardcorrupt` drops packets the demuxer flags as corrupt instead of decoding garbage (the gap is then held, or interpolated). The video stream is the one `probe` picked (`meta.stream`: the first video stream that is not cover art), mapped as `0:<index>` by `media.video` (`0:v:0` for jobs ingested before the field); a bare `0:v:0` can be a cover picture. `probe` takes the duration from the format, then the stream, then the packets, and raises a readable error if none has it.

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

- Ingest (`source.dupes`, decides the offer): the proxy's ffmpeg also scales every native frame (before `fps`) to 32×32 grey (`flags=area`) into a temp raw file (1 KB per frame). A frame is a duplicate when no thumb pixel moved by more than 1 level (`DUP_LEVEL`) while the mean motion within ±0.5 s reaches 1 level (`MOTION`), so a still tripod shot is not a freeze. `dupes` = share of such frames. Measured: 60 fps testsrc2 with 16 frames frozen → 0.067; the clean test files 0.
- Render (`smooth.still`, decides what to drop): luma of every 4th pixel in 8×8 blocks; a frame is dropped when the largest block mean |diff| to the last kept frame is ≤ 0.5 level (×4 for 10-bit). Blocks, not one global mean: a small moving part of a still frame (a hand, leaves) keeps the frame. Dropped frames are re-created by RIFE from their real neighbours. A run longer than `MAX_GAP` (1 s) is kept as a real still. Known limit: a perfectly static stretch (denoised and compressed to skip blocks) shorter than 1 s is dropped too; RIFE between two near-identical frames returns the same picture, so it only costs the grain.

## Output rate

`source.out_rate`: `MAX_FPS` (60) when `options.interpolate` and `meta.interpolable`, else the source rate capped at 60 (a 24 fps source gives a 24 fps note, 120 fps is decimated to 60). `meta.interpolable` (set at ingest): a rate under 60 (59.94 included: owner decision, anything under 60), `gaps` ≥ 0.5 %, or `dupes` ≥ 0.5 % (`SHARE`). Otherwise the Mini App shows the "Smooth to 60 fps" switch disabled ("Already a steady 60 fps"; the options seam disables, never hides). Interpolation always targets 60, never ×2 (owner decision). Tracking and the camera stay at `FPS` 30, so SAM costs the same; the path is resampled (Path sampler). The proxy stays 30 fps. x264 settings are unchanged: `-g 60` is 1 s at 60 fps, the size cap (Note size) is shared by twice the frames. Not yet checked: how the Telegram clients (iOS, Desktop) play a 60 fps note.

## Path sampler

`camera.sampler(path, cuts)` returns `at(frames)`: rows at fractional tracking frames (`t · FPS`, t from `start`), a `CubicSpline` per shot over its own frames, clamped to the shot's ends. A time belongs to the shot of `round(t · FPS)`, so the boundary sits half a tracking frame before the cut frame: the camera still jumps at the cut and never pans across it. Used for every output frame (CFR) and for every source frame (interpolation). Spline overshoot past the frame edge is sub-pixel and handled by the renderer's edge clamp.

## Upscale

Owner request 2026-10-26: an AI upscale for sources smaller than the note (old 384 or 400 px rounds, 480p clips), so the note is not just a bigger blurry picture. `options.upscale`, off by default; the Mini App offers it only when `min(meta.width, meta.height) < 640`, and `upscale.wanted` checks the same, so a stale or forged flag on a large source does nothing. That is the only case where the window is under 640 source px: the camera never zooms past 1:1 (Camera path, `h ≥ OUT_SIZE / 2`), so for a small source the window is the whole short side and constant.

- Model: SeedVR2 3B fp16 (ByteDance-Seed, Apache-2.0) through numz/ComfyUI-SeedVR2_VideoUpscaler (Apache-2.0), its CLI module imported in process: `inference_cli._process_frames_core(frames, args, '0', debug, cache)`, `args` from its own parser (`SETTINGS`), `cache` keeps the DiT and the VAE on the GPU between chunks. Code: `app.SEEDVR`, a pinned commit fetched into `config.SEEDVR_CODE` in the GPU image. Weights: `seedvr2_ema_3b_fp16.safetensors` (6.78 GB) and `ema_vae_fp16.safetensors` (501 MB) from HF `numz/SeedVR2_comfyUI` at a pinned revision (`upscale.WEIGHTS`), into the HF cache on the `rounds-models` Volume: `pipeline.render_job` fetches them in `render.load` when the job wants them, then commits the Volume (the first upscale downloads 7.3 GB once).
- Flow (`render.render`): the crop renders at `upscale.side` (the short side rounded up to 64, at most 640) instead of 640, so the Lanczos step barely scales; `upscale.frames` wraps the frame stream: linear → gamma (BT.1886 2.4, plain video pixels), `CHUNK` 90 frames per call, back to linear, then the usual `color.encode` and the encoder. With interpolation, RIFE runs at the small size first and SeedVR2 then upscales all 60 fps frames (twice the work of 30).
- Settings, chosen by the owner from side-by-side clips (2026-10-26, `seedvr_b45w`: "the most beautiful, not without artifacts"): `--batch_size 45` (4n + 1; frames processed together, temporal consistency inside a batch), `--color_correction wavelet` (keeps colours closer to the input than the default `lab`, which raised contrast), seed 42. Rejected: batch 21 with `lab` ("typical neural upscale, unpleasant, a dead giveaway"); Lanczos ("the 384 just stretched to 640, a pointless bigger file").
- Chunks of 90 are two whole batches, so the result equals one call over the whole clip (batches never span a chunk, the CLI has no blending without `--temporal_overlap`). A seam every 45 frames is possible (not seen in the 10 s test); `--temporal_overlap` and `--uniform_batch_size` are the levers, not tried.
- Known artifacts (owner's clips): doubled crisp edges on motion blur, faces partly redrawn. VMAF against the true 640 is lower than Lanczos (72.5 vs 74.5): a generative upscale invents detail that is not pixel-equal; judge it by eye.
- Imported lazily (`pipeline.render_job`, `render`): `upscale` imports torch, the CPU image has none. The CLI module sets the multiprocessing start method to `spawn` on import; the render uses threads, so nothing changes.
- Measured on Modal L4 through `render.render` (2026-10-26, a 10 s 384² 30 fps clip made from a real note, HEVC, no audio): first weight download 78 s; the frame loop 232 s (model load plus 4 chunks, about 62 s per 90 frames, 1.45 fps; VAE decode is the largest phase); second pass 22 s; 254 s in all; 13.7 GB of GPU memory in use at the end (models cached). The note equals the owner's CLI clip `seedvr_b45w` (PSNR between them 40.9 dB, VMAF against the true 640: 72.3 vs 72.5). Progress moves once per chunk, about a minute apart, the first after the model load.
- Cost (reasoned from that speed): about 21 min of L4 for 60 s at 30 fps, about 42 min at 60 fps (interpolation), close to the `render` timeout of 3600 s. Lower `CHUNK` does not speed it up; the levers are `--compile_dit`, a smaller batch for less VRAM, or another model (below).
- Alternatives (2026-10-26, not run here): FlashVSR (one-step diffusion on Wan2.1 1.3B, Apache-2.0, about 17 fps at 768×1408 on an A100 by its paper, so likely several times faster than SeedVR2; fixed ×4, so 384 → 640 needs a downscale before or after); SeedVR2 7B (slower, more VRAM); Upscale-A-Video (diffusion, S-Lab non-commercial licence: fine for this bot, slow); RealBasicVSR (GAN, Apache-2.0, fast, the "neural" look the owner rejected); Real-ESRGAN (per frame, BSD-3, flicker); mpv-style shaders (FSRCNNX, RAVU) through the libplacebo filter of our ffmpeg (`custom_shader_path`: one shader file, no Python deps; small CNNs, a bit sharper than Lanczos, nothing invented).

## Interpolation

`smooth.frames`, only with `interpolate`:

1. Source frames as they are, each with its own pts (Timed decode); no `fps` filter.
2. Duplicates dropped (Duplicate frames).
3. Each kept frame cropped by the camera path at its own time to a padded side: the render size (`OUT_SIZE`, or `upscale.side` with Upscale) + `PAD` 32 px each side (704 for 640), a multiple of 64 (RIFE's input step, the reason `upscale.side` rounds to 64); same centre, window × padded / output, in gamma (BT.1886 2.4: plain video pixels, what RIFE was trained on), half precision on the GPU; `Head` features once per frame.
4. Output slot j at j / 60: a real frame within a quarter of a slot (`SNAP`) is used as is (30 fps: every even slot; 60 fps with gaps: all but the gaps); otherwise RIFE between the neighbouring kept frames at `(t − t_a) / (t_b − t_a)`, so VFR timing is honoured. A pair more than 1 s apart (`MAX_GAP`) or across a scene cut (the tracking cuts) is not morphed: the nearer frame is held. Slots before the first or after the last frame hold it.
5. The result is cropped back to the output size, brought back to linear light, then the usual `color.encode` and the encoder (Two-pass).

Measured on CPU (2026-10-25, testsrc2 640×360, a 200 px pan): output frame counts and `r_frame_rate` exact in every case; 30 → 60: `synth` 30 of 60 (every odd slot); 24 → 60: 38 of 48 (only every 5th slot meets a real frame); 60 with a 16-frame freeze: 16 dropped, 16 synthesized; 60 with 16 frames missing: 16 synthesized; the same gap with a tracking cut inside: 0 synthesized (held). Visually: a clean middle frame at 30 → 60; filling the 0.27 s freeze leaves slightly wavy edges on the moving bars, the expected cost of a long gap (owner: better than a freeze). CPU speed is about 1 s per RIFE frame at 704²; the L4 speed is not measured yet (`render.encode` logs `synth` and `fps`).

Why crop first: RIFE at 704² costs the same for every source, 4K included, and sees the camera move as smooth global motion; the margin keeps the warp's border padding outside the circle. Rejected: interpolating the whole source frame (4K needs `scale=0.5` and about 20× the work); ffmpeg `minterpolate` (block matching, the artifacts the owner wants to avoid); decoding on a 60 Hz `fps` grid and detecting the repeats (would quantize real timestamps by up to 1/120 s, a fifth of a frame interval at 24 fps; reasoned, not tried).

## Timed decode

`smooth.decode`: `-v level+info` and `showinfo` last in the chain; a thread reads stderr, queues each `pts_time` and forwards only `[error]` / `[fatal]` lines to the log. `showinfo` prints before the frame reaches the pipe, so the k-th stamp exists when the k-th frame is read (`STAMP_WAIT` 60 s). `trim=end=` (the clip plus two source frames, so the last slot has a right neighbour) instead of `-t`: `-t` cuts after the filters, after `showinfo` has printed. NOPTS or non-increasing stamps are repaired (previous + 1 / fps, or + 1 ms). With `-ss` before `-i` the stamps start near 0 even for MPEG-TS, whose timestamps do not (checked on the broken test file).

## Rife

`rife.py`: RIFE 4.25 (hzwer/Practical-RIFE: "4.25 by default for most scenes" in its README) IFNet + Head, adapted from HolyWu/vs-rife (`IFNet_HDv3_v4_25.py`, `warplayer.py`), both MIT; notices in `RIFE-LICENSE`. Same parameter names as the checkpoint, loaded strictly with only the `block*` and `encode.*` keys (the checkpoint also carries the training-only `teacher.*` and `caltime.*`). Input sides must be multiples of 64 (704 is). Checked on CPU (torch 2.14, 2026-10-25): strict load, 5.66 M + 6 k parameters; a disc moved 40 px: the middle frame differs from the true one by 0.0006 (mean, 0..1), a plain blend by 0.011; t = 0.25 by 0.0007.

## Rife weights

`app.RIFE`: `flownet_v4.25.pkl` from the vs-rife GitHub release `model` (the official links are Google Drive and Baidu, unreliable in an image build), checked by sha256 and baked into the GPU image at `config.RIFE_WEIGHTS`. 24.6 MB, torch zip format, loaded with `weights_only=True`. Not checked: that the release file is byte-identical to the archive on Practical-RIFE's Drive.

## Scene cuts

`media.scene_cuts`: 512-bin RGB histogram (3 bits per channel, every 4th pixel); d = half L1 distance between consecutive frames. Cut at k when d > 0.3, d > 3 × median(d over ±15 frames, excluding k) + 0.05, and at least 6 frames since the last cut (flashes). Histograms miss cuts between shots of near-identical colour; motion-based scores were rejected because fast pans trigger them.

## Audio chain

`media.audio_input` trims the source audio with `-ss start -t n/rate`, the same length as the video. `media.audio_filter` returns the `-af` chain: `GAPLESS` (`aresample=48000:async=1:first_pts=0`), or with `options.loudnorm` `GAPLESS` and a two-pass `loudnorm=I=-16:TP=-1.5:LRA=11` (the first pass prints JSON on stderr, parsed between the last `{` and `}`; the second uses `measured_*`, `offset`, `linear=true`; skipped when a measured value is not finite, Broken sources). `GAPLESS` fills the holes left by undecodable audio with silence, timed by the frames' pts, and pads the start. Without it loudnorm stamped its first 3 s of output contiguously from the first frame (`af_loudnorm.c`, `activate`, `FIRST_FRAME`), so a hole there pulled the later audio forward: `audiogap.mp4` (0.4 s of audio missing at 1.3–1.7 s, range 1–5 s) had its beeps at 0.59 / 1.6 / 2.6 / 3.6 s instead of 1 / 2 / 3 / 4; plain `aresample` kept the timing but stored the hole as one AAC sample lasting 20480 samples in `stts`, which a player may not honour. With `GAPLESS`: 1 / 2 / 3 / 4 on both chains, contiguous packets; clean audio unchanged. AAC-LC 128k, 48 kHz, stereo (`-ac 2` folds 5.1 down). New audio filters are added to this chain.

## Render options

`encode.second_pass` is the seam: audio options go through `media.audio_filter(options)` (computed once, before the fit loop). `options.metadata` adds `creation_time` to the encoder and `tags.write` after it (Note metadata). `options.zoom` goes to `camera.solve` in `pipeline.render_job` (Zoom option). `options.interpolate` picks the frame source in `render.render` (`render.cfr` or `smooth.frames`) and the rate (`source.out_rate`). Stabilization belongs in the camera path (`# [DOC: stabilization]` in `camera`), not in the renderer: render only follows `path`.

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

## Output encode

`color.encode`: BT.1886 inverse, BT.709 Y'CbCr limited, 4:2:0 as above, then a static dither (uniform ±0.5 LSB, fixed seed, the same pattern every frame: temporal noise would cost bitrate). Raw yuv420p 640² frames leave the GPU through a bounded writer queue (`encode.writer`) and are encoded in two passes (Two-pass) with the codec of the request (Codecs). Tags come from `setparams` (`media.BT709`) + `setsar=1` in both passes. Decode, GPU work and the first pass overlap: a reader thread with `DEPTH` reusable buffers, the writer thread feeding both the raw file and the first pass; on any exception the first pass is killed and the queue is closed.

Trap: libx265 converted untagged `rawvideo` input to full range. Tag the frames (`setparams ... range=tv`) whenever raw frames go into an encoder.

## Note size

A note file over the size limit arrives as a regular square video, not a round, even with `round_message=True` and `length=640` (owner, 2026-10-26: job `WKRXzRMgDi`, 18.9 s at 60 fps, 13.2 MB, twice, with and without metadata; the last round that worked, `pRBvJxLSTr`, was 8.4 s, 5.7 MB). The exact threshold is not verified; the server config recommends `max_size` 12 MiB = 12 582 912 B (Telegram limits).

Owner decision 2026-10-26: every note spends its budget (short notes get far more bits, long ones are trimmed and never go over), and the budget is `encode.NOTE_BYTES` = 10 000 000 B. It was 12 000 000 B (0.58 MB under 12 MiB) for a few hours: the AV1 and VP9 test notes of 12.8 s, which filled that budget to about 11.6 MB (reasoned from the target, the files were not measured), arrived as regular videos, while every round that worked (the HEVC one included) was under 10 MB. So the owner (2026-10-26) put the cap back to 10 MB to tell size from codec; retest AV1 and VP9 under it before dropping them. The earlier design (CRF 16 with a VBV maxrate cap, 10 MB) left short notes at CRF quality and gave long ones an uneven clamp.

- `encode.target`: `bits/s = min(MAX_RATE 14M, (NOTE_BYTES × 8 × HEADROOM 0.97 − audio 128k × dur) / dur)`. A 60 s note gets 1.17 Mbit/s of video, 18.9 s gets 4.0 (1.42 and 4.8 under the 12 MB budget). `MAX_RATE` is the "reasonable" ceiling: H.264 High at level 4 allows 25 Mbit/s and beyond about 14 Mbit/s nothing is visible at 640² (reasoned, not measured); notes up to about 5.5 s hit it and stay under the budget.
- Two-pass ABR lands within about 1 % of the target (measured below), `HEADROOM` 0.97 covers that and the MP4 overhead. Short notes overshoot more (4 s at 14 Mbit/s: AV1 +16 %, VP9 +12 %, H.264 −5 %), harmless under the ceiling. VVC undershoots short notes instead (4 s: 2.3 MB for a 7 MB aim), on target at 18.9 s.
- Hard ceiling (owner: always a round, never a regular video): `encode.second_pass` checks the file after every second pass; over `NOTE_BYTES` it reruns the second pass from the same raw frames and first-pass stats with the target scaled by `SHRINK` 0.95 × limit / size, up to `FIT_TRIES` 3, then fails the job. No second generation of lossy frames any more (the old `render.shrink` re-encoded the note itself). `fit` in the result and the log is the final scale. Runs before `tags.write`, so the kept metadata is added to the final file.
- Measured under the 12 MB budget (local ffmpeg 9.0.2, 6 cores, 2026-10-26; the 18.9 s note `WKRXzRMgDi` as the source, looped to 60 s; two passes at the target, video only): 18.9 s → x264 11.57 MB, x265 11.24, SVT-AV1 11.42, VP9 11.35 for an aim of 11.34; 60 s → 10.66–10.78 MB for an aim of 10.68. With audio the 60 s note ends near 11.6 MB.
- Do not raise `NOTE_BYTES` or `MAX_RATE` without a send test on the phone; the 10 000 000 B budget is the one known to keep rounds, the threshold lies between 10 and about 11.6 MB (Telegram experiment).

## Codecs

Owner request 2026-10-26: a codec choice in the Mini App (`RenderRequest.codec`, Mini App `CODECS`, `encode.CODECS`), HEVC by default ("it works": the owner's 640 HEVC note stayed a round). Every codec goes through the same two passes and budget; MP4 sample entries `hvc1` (`-tag:v hvc1`, Apple players need it), `av01`, `vp09`, `vvc1`, checked with ffprobe.

Owner 2026-10-26, second round: H.264 is dropped ("an old format, only modern codecs"; it stayed a round in every test, measured below for reference); H.266 is added only to see what happens; later the list may shrink to one codec (likely AV1) once AV1 and VP9 are tested on the phone. The key is still accepted nowhere else: `RenderRequest.codec` rejects `h264` (422), the Mini App falls back to its first codec for a stored `h264` draft.

| key | encoder | settings | VMAF at 60 s, 1.42 Mbit/s | passes, 60 s at 60 fps (local, 6 cores) | status |
|---|---|---|---|---|---|
| `hevc` | libx265 | slow, Main, `slow-firstpass=0` | 93.6 | 71 + 137 s | default; a round (owner) |
| `av1` | libsvtav1 | preset 6 | 95.5 | 25 + 70 s | experimental: round not verified |
| `vp9` | libvpx-vp9 | good, cpu-used 4, row-mt, alt-ref, lag 25 | 91.8 | 14 + 153 s | experimental: round not verified |
| `h266` | libvvenc | preset faster, Main 10 (`yuv420p10le`, the only input vvenc takes) | not run (see below) | 32 + 240 s at 18.9 s | test only: no Telegram iOS or Desktop decoder |
| (dropped) `h264` | libx264 | slower, tune film, High | 91.7 | 11 + 46 s | a round (every note before 2026-10-26) |

- VMAF is against the source note, which is itself H.264, so x264 is favoured; HEVC and AV1 are probably better than the table says. At 18.9 s (4.8 Mbit/s) x264, x265, SVT-AV1 and VP9 score 98.2–98.5: the codec matters for long notes. VVC at 18.9 s: `faster` 97.7, `fast` 99.0, `medium` was stopped after 40 min (pass 2 at about 60 %).
- Speed: the first pass runs while the GPU renders, so the cost on top of the old single encode is mostly the second pass. x265 `slow` with its default slow first pass took 144 + 136 s; `medium` 61 + 78 s for 92.1 (the lever if HEVC renders feel slow). VP9 at cpu-used 2 scored 92.3 for 16 + 320 s, so cpu-used 4. AV1 preset 5 gave the same 95.5 as preset 6, slower. VVC is the slowest by far: pass 2 of 18.9 s took 240 s at `faster`, 468 s at `fast` (local, 6 cores), so a 60 s note at 60 fps needs roughly 13 min at `faster` (reasoned, ×3.2 frames), and `fast` would take about 25; `faster` keeps a test render inside the 3600 s `render` timeout even with Upscale. The Modal `render` function has 8 CPUs; not measured there yet.
- Who can play what (primary sources, 2026-10-26): Telegram iOS builds FFmpeg with `--enable-decoder=h264,libvpx_vp9,hevc,...,libdav1d,av1` and `--enable-hwaccel=h264_videotoolbox,hevc_videotoolbox,av1_videotoolbox` (`submodules/ffmpeg/Sources/FFMpeg/build-ffmpeg-bazel.sh`) and vendors `third-party/dav1d` and `libvpx`; Telegram Desktop builds dav1d and libvpx (`Telegram/build/prepare/prepare.py`). Neither enables a VVC decoder, so an H.266 note should not play there (libvvenc is in our ffmpeg, the clients are the limit). Android 17 adds a platform VVC decoder through MediaCodec (`MIMETYPE_VIDEO_VVC`, "VVC support" on source.android.com), only where the SoC vendor ships a Codec2 VVC decoder; whether Telegram Android hands such a file to MediaCodec (its player and MP4 parser must know `vvc1`) is unknown. Not verified: Telegram Android (MediaCodec, per device), whether the server keeps an AV1 or VP9 file a round, and whether the inline round player on iOS takes the FFmpeg path for them.
- SVT-AV1 prints its banner to stderr; `encode.QUIET` sets `SVT_LOG=1` (errors only).

## Two-pass

`render.render` opens a temp dir (`tempfile.TemporaryDirectory`, the container's local disk, never the Volume) and starts `encode.first_pass` (stats only, `-f null`) before the frame loop. `encode.writer` writes every frame both to `frames.yuv` in that dir and into the first pass. After the loop: the first pass must exit 0, then `encode.second_pass` encodes `frames.yuv` + the source audio (`media.audio_input`, the loudnorm filter computed once) into the note, with `-progress pipe:1` parsed for `frame=` lines. Progress in the chat: the frame loop maps to 0–`FRAMES_SHARE` 0.6, the second pass to the rest.

- Disk: raw 640² yuv420p is 0.6 MB a frame, 2.2 GB for 60 s at 60 fps; deleted with the dir.
- Rejected: two passes both from a pipe (the GPU work would run twice) and a lossless intermediate (an extra encode, and raw is cheap on local disk).
- `-pass` / `-passlogfile` work for all four encoders in ffmpeg 9.0.2 (x264 `.mbtree`, x265 `.cutree`, SVT-AV1 and libvpx their own stats), all inside the temp dir.

## Ffmpeg build

Modal image (`app.FFMPEG`): BtbN static build, linux64 gpl n9.0, a month-end autobuild (kept 2 years; daily builds only 14 days), checked by sha256. Its configure strings (checked 2026-10-26 on the pinned tarball) include `--enable-libx264 --enable-libx265 --enable-libsvtav1 --enable-libvpx --enable-libaom --enable-libdav1d --enable-libvvenc --enable-libvidstab --enable-libvmaf --enable-libzimg --enable-libplacebo --enable-vulkan`. The Linux binary has not been run outside Modal.

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

## Lift

Tap-to-lift: the owner taps the object and sees its outline lifted from the frame (iOS "lift subject" look), cycles through SAM's candidates, and the chosen outline becomes the tracking prompt. Owner decision 2026-10-26: about $8 a month of the Starter credits is fine if it looks good; approved after a demo on the iPhone.

- `Lift` (`app.py`): a Modal class on L4, `max_containers=1`, `scaledown_window=LIFT_IDLE` (120 s), `enable_memory_snapshot=True`. `load` (snapshot phase, no GPU) builds `segment.Segmenter` on the CPU, `to_gpu` moves it to CUDA after every restore. `warm()` does nothing: calling it starts the container. `segment` reloads the data Volume when the proxy is not visible yet.
- `POST /api/jobs/{id}/warm` → 202: spawns `Lift.warm`. The Mini App calls it when the editor opens, so the cold start overlaps with choosing the frame.
- `POST /api/jobs/{id}/segment` with a `Prompt` body (`time`, `points`, `box`; `mask` ignored) → `{candidates: [{mask, area}], best}`. 409 until the proxy exists, 502 with a readable detail when the GPU call fails (the Mini App then keeps the plain point).
- `segment.Segmenter`: SAM 2.1 large image model (`Sam2Model`, the same checkpoint as the tracker, `SAM_MODEL`), bf16. The frame is the proxy frame `floor(time × FPS)`, the one the `<video>` shows at that time; the image embedding is cached per (job, frame), `EMBEDDINGS` (8) frames LRU, so more taps on the same frame run only the prompt decoder. One point without a box asks for 3 candidates (`multimask_output`); two points or a box give one. Candidates are cleaned (Lift mask), sorted by area (part → whole → surroundings), near-duplicates dropped (IoU ≥ `SAME` 0.9). `best` is the middle one: SAM's own `iou_scores` did not match what looked right (the clean whole sheet scored 0.06, a part of the face 0.51), the middle candidate was the whole object in 2 of 3 spike taps.
- `track.py` must not be imported here: it decides `DEVICE` at import, and the snapshot phase has no GPU.

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

## Stage timings

Every step of a job prints one line to the Modal log: `[<job id>] <function>.<step> <seconds>s key=value …`, read with `uv run modal app logs rounds --timestamps` (grep the job id). `pipeline.timed` wraps a step and prints when it ends; a tuple fact `(amount, unit)` is printed as a rate, `amount / seconds` (`speed=(mb, 'MB/s')`, `fps=(frames, '')`, `speed=(duration, 'x')` = times realtime). A step that raises prints nothing (`fail` prints the traceback).

- `ingest.wait`, `render.wait`: from `queued_at` (the webhook or `POST /render`) to the function body. Covers Modal scheduling and the container cold start (image, imports). Jobs created before the field existed print 0.
- `ingest.download` (`mb`, `speed`): the MTProto download alone, without the login. `ingest.probe` (the source: size, fps, gaps, codec, transfer, bit depth, duration, audio, `tags` = number of kept tags), `ingest.proxy` (`speed` in × realtime of the whole source, `dupes`, `has_audio` after the proxy, `interpolable`), `ingest.commit`, `ingest` (the whole function).
- `render.load`: the SAM weights to the GPU; near 0 in a warm container (`@cache`), so it tells a cold start from a warm one. `render.decode` (`frames`, `size` of the tracking frames, `fps`), `render.track` (`fps`), `render.cuts`, `render.camera`, `render.encode` (`fps` of the frame loop plus both passes, `mb` of the note, `codec`, `fit` (below 1 when the fit loop had to retry), `rate` of the note, `upscale`, and with interpolation `synth` = RIFE frames, `dupes` = dropped source frames), `render.commit`, `render.send` (login + upload, `speed`), `render` (the whole function, with `clip` length and the source facts).

Keep it to one line per step and only numbers that point to a lever (bandwidth, fps, cold or warm); progress percentages stay in the chat, not in the log.

## Mtproto sessions

`transfer.client(state, name)` logs in with the bot token over MTProto (Telethon, `receive_updates=False`: updates still come through the Bot API webhook) and keeps the session string in the `rounds-state` Dict under `session:<name>`. One session per function (`ingest`, `render`), and each of those functions runs at most one container (`max_containers=1`): the same auth key used from two places at once risks `AUTH_KEY_DUPLICATED`, and a fresh login per job risks `FLOOD_WAIT` on `auth.importBotAuthorization`. Messages are fetched with `get_messages(None, ids=...)`, which calls `messages.getMessages` without a peer (private chats need no access hash); the same call before `send_file` caches the user's access hash so the note can be sent.

## Init data

The Mini App sends `Authorization: tma <initData>`. Validation follows core.telegram.org/bots/webapps: secret key = HMAC-SHA256(key `WebAppData`, message = bot token); the hash is HMAC-SHA256 over the sorted `key=value` lines except `hash`. `auth_date` older than 24 h is refused, and the user must be in `ALLOWED_USER_IDS` and own the job.

## Signed urls

`<video src>` and `<img src>` cannot send headers, so `GET /api/jobs/:id` returns proxy and filmstrip URLs (null while the job has no `proxy`: ingesting, or a failed ingest, which the Mini App shows as "could not be prepared" with `error`) signed with HMAC (a key derived from the bot token, label `Files`) and valid for 6 h. Starlette's `FileResponse` serves HTTP Range requests, which video seeking needs. A file missing in the web container triggers `volume.reload()`, retried up to `RELOADS` times (observed: the first request in a cold container got a 500, `RuntimeError: there are open files preventing the operation`, because a parallel `FileResponse` held a file open; the error is swallowed and the existence check decides) (the ingest container commits before marking the job ready).

## Ready notice

Editing a message never notifies (owner's observation: the editor became available without a push). So the two outcomes the owner waits for, `ready` and `failed`, go through `bot.announce`: a new reply to the source video with the `Open editor` button, then the progress message is deleted, so the chat still holds one message per phase; the job's `status_message_id` moves to the new message. Send first, delete second: a failed send must not leave the chat empty. Progress stays silent edits (`bot.status`); `done` is an edit too, the note itself is the notification. A late progress edit aimed at the deleted message fails with `TelegramBadRequest`, which `bot.status` swallows.

## Launch aspect

`bot.editor(job)` builds the `Open editor` URL as `?job=<id>&a=<width / height>` (display-oriented, rounded to 6 digits) once the job has `meta`; before the probe (a failed download) there is no `a`. The Mini App gives its placeholder that shape before `GET /api/jobs/:id` answers, so a vertical video opens in its final shape with no layout movement (owner decision 2026-10-26, `miniapp/src/services/README.md`, Launch aspect). The value is a layout hint only: the job's `meta` stays the truth, and buttons sent before the change (no `a`) fall back to 16:9.

## Chat action

Every stage has its own status text (`bot.TEXTS`), edited into one message per phase (ingest: reply to the video; render: a new reply made by the API at the moment of "Render", so the GPU cold start and the model load are not silent). A long step with no progress callback (probe, proxy, decoding, scene cuts, the camera solver) still gets a text of its own, because "silent" was the owner's complaint.

The chat header shows the matching action: `typing` during ingest, `record_video_note` from decoding to the end of the render, `upload_video_note` (Telethon `round`) while the file is sent. A Bot API chat action lasts about 5 s and is dropped as soon as the bot sends a message, so `bot.acting` repeats it every `ACTION_EVERY` = 4 s until the block ends. Failures of `sendChatAction` are swallowed: it is decoration. The `queued` stage has no action: the GPU container is not up yet, so nothing runs the pulse.

The note's file name is the source's with the extension swapped for `.mp4` (`IMG_4359.MOV` → `IMG_4359.mp4`, `round.mp4` if the source has no name), set through `DocumentAttributeFilename` in `transfer.send_note`. Telegram clients do not show it on a round, it surfaces when the note is saved.

Ideas for later modes (owner): "no subject" (a plain centre or a slow auto-crop with nothing to track, so the prompt becomes optional), and more audio and video options next to `loudnorm`. The seams are `Prompt` (its validator `check` accepts an empty selection, Square source; `render` allows it only for square sources today), `pipeline.render_job` (the tracking and camera stages are skippable: `camera.solve` only needs a found track) and `options`.

## Telegram limits

Verified in sources (2026-10-25): TDLib rejects a video note `length` over 640 (`td/telegram/MessageContent.cpp`, "Wrong video note length"); the Bot API and TDLib upload the file untouched, the circle size comes from `length` only; the server-recommended `round_video_encoding` is 384 px / 1000 kbps / `max_size` 12 MiB (help.getAppConfig), recommended, not enforced by any client; clients record 384–480 px at 30 fps; expanded on a phone the circle covers about 1000–1340 device pixels, so 640 is visibly better than 480. Bots may use MTProto `upload.getFile` / `upload.saveBigFilePart` (2000 MB).

## Telegram experiment

Done (2026-10-26, owner's test): 720 and 1080 notes arrive as regular videos, not rounds, even under the 10 MB cap (High resolution); the note keeps its metadata (Note metadata).

Done (2026-10-26): a 640² note of 13.2 MB arrives as a regular video (Note size). Owner (2026-10-26): a 640 HEVC note works, so HEVC became the default (Codecs). Done (2026-10-26): AV1 and VP9 notes of 12.8 s that filled the 12 000 000 B budget arrived as regular videos (they played on iOS 18); an H.266 note was not sent as a round and played neither on iOS nor on Desktop. The budget went back to 10 000 000 B (Note size). Open: AV1 and VP9 notes under 10 MB stay rounds and play on iOS and Desktop, what an H.266 note does on iOS, Desktop and an Android 17 phone (Codecs); an upscaled note (Upscale) looks right on the phone; the exact size threshold (between 10 and about 11.6 MB), a note longer than 60 s; each checked on iOS, Android and Desktop, and the downloaded file hashed against the uploaded one (server re-encoding).
