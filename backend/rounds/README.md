# rounds (backend package)

One Modal app (`app.py`) that receives the source video, serves the Mini App and renders the video note. Every module below is owned by one concern; the contracts in this file are what the modules agree on, so a change to a contract updates this file and every side in the same step.

## Files

| File | Concern | Runs in |
|---|---|---|
| `app.py` | Modal app: images, Volume, Dict, secret, functions (`web`, `ingest`, `setup`), the `Render` class (`warm`, `prepare`, `run`) and the `Lift` class | — |
| `config.py` | env (from the `rounds` secret) and shared constants | everywhere |
| `api.py` | FastAPI: Telegram webhook, Mini App API, `initData` auth, signed file URLs | `web` |
| `bot.py` | aiogram handlers: accept videos, Mini App button, progress messages | `web`, `ingest`, `render` |
| `transfer.py` | MTProto (Telethon) download of the source | `ingest` |
| `pipeline.py` | job orchestration: `ingest_job`, `render_job`, progress, stage timings | `ingest`, `Render` |
| `locate.py` | where the object is: decode → track → scene changes, the track cache, `prepare_job`, the camera path of a job (Track cache) | `Render` |
| `source.py` | the source: ffprobe, frame cadence (gaps), duplicate frames, output rate | `ingest`, `render` |
| `media.py` | proxy + filmstrip, frame decode, tracking frames, scene cuts | `ingest`, `render` |
| `audio.py` | the note's audio chain: noise reduction (DeepFilterNet3), loudness | `render` |
| `render.py` | GPU renderer: subpixel crop + resample + colour pipeline → raw frames for `encode` | `render` |
| `encode.py` | note encoder: codecs, two passes to the size budget, audio, fit loop | `render` |
| `upscale.py` | AI upscale of a small source to 640 (SeedVR2 3B, code in the GPU image, weights in `rounds-models`) | `render` |
| `smooth.py` | 60 fps interpolation: timed decode, duplicate drop, retiming with RIFE | `render` |
| `seam.py` | seams over holes in the source: time remap, blurred dissolve | `render` |
| `rife.py` | RIFE 4.25 network, vendored (MIT, `RIFE-LICENSE`) | `render` |
| `repair.py` | AI repair of the HDR slider: FastDVDnet denoise + Zero-DCE++ low-light curve over the frame stream (Repair) | `render`, `Lift` |
| `fastdvdnet.py` | FastDVDnet network, vendored (MIT, `FASTDVDNET-LICENSE`) | `render`, `Lift` |
| `zerodce.py` | Zero-DCE++ network and curve, vendored (CC BY-NC 4.0, `ZERODCE-LICENSE`) | `render`, `Lift` |
| `color.py` | torch colour pipeline: YUV↔RGB, transfer functions, HDR→SDR, chroma resampling | `render` |
| `look.py` | HDR look: local tone mapping, clipped-channel rebuild, smart exposure (Look) | `render`, `Lift` |
| `track.py` | object tracking (SAM 2.1 video, HF transformers) | `render` |
| `follow.py` | track preview: the selected object's box over the trim range on the proxy (SAM 2.1 video) | `Lift` |
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

Later step (owner: honest pixels first, an unnoticeable fill where the circle leaves the frame, maybe an AI outpainting model): let the window leave the frame for a subject at the frame edge, at a high cost, so the render stage fills the outside. Plug-in points: `# [DOC: edge-fill]` in `camera._lp`, where the window is held inside the frame (`x − h ≥ 0`, `x + h ≤ W`, same for y), and in `render`, where samples outside the frame are clamped today. Plan: give each of the four rows a slack with a cost between `SAFE_EXIT` and `CIRCLE_EXIT`, widen the variable bounds on `x, y`, keep `_clamp` in `_shot` and `_fallback` in sync, and fill the outside in `render`. Today a subject in a corner stays outside the safe circle 100 % of the time (measured: +0.52h; the best window inside the frame is still about +0.57h at the worst frame).

## Stabilization

