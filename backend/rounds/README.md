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
| `render.py` | GPU renderer: subpixel crop + resample + colour pipeline → x264 | `render` |
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
request: None | {start, end, prompt: {time, points: [[x, y, label]], box: [x0, y0, x1, y1] | None, mask: str | None}, options: {loudnorm: bool, interpolate: bool, metadata: bool}}
```

`options` is a free `dict[str, bool]` read with `.get`, so an unknown or retired key (the `hires` of older Mini App builds, High resolution) is ignored. `label` is 1 for "this object", 0 for "not this". `prompt.time` lies inside `[start, end]`; `end - start ≤ MAX_DURATION`. `prompt.mask` is the outline the owner picked in the Mini App (Lift mask), a `data:image/png;base64,` URL of at most `MASK_CHARS` (90 000) characters; jobs and clients without it send `None`.

**Module functions** (pure of Modal, so they run and test locally):

- `source.probe(path) -> dict`: `duration`, `fps` (nominal, Source cadence), `gaps` (share of missing frames), `stream` (index of the video stream), `width`, `height` (display-oriented), `rotation`, `transfer` (`'sdr' | 'hlg' | 'pq'`), `matrix` (`'bt709' | 'bt2020' | 'bt601' | ''`), `full_range` (bool; full-range Android H.264 passes through `-pix_fmt yuv420p` untouched, so the renderer must know), `bit_depth`, `has_audio`, `codec`, `tags` (source tags the note can carry, Note metadata). Without `matrix` the renderer assumes 709 for SDR and 2020 for HDR.
- `media.make_proxy(src, job_dir, meta) -> ({'proxy': {...}, 'filmstrip': {...}}, {'dupes', 'has_audio'})`. `probe`, `make_proxy`, `track_frames` and `render` raise `source.Unreadable` with a readable reason for a source they cannot use (Broken sources).
- `media.track_frames(src, meta, start, end, long_side=1024) -> np.ndarray` `(N, H, W, 3)` uint8 RGB SDR, a memmap in a local temp dir.
- `media.scene_cuts(frames) -> list[int]`: indices of frames that start a new shot.
- `segment.Segmenter().segment(job_id, at, points, box, (w, h)) -> {candidates: [{mask, area}], best}` (Lift).
- `track.track(frames, index, points, box, mask='') -> dict` of `(N,)` arrays in `frames` pixels: `present` (bool), `cx`, `cy`, `r` (minimum enclosing circle of the mask), `area`. `points` / `box` are in `frames` pixels; `index` is the prompt frame; a decodable `mask` replaces both as the prompt (Lift mask).
- `camera.solve(track, width, height, cuts=(), fps=FPS, out_size=OUT_SIZE) -> np.ndarray` `(N, 3)`: `cx, cy, side` of the square window per frame, source pixels (`track` scaled to source pixels by the caller).
- `camera.sampler(path, cuts) -> at(frames)`: path rows at fractional tracking frames (Path sampler).
- `render.render(src, meta, start, end, path, cuts, out, options, progress=None) -> dict` (`size` in bytes, `duration`, `rate`, `frames`, plus `synth`, `dupes` when interpolating): `path` from `camera.solve` on the tracking timeline; `progress(fraction)` optional.

**Output** (`config`): `OUT_SIZE` 640 (the ceiling, High resolution), `MAX_DURATION` 60, rate by Output rate (≤ `MAX_FPS` 60). H.264 High, yuv420p, BT.709 limited range tagged, AAC-LC 48 kHz, `+faststart`; always sent with `length=OUT_SIZE`.

## Camera path

`camera.solve` turns a track into a square window per frame (`cx, cy, side`, source px) with an L1-optimal path (Grundmann et al., "Auto-Directed Video Stabilization with Robust L1 Optimal Camera Paths", CVPR 2011), solved as one sparse LP per shot by HiGHS (`scipy.optimize.linprog(method='highs')`, dual simplex).

- Units: everything is divided by `S = min(W, H) / 2`, so the widest window has half-side 1 and weights are resolution-independent. Each shot between `cuts` is solved alone: the camera may jump at a cut, never pans across it.
- Variables per sample: `x, y, h` (h = side / 2). Every L1 term `|A z - b|` is split as `A z - b = p - m`, `p, m ≥ 0` (one equality row, cheaper for dual simplex than two inequality rows).
- Objective: `|D1|, |D2|, |D3|` with weights 10 / 1 / 100 (paper), zoom ×8 (`ZOOM_WEIGHT`) so zoom stays static; data `|c - p|` (`CENTER` 0.2, low: the operator is lazy, follows a moving subject, ignores fidgeting); framing `|h - r / FILL|` (`FRAMING` 0.5, `FILL` 0.55).
- Hard: window inside the frame; `h ∈ [out_size/2, 1]` (never upscale; the largest square if the source is smaller); pan speed ≤ `PAN_SPEED` 0.5 window/s, acceleration ≤ `PAN_ACCEL` 1.5 window/s², zoom ≤ `ZOOM_SPEED` 12 %/s. The caps are rows relative to the current `h`, not bounds, so a wide window may pan faster in pixels.
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

## Interpolation

`smooth.frames`, only with `interpolate`:

1. Source frames as they are, each with its own pts (Timed decode); no `fps` filter.
2. Duplicates dropped (Duplicate frames).
3. Each kept frame cropped by the camera path at its own time to a padded side: the output side + `PAD` 32 px each side, rounded up to a multiple of 64 (`MULTIPLE`, RIFE's input step): 704 for 640, 832 for 720, 1152 for 1080 (High resolution); same centre, window × padded / output, in gamma (BT.1886 2.4: plain video pixels, what RIFE was trained on), half precision on the GPU; `Head` features once per frame.
4. Output slot j at j / 60: a real frame within a quarter of a slot (`SNAP`) is used as is (30 fps: every even slot; 60 fps with gaps: all but the gaps); otherwise RIFE between the neighbouring kept frames at `(t − t_a) / (t_b − t_a)`, so VFR timing is honoured. A pair more than 1 s apart (`MAX_GAP`) or across a scene cut (the tracking cuts) is not morphed: the nearer frame is held. Slots before the first or after the last frame hold it.
5. The result is cropped back to the output size, brought back to linear light, then the usual `color.encode` and x264.

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

`render.encoder` is the seam: audio options go through `media.audio_filter(options)`. `options.metadata` adds `creation_time` to the encoder and `tags.write` after it (Note metadata). `options.interpolate` picks the frame source in `render.render` (`render.cfr` or `smooth.frames`) and the rate (`source.out_rate`). Stabilization belongs in the camera path (`# [DOC: stabilization]` in `camera`), not in the renderer: render only follows `path`.

