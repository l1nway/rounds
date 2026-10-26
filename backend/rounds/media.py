import json
import math
import queue
import subprocess
import tempfile
import threading
from pathlib import Path

import numpy as np

from . import source
from .config import FPS
from .source import run

ZIN = {'hlg': 'arib-std-b67', 'pq': 'smpte2084'}
PROXY_LONG = 960
DEPTH = 4
PROXY_X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-pix_fmt', 'yuv420p']
BT709 = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'
TILES, TILE_H = 24, 96
# [DOC: loudness]
LOUDNORM = 'loudnorm=I=-16:TP=-1:LRA=7'
MEASURED = ('I', 'TP', 'LRA', 'thresh')
GAPLESS = 'aresample=48000:async=1:first_pts=0'
# [DOC: broken-sources]
LENIENT = ['-max_error_rate', '1', '-fflags', '+genpts+discardcorrupt']
AUDIO_TRACK = ['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0']
NO_FRAMES = 'Not a single frame of the video could be decoded'
NO_RANGE = 'No frame of the chosen range could be decoded'


def even(x: float) -> int:
    return max(2, round(x / 2) * 2)


def fit(meta: dict, long_side: int) -> tuple[int, int]:
    k = long_side / max(meta['width'], meta['height'])
    return even(meta['width'] * k), even(meta['height'] * k)


def open_at(src, start: float, slow: bool) -> tuple[list[str], str]:
    if slow:
        return [*LENIENT, '-i', str(src)], f'trim=start={start:.3f},setpts=PTS-{start:.3f}/TB'
    return [*LENIENT, '-ss', f'{start:.3f}', '-i', str(src)], ''


def retrying(make):
    for slow in (False, True):
        frames, got = make(slow), False
        try:
            for frame in frames:
                got = True
                yield frame
        finally:
            frames.close()
        if got:
            return


def video(meta: dict) -> str:
    return f'0:{meta.get("stream", "v:0")}'


def sdr_chain(meta: dict, w: int, h: int) -> str:
    if meta['transfer'] == 'sdr':
        return f'scale={w}:{h}:flags=bicubic:out_range=tv,format=yuv420p,{BT709}'
    # [DOC: proxy-tonemap]
    return (
        f'scale={w}:{h}:flags=bicubic,zscale=tin={ZIN[meta["transfer"]]}:pin=2020:min=2020_ncl:t=linear:npl=100,'
        f'format=gbrpf32le,zscale=p=709,tonemap=tonemap=mobius:desat=0,zscale=t=709:m=709:r=tv,format=yuv420p,{BT709}'
    )


def make_proxy(src, job_dir, meta: dict) -> tuple[dict, dict]:
    job_dir = Path(job_dir)
    w, h = fit(meta, min(PROXY_LONG, max(meta['width'], meta['height'])))
    tw, step = even(TILE_H * meta['width'] / meta['height']), meta['duration'] / TILES
    graph = (
        f'[{video(meta)}]split[v][d];[d]scale={source.THUMB}:{source.THUMB}:flags=area,format=gray[g];'
        f'[v]fps={FPS},{sdr_chain(meta, w, h)},split[p][s];'
        f"[s]select='gte(t,{step}*(selected_n+0.5))',scale={tw}:{TILE_H},tile={TILES}x1[f]"
    )
    audio = ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '96k'] if meta['has_audio'] else []
    with tempfile.TemporaryDirectory() as tmp:
        thumbs = Path(tmp) / 'thumbs.u8'
        try:
            run(['ffmpeg', '-v', 'error', '-y', '-nostdin', *LENIENT, '-i', str(src), '-filter_complex', graph,
                 '-map', '[p]', *PROXY_X264, *audio, '-movflags', '+faststart', str(job_dir / 'proxy.mp4'),
                 '-map', '[f]', '-frames:v', '1', '-q:v', '3', str(job_dir / 'filmstrip.jpg'),
                 '-map', '[g]', '-fps_mode', 'passthrough', '-f', 'rawvideo', str(thumbs)])  # fmt: skip
        except subprocess.CalledProcessError as error:
            if thumbs.exists() and thumbs.stat().st_size:
                raise
            raise source.Unreadable(NO_FRAMES) from error
        share = source.dupes(np.fromfile(thumbs, np.uint8).reshape(-1, source.THUMB, source.THUMB), meta['fps'])
    strip = {'tiles': TILES, 'tile_width': tw, 'tile_height': TILE_H}
    heard = meta['has_audio'] and bool(run([*AUDIO_TRACK, str(job_dir / 'proxy.mp4')]).strip())
    return {'proxy': {'width': w, 'height': h, 'fps': FPS}, 'filmstrip': strip}, {'dupes': share, 'has_audio': heard}