Later option for shaky handheld sources: compensate global camera motion. Plug-in point: `# [DOC: stabilization]` in `camera._lp`, next to the data term. Plan: estimate a per-frame global transform (feature tracks or optical flow in `media`), express the subject positions and the smoothness terms in stabilised coordinates and the frame-bound rows in source coordinates via the per-frame transform (Grundmann et al., Section 3); `render` then warps instead of cropping. Today the smoothness terms smooth only the virtual camera, not the shake already in the source.

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

`app.RIFE`: `flownet_v4.25.pkl` from the vs-rife GitHub release `model` (the official links are Google Drive and Baidu, unreliable in an image build), checked by sha256 and baked into the GPU image at `config.RIFE_WEIGHTS`. 24.6 MB, torch zip format, loaded with `weights_only=True`. Not checked: that the release file is byte-identical to the archive on Practical-RIFE's Drive.

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

The binary: `deep-filter` 0.5.6 (Rikorose/DeepFilterNet, MIT / Apache-2.0, the DeepFilterNet3 model embedded), the static `x86_64-unknown-linux-musl` release asset, fetched in the GPU image build (`app.VOICE`, sha256-pinned) to `config.DEEP_FILTER`. The Python package was rejected: `deepfilternet` 0.5.6 (the last, 2023-08-31) needs numpy < 2, `deepfilterlib` has wheels up to cp311 only. Provenance, checked 2026-10-26: the release assets were uploaded by the maintainer's account, not by CI (no workflow of v0.5.6 builds them), unchanged since 2023-08-31; the musl binary is not stripped and holds no socket / exec / fork symbol; its crates are tract (ONNX), hound, rubato, tar / flate2, clap, env_logger, nothing networked; the Windows build of the same release imports no network DLL and Defender found nothing. Building from source in the image would remove the trust in the uploaded file; not done (Rust toolchain + tract compile in the image build).

- Measured locally (2026-10-26, 15 s from 1.0 s, 50 ms windows p5 / p90 in dB, Windows build of the same release): IMG_4042 −51 / −27 → atten 12 dB −63 / −28, no limit −120 / −29; 5670FAB1 −63 / −30 → no limit −120 / −35. With loudnorm every strength lands at −16 ± 0.7 LUFS. Duration unchanged (15.000 s).
- Time: DeepFilterNet ran at about 3 × real time for stereo on the owner's PC (5 s per 15 s); on the 8-CPU render container not measured. It runs inside `second_pass` after the frame loop, so the progress bar waits at `FRAMES_SHARE` meanwhile.
- Not verified: how each strength sounds (judge on the phone); the time on Modal.

## Render options

`encode.second_pass` is the seam: audio options (`loudnorm`, `denoise`) go through `audio.chain` (computed once, before the fit loop). `options.metadata` adds `creation_time` to the encoder and `tags.write` after it (Note metadata). `options.zoom` goes to `camera.solve` in `pipeline.render_job` (Zoom option). `options.interpolate` picks the frame source in `render.render` (`render.cfr` or `smooth.frames`) and the rate (`source.out_rate`). `options.look` and `options.exposure` build one `look.Look` per render, handed to `render.crop` through the `cut` partial, so both frame sources get it before RIFE (Look). Stabilization belongs in the camera path (`# [DOC: stabilization]` in `camera`), not in the renderer: render only follows `path`.

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

The AI part of the HDR slider (`r` of `look.split`, Look zones), for old, cheap, dark and noisy phone videos; owner approved both models 2026-10-26. `repair.py`; `render.render` wraps the frame source (`cfr`, or `smooth.frames` after RIFE) in `repair.frames` when `r > 0`, before `upscale.frames`, so SeedVR2 gets the cleaned frames. Frames in and out are linear SDR [0, 1] `(3, S, S)` on the device, same count and order; both networks run in gamma (`v = lin^(1/2.4)`, plain video pixels, what they were trained on) and the result goes back to linear.