## Note metadata

`options.metadata` ("Keep original metadata", off by default): the note carries the source's date, place and camera, so iOS Photos can show them after "Save" instead of "No camera information". `tags.py`; `# [DOC: note-metadata]`.

- Read at ingest: `source.probe` calls `tags.read(path, format_tags)` and keeps the result in `meta.tags` (`{key: string}`, `{}` when the source has none; jobs ingested before the field have no key, `tags.kept` and the Mini App treat that as none). Written by `render`: `creation_time` through the encoder's `-metadata` (ffmpeg puts it into `mvhd`, `tkhd`, `mdhd`), the rest by `tags.write(out, tags)` after x264.
- What an iPhone writes (observed with ffprobe and a box dump of the owner's `IMG_0402.MOV`, iPhone SE 2, software 27.2): `moov/meta` (QuickTime form: no version field, `hdlr` `mdta`, `keys`, `ilst`, UTF-8 values) with `com.apple.quicktime.creationdate` (`2026-10-25T23:57:45+0100`, local time with offset), `location.ISO6709` (`+52.3207+021.0548+092.015/`), `location.accuracy.horizontal`, `make`, `model`, `software`, `full-frame-rate-playback-intent` (int); the video `trak/meta` with `camera.lens_model` (`iPhone SE (2nd generation) back camera 3.99mm f/1.8`), `camera.focal_length.35mm_equivalent` (`29`), `camera.lens_irisfnumber` and two `apple-maker-note` ints; four timed metadata tracks (`mebx`: video orientation, detected faces, Live Photo info, segment id). ffprobe (9.0.2) shows only the `moov` keys (format tags), not the `trak/meta` ones, so `tags.read` parses the video trak's `meta` itself.
- Copied (`tags.MOVIE`, `tags.CAMERA`, `creation_time`): the six string keys of `moov/meta` and the three `camera.*` keys, verbatim; ISO 6709 and the creation date keep Apple's exact strings (Photos shows the local time from `creationdate`; `creation_time` is UTC). ffmpeg's `location` (an Android `©xyz`) becomes `location.ISO6709` when the Apple key is absent. Values that ffmpeg reports twice are joined with `;` (observed: `creation_time` of a file written with `use_metadata_tags`); the part before `;` is kept.
- Not copied: `full-frame-rate-playback-intent` (how Photos plays the source), `apple-maker-note` (Apple-private ints), the `mebx` tracks (face boxes and orientation are in source-frame coordinates, wrong after the crop; ffmpeg's mp4 muxer cannot write `mebx`), anything that identifies the original asset (`live-photo-info`, `segment-identifier`, `uuid`, `content.identifier`): reasoned, Photos could pair the note with the original or a Live Photo.
- How it is written: `tags.write` appends a `meta` box in Apple's form (its 34-byte `hdlr`, UTF-8 data type 1, locale 0) to `moov` and the camera keys to the first video `trak`, the same places as the source. `+faststart` puts `moov` before `mdat`, so every `stco` / `co64` offset behind the `moov` grows by the added bytes (the `moov` is built twice: once to measure the growth, once with the shifted offsets), then the file is replaced through `note.mp4.tmp`.
- Rejected: `-movflags use_metadata_tags`. ffmpeg's `movenc.c` (release/8.0, `mov_write_udta_tag`) writes the `mdta` `meta` inside `moov/udta` for mp4 and mov, while iPhones write `moov/meta`; ffmpeg trac #4209 (open since 2015) reports that Apple apps do not show tags written that way. It also writes every global key, `creation_time` and `encoder` included.
- Checked locally (2026-10-26, ffmpeg 9.0.2): a 1080p MOV with the Apple keys set through `use_metadata_tags`, rendered with `metadata` at 640 (and 1080, the retired High resolution): ffprobe reads every key back, `creation_time` lands in `mvhd` and both tracks, the file grows by exactly the `meta` box (545 B), the `framemd5` of both streams equals the render without the option, a `-c copy` remux works; without the option the note has no source tags (as before). On the real `IMG_0402.MOV`: the nine keys plus `creation_time` are read, and the note carries them (`moov/meta` and video `trak/meta`, box dump).
- Owner-confirmed on the iPhone (2026-10-26): the option works, the saved note shows the source's metadata, so iOS Photos reads `moov/meta` in our MP4 (`isom` brand) and Telegram delivers the container metadata.
- Made-here mark (`tags.MARK`, `tags.kept`): with the option on, the note also says it came from this bot. ` (Round from Telegram)` is appended to `com.apple.quicktime.model` (`iPhone SE (2nd generation) (Round from Telegram)`), the device name Photos shows as the camera; a source without a model gets `com.apple.quicktime.software` instead (appended if present, else set to `Round from Telegram`), so even a tagless source carries one tag. Every other tag is copied unchanged. Added in `kept` at render time, so `meta.tags` (what the Mini App sees) stays the source's and jobs ingested earlier get the mark too. Not `camera.lens_model` (the owner's "Back Camera (Round from Telegram)" idea): Photos turns `iPhone SE (2nd generation) back camera 3.99mm f/1.8` into "Back Camera" and the focal length / aperture line, apparently by parsing it, so a suffix there risks losing that line (reasoned); `model` is plain text. Not ffmpeg's `encoder` / `comment`: they land in `udta` (the form Apple apps ignore, see Rejected below). Checked locally (2026-10-26, ffmpeg 9.0.2, CPU render): the note's `moov/meta` carries the marked model, every other key and the `trak/meta` lens key unchanged, video `framemd5` identical to the render without the option; without a model only `software` = `Round from Telegram`; option off: no source tags. Open, owner-testable only: how Photos displays the marked model (whole string, or the lens line suffers).
- Privacy: the location goes to everyone who receives the note. The Mini App hint says so, and the option is off by default.

## High resolution

Experimental again (owner request 2026-10-26): switches `hd720`, `hd1080` and `hevc` let the owner test which notes Telegram keeps a round. History: an earlier `hires` switch rendered up to 1080×1080 and the note arrived as a regular video; its size was not recorded, and a 640 note of 13.2 MB later failed the same way (Note size), so the size may have been the cause, not the side. Now every variant goes through the same 10 MB cap, which isolates the side and the codec.

- `source.out_size`: 1080 with `hd1080` when the short side is at least 1080, else 720 with `hd720` when it is at least 720, else `OUT_SIZE` 640 (`SIDES`, first match wins, so 1080 beats 720). The Mini App enables the rows with the same test. `pipeline` passes the side to `camera.solve` (`out_size`: the window never gets smaller than the output, no upscale), `render` to `crop`, the dither, the encoder and `smooth.frames` (RIFE pads the frame to a multiple of 64: 704 / 832 / 1152).
- `render.codec`: `hevc` picks `X265` (libx265 slow, CRF 20, Main, `-tag:v hvc1`, which Apple players need for HEVC in MP4; g 60), else `X264`. The VBV cap (Note size) and `shrink` use the same codec; libx265 reads `-maxrate` / `-bufsize` as its `vbv-maxrate` / `vbv-bufsize`. The `media.BT709` `setparams` tags the raw input, which libx265 needs (Output encode, trap).
- `MAX_RATE` scales with the side as `(size / 640) ** 1.5` (1080: about 13 Mbit/s), but past a few seconds the 10 MB budget decides, so a long 1080 note gets the same bytes as a 640 one, spread over 2.8× the pixels.
- `transfer.send_note` still declares 640×640 (`DocumentAttributeVideo`, `round_message=True`) whatever the file: the same as the failed 1080 test, so only the file changes between experiments. Untested: declaring the real side.
- Logged as `side` and `codec` in `render.encode` (Stage timings).
- Next, if a test passes: a "smart" pick (the largest side whose expected quality at this duration beats 640), owner request. Until then the switches are manual.

## Lanczos matrix

Why our own renderer: ffmpeg `crop`/`zoompan` move only in whole pixels (2 px on yuv420p). Measured on a 4K dot with a 0.3 px/frame pan: integer crop jumps 0 or 1.0 output px (ideal 0.15, error up to 0.48 px); ours errs at most 0.005 px before encoding. libplacebo would do it, but it needs Vulkan, which the Modal GPU container may not have.
`render.weights` builds, per frame and axis, a dense `size × span` matrix (`size` = the output side) of Lanczos-3 weights. Output pixel j samples source coordinate `c − side/2 + (j + 0.5)·side/size − 0.5` (index space, pixel centres are integers). The kernel is widened by `max(1, side/size)` for antialiasing, rows are normalized. Only the touched rows and columns `[lo, hi)` are uploaded and multiplied: `out = Wy @ img @ Wx.T`. Coordinates float64, matrices float32. Dense matmul wastes the zeros (about 20 taps of 2160) but is a few GFLOP per frame at full tensor speed; a gather/unfold version was rejected for memory (about 350 MB per frame at a 4K window).
Resampling happens in linear light: downscaling in gamma space darkens fine bright detail. The cost is full-window chroma upsampling and per-pixel colour conversion before the matmul. Resampling the Y'CbCr planes separately and converting at 640² would be about 4× cheaper; rejected because it resamples non-linear signals, also before HDR tone mapping. Expect slightly stronger Lanczos halos around highlights; negative ringing is clamped.
Measured (CPU, 6 cores, torch CPU): `frame()` 0.47 s at a 1280 window, 0.86 s at 2160 SDR, 1.16 s at 2160 HLG. GPU estimate (not run): 20–30 ms per frame worst case; the bottleneck is likely software 4K HEVC 10-bit decode and x264 `slower`.

## Chroma siting

`color.up2`/`down2`: 2× polyphase Lanczos-3 as `conv1d` (an `unfold @ w` version was 3–5× slower on CPU because of per-batch copies). Siting is the H.264/HEVC default "left": chroma i sits at luma x = 2i, vertically between rows 2j and 2j+1. `chroma_location` is not read; top-left or centre siting would be off by a quarter chroma pixel. The chroma crop extends 3 samples beyond the luma span, so crop edges are exact. Output 4:2:0 uses the same kernel widened ×2 as an antialiasing filter, not point sampling.

## Linear light

`color.yuv_to_rgb`: matrix from `meta.matrix` (fallback 709 SDR, 2020 HDR), range from `meta.full_range`. 10-bit frames arrive as `yuv420p10le`, read as int16. SDR: BT.1886 gamma 2.4 both ways, so SDR round-trips exactly. PQ: SMPTE ST 2084 EOTF in nits (matches zimg exactly). HLG: BT.2100 inverse OETF, then the OOTF on luminance, `1000 · Ys^0.2 · E` (γ 1.2 for a 1000-nit display); verified on a synthetic clip encoded to the spec (65.8/184.5/17.6 nits vs expected 65.9/184/17.6). zimg differs here: it applies the OOTF per channel.

## HDR tonemap

On the output frame only: BT.2390 EETF in the PQ domain, source peak `HDR_PEAK` 1000 nits (MaxCLL is not read), target `SDR_WHITE` 203 nits (BT.2408 reference white), no black lift. Applied to max(R,G,B) and scaling all channels by the same ratio, which keeps hue. Below about 100 nits the image is untouched; 203-nit white lands at about 0.84 linear. Then BT.2020→709 with a 3×3 matrix and `soft_gamut`: chroma distance d relative to the 709 boundary along the line to grey (luma kept), compressed above `KNEE` 0.9 with tanh; knee 0.8 visibly desaturated pure primaries. SDR sources skip all of this (clamp only).

## Output encode

`color.encode`: BT.1886 inverse, BT.709 Y'CbCr limited, 4:2:0 as above, then a static dither (uniform ±0.5 LSB, fixed seed, the same pattern every frame: temporal noise would cost bitrate). Raw yuv420p 640² goes through a writer thread into x264 (`render.X264`: slower, CRF 16, tune film, High, g 60; maxrate and bufsize from `render.vbv`, Note size; level left to x264, 3.1).
Tags come from `setparams` + `setsar=1`. Decode, GPU work and encode overlap: a reader thread with `DEPTH` reusable buffers and a bounded writer queue; on any exception both ffmpeg processes are killed.
Size per minute: CRF decides, maxrate bounds the worst case, so a minute is at most maxrate × 60 s plus one buffer: ≈ 46 MB (the owner's real 60 fps note averaged 5.4 Mbit/s, ≈ 40 MB/min). Measured (CPU, 2026-10-26; short clips, so the initial VBV buffer lets them run over maxrate): testsrc2 1080p60, 2 s → 1.53 MB (6.0 Mbit/s); the owner's `IMG_0402.MOV` (4K HEVC 60 fps), 1.5 s → 0.82 MB (4.2 Mbit/s). That went over 12 MiB after about 17 s, and Telegram then delivered the note as a regular video (Note size).

## Note size

A note file over the size limit arrives as a regular square video, not a round, even with `round_message=True` and `length=640` (owner, 2026-10-26: job `WKRXzRMgDi`, 18.9 s at 60 fps, 13.2 MB, twice, with and without metadata; the last round that worked, `pRBvJxLSTr` at 00:06, was 8.4 s, 5.7 MB, the same H.264 High 640² 60 fps AAC layout by ffprobe). The exact threshold is not verified: the server config recommends `max_size` 12 MiB (Telegram limits); third-party bot guides say 10 MB (dev-help.postmypost.io, Telegram requirements). `render.vbv` caps the whole file at `NOTE_BYTES` 10 MB with `HEADROOM` 0.97, for every side and codec (High resolution): `maxrate = min(MAX_RATE 6M × (side / 640)^1.5, (budget − audio 128k × dur) / (dur + BUFFER_S 2))`, `bufsize = 2 × maxrate` (x264 VBV bounds the video at about maxrate × dur plus one buffer). CRF 16 still decides below the cap, so short notes are unchanged (≤ 6.7 s keeps maxrate 6M).

- Measured (local ffmpeg, 2026-10-26, re-encoding the 18.9 s note with `render.X264` + `vbv`): 18.9 s → 8.88 MB (maxrate 3.6M); looped to 60 s → 9.61 MB (1.13M), and 9.61 MB with added temporal noise; 5 s with noise → 4.39 MB (6M). So the cap holds even for content x264 cannot compress.
- Cost: a long note gets far fewer bits (60 s at 60 fps: about 1.1 Mbit/s, the level Telegram's own recorder uses at 384 px 30 fps). Levers if that looks bad: a lower rate for long notes (30 fps doubles the bits per frame), or raising `NOTE_BYTES` toward 12 MiB once an owner test shows where the limit is.
- Hard ceiling (owner request 2026-10-26: always a round, never a regular video): VBV is a bound on the average, not a promise, so after the encode `render.shrink` checks the file. Over `NOTE_BYTES`, it re-encodes the note itself (video only, audio copied, same codec settings) with the cap scaled by `SHRINK` 0.95 × limit / size, up to `FIT_TRIES` 3 times, then fails the job rather than send a note that would arrive as a video. Runs before `tags.write`, so the kept metadata is added to the final file. A second generation costs a little quality, but it is only a fallback: no encode in the tests above needed it. Tested by forcing it on the 13.2 MB note: one pass, 13.87 → 6.34 MB (the VBV cap undershoots), H.264 640² 60 fps BT.709 kept.
- Do not raise `MAX_RATE` or drop the cap without a send test on the phone.
Trap: libx265 converted untagged `rawvideo` input to full range. Tag the frames (`setparams ... range=tv`) whenever raw frames go into an encoder.

## Ffmpeg build

Modal image (`app.FFMPEG`): BtbN static build, linux64 gpl n9.0, a month-end autobuild (kept 2 years; daily builds only 14 days), checked by sha256. It has `--enable-libzimg --enable-libx264 --enable-libx265 --enable-libplacebo --enable-vulkan`. The Linux binary was checked by its configure strings, not run yet.

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
- `render.load`: the SAM weights to the GPU; near 0 in a warm container (`@cache`), so it tells a cold start from a warm one. `render.decode` (`frames`, `size` of the tracking frames, `fps`), `render.track` (`fps`), `render.cuts`, `render.camera`, `render.encode` (`fps` of the whole frame loop, `mb` of the note, `rate` of the note, and with interpolation `synth` = RIFE frames, `dupes` = dropped source frames), `render.commit`, `render.send` (login + upload, `speed`), `render` (the whole function, with `clip` length and the source facts).

Keep it to one line per step and only numbers that point to a lever (bandwidth, fps, cold or warm); progress percentages stay in the chat, not in the log.

## Mtproto sessions

`transfer.client(state, name)` logs in with the bot token over MTProto (Telethon, `receive_updates=False`: updates still come through the Bot API webhook) and keeps the session string in the `rounds-state` Dict under `session:<name>`. One session per function (`ingest`, `render`), and each of those functions runs at most one container (`max_containers=1`): the same auth key used from two places at once risks `AUTH_KEY_DUPLICATED`, and a fresh login per job risks `FLOOD_WAIT` on `auth.importBotAuthorization`. Messages are fetched with `get_messages(None, ids=...)`, which calls `messages.getMessages` without a peer (private chats need no access hash); the same call before `send_file` caches the user's access hash so the note can be sent.

## Init data

The Mini App sends `Authorization: tma <initData>`. Validation follows core.telegram.org/bots/webapps: secret key = HMAC-SHA256(key `WebAppData`, message = bot token); the hash is HMAC-SHA256 over the sorted `key=value` lines except `hash`. `auth_date` older than 24 h is refused, and the user must be in `ALLOWED_USER_IDS` and own the job.

## Signed urls

`<video src>` and `<img src>` cannot send headers, so `GET /api/jobs/:id` returns proxy and filmstrip URLs (null while the job has no `proxy`: ingesting, or a failed ingest, which the Mini App shows as "could not be prepared" with `error`) signed with HMAC (a key derived from the bot token, label `Files`) and valid for 6 h. Starlette's `FileResponse` serves HTTP Range requests, which video seeking needs. A file missing in the web container triggers `volume.reload()`, retried up to `RELOADS` times (observed: the first request in a cold container got a 500, `RuntimeError: there are open files preventing the operation`, because a parallel `FileResponse` held a file open; the error is swallowed and the existence check decides) (the ingest container commits before marking the job ready).

## Chat action

Every stage has its own status text (`bot.TEXTS`), edited into one message per phase (ingest: reply to the video; render: a new reply made by the API at the moment of "Render", so the GPU cold start and the model load are not silent). A long step with no progress callback (probe, proxy, decoding, scene cuts, the camera solver) still gets a text of its own, because "silent" was the owner's complaint.

The chat header shows the matching action: `typing` during ingest, `record_video_note` from decoding to the end of the render, `upload_video_note` (Telethon `round`) while the file is sent. A Bot API chat action lasts about 5 s and is dropped as soon as the bot sends a message, so `bot.acting` repeats it every `ACTION_EVERY` = 4 s until the block ends. Failures of `sendChatAction` are swallowed: it is decoration. The `queued` stage has no action: the GPU container is not up yet, so nothing runs the pulse.

The note's file name is the source's with the extension swapped for `.mp4` (`IMG_4359.MOV` → `IMG_4359.mp4`, `round.mp4` if the source has no name), set through `DocumentAttributeFilename` in `transfer.send_note`. Telegram clients do not show it on a round, it surfaces when the note is saved.

Ideas for later modes (owner): "no subject" (a plain centre or a slow auto-crop with nothing to track, so the prompt becomes optional), and more audio and video options next to `loudnorm`. The seams are `Prompt` (its validator `check` demands a selection today), `pipeline.render_job` (the tracking and camera stages are skippable: `camera.solve` only needs a found track) and `options`.

## Telegram limits

Verified in sources (2026-10-25): TDLib rejects a video note `length` over 640 (`td/telegram/MessageContent.cpp`, "Wrong video note length"); the Bot API and TDLib upload the file untouched, the circle size comes from `length` only; the server-recommended `round_video_encoding` is 384 px / 1000 kbps / `max_size` 12 MiB (help.getAppConfig), recommended, not enforced by any client; clients record 384–480 px at 30 fps; expanded on a phone the circle covers about 1000–1340 device pixels, so 640 is visibly better than 480. Bots may use MTProto `upload.getFile` / `upload.saveBigFilePart` (2000 MB).

## Telegram experiment

Done (2026-10-26, owner's test): a 1080×1080 file of unknown size sent with `length=640` arrives as a regular video, not a round (High resolution, now retested under the size cap); the note keeps its metadata (Note metadata).

Done (2026-10-26): a 640² note of 13.2 MB arrives as a regular video (Note size). Open until run (needs the bot token): the exact size threshold (between 5.7 and 13.2 MB), a note longer than 60 s, 720 / 1080 and HEVC under the cap (switches in the Mini App, High resolution); each checked on iOS, Android and Desktop, and the downloaded file hashed against the uploaded one (server re-encoding).