def frame_count(start: float, end: float, rate: float = FPS) -> int:
    return round((end - start) * rate)


# [DOC: cfr-decode]
def decode(src, meta: dict, start: float, n: int, vf: str, pix_fmt: str, rate: float = FPS, slow: bool = False):
    head, cut = open_at(src, start, slow)
    chain = ','.join(x for x in (cut, f'fps={rate}:start_time=0', vf) if x)
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', *head, '-map', video(meta), '-vf', chain, '-frames:v', str(n),
           '-pix_fmt', pix_fmt, '-f', 'rawvideo', 'pipe:1']  # fmt: skip
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=0)


def read_full(f, buf) -> bool:
    view, got = memoryview(buf).cast('B'), 0
    while got < len(view) and (k := f.readinto(view[got:])):
        got += k
    return got == len(view)


def reader(proc, n: int, size: int, dtype):
    free, ready = queue.Queue(), queue.Queue()
    for _ in range(DEPTH):
        free.put(np.empty(size, dtype))

    def run():
        for _ in range(n):
            buf = free.get()
            if not read_full(proc.stdout, buf):
                break
            ready.put(buf)
        ready.put(None)

    threading.Thread(target=run, daemon=True).start()
    while (buf := ready.get()) is not None:
        yield buf
        free.put(buf)


def stop(proc: subprocess.Popen) -> int:
    if proc.poll() is None:
        proc.kill()
    return proc.wait()


def fill(proc: subprocess.Popen, frames, n: int) -> int:
    k = 0
    while k < n and read_full(proc.stdout, frames[k]):
        k += 1
    proc.stdout.close()
    proc.wait()
    if k:
        frames[k:] = frames[k - 1]
    return k


def track_frames(src, meta: dict, start: float, end: float, long_side: int = 1024) -> np.ndarray:
    n, (w, h) = frame_count(start, end), fit(meta, long_side)
    frames = np.memmap(Path(tempfile.mkdtemp()) / 'frames.u8', np.uint8, 'w+', shape=(n, h, w, 3))
    chain = f'{sdr_chain(meta, w, h)},format=rgb24'
    if not any(fill(decode(src, meta, start, n, chain, 'rgb24', slow=slow), frames, n) for slow in (False, True)):
        raise source.Unreadable(NO_RANGE)
    return frames


def histogram(frame: np.ndarray) -> np.ndarray:
    q = frame[::4, ::4] >> 5
    idx = (q[..., 0].astype(np.int32) << 6) | (q[..., 1] << 3) | q[..., 2]
    return np.bincount(idx.ravel(), minlength=512) / idx.size


# [DOC: scene-cuts]
def scene_cuts(frames, window: int = 15, floor: float = 0.3, ratio: float = 3.0, min_shot: int = 6) -> list[int]:
    hists = np.stack([histogram(f) for f in frames])
    d = np.r_[0, np.abs(np.diff(hists, axis=0)).sum(1) / 2]
    cuts = []
    for k in range(1, len(d)):
        local = np.median(np.r_[d[max(1, k - window) : k], d[k + 1 : k + window + 1]]) if len(d) > 2 else 0
        if d[k] > floor and d[k] > ratio * local + 0.05 and k - (cuts[-1] if cuts else 0) >= min_shot:
            cuts.append(k)
    return cuts


# [DOC: audio-chain]
def audio_filter(src, start: float, dur: float, options: dict) -> str:
    if not options.get('loudnorm'):
        return GAPLESS
    cmd = ['ffmpeg', '-v', 'info', '-nostdin', '-hide_banner', *LENIENT, '-ss', f'{start:.3f}', '-t', f'{dur:.3f}',
           '-i', str(src), '-map', '0:a:0', '-af', f'{GAPLESS},{LOUDNORM}:print_format=json',
           '-f', 'null', '-']  # fmt: skip
    err = subprocess.run(cmd, check=True, capture_output=True, text=True).stderr
    m = json.loads(err[err.rindex('{') : err.rindex('}') + 1])
    if not all(math.isfinite(float(m[k])) for k in ('target_offset', *(f'input_{k.lower()}' for k in MEASURED))):
        return GAPLESS
    measured = ':'.join(f'measured_{k}={m[f"input_{k.lower()}"]}' for k in MEASURED)
    return f'{GAPLESS},{LOUDNORM}:{measured}:offset={m["target_offset"]}:linear=false,aresample=48000'


def audio_input(src, meta: dict, start: float, dur: float) -> list[str]:
    return [*LENIENT, '-ss', f'{start:.3f}', '-t', f'{dur:.3f}', '-i', str(src)] if meta['has_audio'] else []