1. FastDVDnet (Tassano, Delon, Veit, CVPR 2020; `fastdvdnet.py`, `model.pth`, trained for AWGN σ 5–55): two stages of the same U-Net (`DenBlock`) over 5 frames with a noise map; σ = `r × SIGMA_MAX`, a uniform map. Sides are reflect-padded to a multiple of 4 (`ALIGN`) and cropped back. A stage-1 output (`temp1` over a triplet) is computed once per centre frame and fed to three stage-2 calls (`repair.triples`, `repair.stage`): 2 `DenBlock`s per frame instead of 4. The ends are replicated (upstream reflects): the first output sees x0, x0, x0, x1, x2. The stream holds two frames of lookahead.
2. Zero-DCE++ (Li, Guo, Loy, TPAMI 2021; `zerodce.py`, `Epoch99.pth`): α maps from the frame downscaled by `SCALE` 12 (as its `lowlight_test.py`), then 8 curve steps `x += α(x² − x)`. Two changes from upstream, both from the contact sheets: one map (the mean of the three) applied to max(R, G, B) with every channel scaled by the same ratio, as in HDR tonemap (upstream's per-channel curve turned dark faces pink and washed colours out); and α × r × `LIFT` 0.5 (the full curve on top of the honest lift flattened faces to white). The low-resolution map is smoothed over time (EMA, `TAU` 0.5 s at the output rate, starting from the first frame's map) so the brightness does not pump. The EMA is in frame coordinates: a fast pan smears the map for a moment (low frequency; not seen in the tests).

- Tuned by eye (2026-10-26, 640² crops of IMG_7045 and IMG_1037, sheets at σ 0 / 10 / 15 / 20 / 25 / 30 / 45 and look 0.4 / 0.6 / 0.8 / 1.0): `SIGMA_MAX` 15/255. The suggested 25–35 turned faces and curls to plastic; already 10 smooths these sources visibly, because their noise is mostly compression, not sensor grain. A grainier source may want more: owner to judge. `model_clipped_noise.pth` (same repo) was a little smoother and darker in the shadows; not used. Running the curve before the denoiser looked about the same; denoise first was kept.
- Numbers (CPU, 15 consecutive frames mid-clip, gamma levels 0..255; r 0 → 1): mean R/G 1.43 → 1.46 and B/G 0.765 → 0.758 (IMG_7045), 1.135 → 1.148 and 0.918 → 0.924 (IMG_1037): no visible colour shift. Mean frame-to-frame difference 5.19 → 5.91 (IMG_7045) and 5.04 → 5.00 (IMG_1037) while the mean level rises by 33 % and 44 %, so relative to the level it falls (7.9 → 6.7 %, 8.7 → 6.0 %); the frame-mean jitter grows only with the level (1.31 → 1.25 %, 1.11 → 1.04 % of it): no added flicker.
- Checks: strict loads; 2 479 096 parameters (FastDVDnet, plus the BatchNorm running stats) and 10 561 (Zero-DCE++); outputs identical to the upstream definitions on random input (max difference 0.0, CPU); the stream returns n frames for n = 0, 1, 2, 12; odd sizes (482×270) come back unpadded. `render.render` end to end on CPU (IMG_7045, 8–10 s, look 0.8, AV1, still camera): 60 of 60 frames, a 640² AV1 note of 3.7 MB, 312 s in all (the frame loop with repair dominates).
- Time: measured on CPU (6 threads, torch 2.14): one `DenBlock` 1.19 s at 640², the stream 2.8–4.5 s per frame, Zero-DCE++ with the curve 69 ms. L4: not measured; estimate (about 65 GMAC per `DenBlock` at 640², two per frame, fp16) 15–40 ms per frame, so 1–2.5 min more for a 60 s note at 60 fps. Zero-DCE++ runs in fp32 (tiny at 53²; the curve at full size in fp32).
- Licences: FastDVDnet MIT (its `LICENSE`, "Copyright 2024 Matias Tassano"). Zero-DCE++: the repository has no licence file; its README says "The code is made available for academic research purpose only. Under Attribution-NonCommercial 4.0 International License." This bot is personal and non-commercial, which CC BY-NC allows; "academic research purpose only" is narrower, and the owner accepted it (2026-10-27) because the project is personal and non-commercial, and keeps StableLLVE (MIT) in mind as a replacement if the result or the licence becomes a problem. Never use the bot commercially with Zero-DCE++ in it. Notices in `FASTDVDNET-LICENSE` and `ZERODCE-LICENSE`.
- Why two vendored files: they carry different licences (MIT and CC BY-NC), so the CC BY-NC code stays in its own file.

## Repair weights

`app.REPAIR`: `model.pth` (9 971 551 B, sha256 `9d9d8413…5d2a17`) from m-tassano/fastdvdnet at commit `c8fdf618`, and `Epoch99.pth` (52 395 B, sha256 `ca8855b9…7f3b84`) from Li-Chongyi/Zero-DCE_extension at commit `09f202b6`, fetched from raw.githubusercontent.com at the pinned commits, sha256-checked and baked into the GPU image at `config.DVD_WEIGHTS` and `config.DCE_WEIGHTS` by `app.fetch` (the same two commands as the RIFE weights and `deep-filter`). Hashes computed 2026-10-26 from both a git clone and the raw URLs (identical; the files are plain blobs, not Git LFS). The FastDVDnet checkpoint was saved from `DataParallel`: `fastdvdnet.load` strips `module.`. Both are legacy pickles, loaded with `weights_only=True` and `map_location='cpu'` (they hold CUDA storages).

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

The Mini App sends `Authorization: tma <initData>`. Validation follows core.telegram.org/bots/webapps: secret key = HMAC-SHA256(key `WebAppData`, message = bot token); the hash is HMAC-SHA256 over the sorted `key=value` lines except `hash`. `auth_date` older than 24 h is refused, and the user must be in `ALLOWED_USER_IDS` and own the job.

## Signed urls

`<video src>` and `<img src>` cannot send headers, so `GET /api/jobs/:id` returns proxy and filmstrip URLs (null while the job has no `proxy`: ingesting, or a failed ingest, which the Mini App shows as "could not be prepared" with `error`) signed with HMAC (a key derived from the bot token, label `Files`) and valid for 6 h. Starlette's `FileResponse` serves HTTP Range requests, which video seeking needs. A file missing in the web container triggers `volume.reload()`, retried up to `RELOADS` times (observed: the first request in a cold container got a 500, `RuntimeError: there are open files preventing the operation`, because a parallel `FileResponse` held a file open; the error is swallowed and the existence check decides) (the ingest container commits before marking the job ready).

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
- Not verified yet (owner's phone): that a note sent this way arrives as a round on iOS and Desktop, as the MTProto one did.

## Telegram limits

Verified in sources (2026-10-25): TDLib rejects a video note `length` over 640 (`td/telegram/MessageContent.cpp`, "Wrong video note length"); the Bot API and TDLib upload the file untouched, the circle size comes from `length` only; the server-recommended `round_video_encoding` is 384 px / 1000 kbps / `max_size` 12 MiB (help.getAppConfig), recommended, not enforced by any client; clients record 384–480 px at 30 fps; expanded on a phone the circle covers about 1000–1340 device pixels, so 640 is visibly better than 480. Bots may use MTProto `upload.getFile` / `upload.saveBigFilePart` (2000 MB).

## Telegram experiment

Done (2026-10-26, owner's test): 720 and 1080 notes arrive as regular videos, not rounds, even under the 10 MB cap (High resolution); the note keeps its metadata (Note metadata).

Done (2026-10-26): a 640² note of 13.2 MB arrives as a regular video (Note size). Owner (2026-10-26): a 640 HEVC note works, so HEVC became the default (Codecs). Done (2026-10-26): AV1 and VP9 notes of 12.8 s that filled the 12 000 000 B budget arrived as regular videos (they played on iOS 18); an H.266 note was not sent as a round and played neither on iOS nor on Desktop. The budget went back to 10 000 000 B (Note size), and AV1 and VP9 notes under it stayed rounds and played on iOS (owner, 2026-10-26); H.266 was dropped (Codecs). An upscaled note looked right on the phone (owner's IMG_4042). Open: AV1 and VP9 notes on Desktop and Android; the exact size threshold (between 10 and about 11.6 MB), a note longer than 60 s; each checked on iOS, Android and Desktop, and the downloaded file hashed against the uploaded one (server re-encoding).
