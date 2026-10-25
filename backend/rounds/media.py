import json
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from .config import FPS

TRANSFERS = {'arib-std-b67': 'hlg', 'smpte2084': 'pq'}
MATRICES = {'bt2020nc': 'bt2020', 'bt2020c': 'bt2020', 'bt470bg': 'bt601', 'smpte170m': 'bt601', 'bt709': 'bt709'}
ZIN = {'hlg': 'arib-std-b67', 'pq': 'smpte2084'}
PROXY_LONG = 960
PROXY_X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15', '-pix_fmt', 'yuv420p']
BT709 = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'
TILES, TILE_H = 24, 96
LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11'
PROBE = ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format']


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def even(x: float) -> int:
    return max(2, round(x / 2) * 2)


def fit(meta: dict, long_side: int) -> tuple[int, int]:
    k = long_side / max(meta['width'], meta['height'])
    return even(meta['width'] * k), even(meta['height'] * k)


def probe(path) -> dict:
    info = json.loads(run([*PROBE, str(path)]))
    streams = info['streams']
    v = next(s for s in streams if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic'))
    sides = [s['rotation'] for s in v.get('side_data_list', []) if 'rotation' in s]
    rot = int(float(sides[0] if sides else v.get('tags', {}).get('rotate', 0)))
    w, h = (v['height'], v['width']) if rot % 180 else (v['width'], v['height'])
    num, den = (v.get('avg_frame_rate') or v['r_frame_rate']).split('/')
    pix = v.get('pix_fmt', 'yuv420p')
    return {
        'duration': float(info['format'].get('duration') or v['duration']),
        'fps': int(num) / int(den) if int(den) else FPS,
        'width': w,
        'height': h,
        'rotation': rot,
        'transfer': TRANSFERS.get(v.get('color_transfer'), 'sdr'),
        'bit_depth': int(m[1]) if (m := re.search(r'p(\d+)', pix)) else 8,
        'has_audio': any(s['codec_type'] == 'audio' for s in streams),
        'codec': v['codec_name'],
        'matrix': MATRICES.get(v.get('color_space'), ''),
        'full_range': v.get('color_range') == 'pc' or pix.startswith('yuvj'),
    }


def sdr_chain(meta: dict, w: int, h: int) -> str:
    if meta['transfer'] == 'sdr':
        return f'scale={w}:{h}:flags=bicubic:out_range=tv,format=yuv420p,{BT709}'
    # [DOC: proxy-tonemap]
    return (
        f'scale={w}:{h}:flags=bicubic,zscale=tin={ZIN[meta["transfer"]]}:pin=2020:min=2020_ncl:t=linear:npl=100,'
        f'format=gbrpf32le,zscale=p=709,tonemap=tonemap=mobius:desat=0,zscale=t=709:m=709:r=tv,format=yuv420p,{BT709}'
    )


def make_proxy(src, job_dir, meta: dict) -> dict:
    job_dir = Path(job_dir)
    w, h = fit(meta, min(PROXY_LONG, max(meta['width'], meta['height'])))
    tw, step = even(TILE_H * meta['width'] / meta['height']), meta['duration'] / TILES
    graph = (
        f'[0:v:0]fps={FPS},{sdr_chain(meta, w, h)},split[p][s];'
        f"[s]select='gte(t,{step}*(selected_n+0.5))',scale={tw}:{TILE_H},tile={TILES}x1[f]"
    )
    audio = ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '96k'] if meta['has_audio'] else []
    run(['ffmpeg', '-v', 'error', '-y', '-nostdin', '-i', str(src), '-filter_complex', graph,
         '-map', '[p]', *PROXY_X264, *audio, '-movflags', '+faststart', str(job_dir / 'proxy.mp4'),
         '-map', '[f]', '-frames:v', '1', '-q:v', '3', str(job_dir / 'filmstrip.jpg')])  # fmt: skip
    strip = {'tiles': TILES, 'tile_width': tw, 'tile_height': TILE_H}
    return {'proxy': {'width': w, 'height': h, 'fps': FPS}, 'filmstrip': strip}


def frame_count(start: float, end: float) -> int:
    return round((end - start) * FPS)


# [DOC: cfr-decode]
def decode(src, start: float, n: int, vf: str, pix_fmt: str) -> subprocess.Popen:
    chain = ','.join(x for x in (f'fps={FPS}:start_time=0', vf) if x)
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{start:.3f}', '-i', str(src), '-map', '0:v:0', '-vf', chain,
           '-frames:v', str(n), '-pix_fmt', pix_fmt, '-f', 'rawvideo', 'pipe:1']  # fmt: skip
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=0)


def read_full(f, buf) -> bool:
    view, got = memoryview(buf).cast('B'), 0
    while got < len(view) and (k := f.readinto(view[got:])):
        got += k
    return got == len(view)


def fill(proc: subprocess.Popen, frames, n: int) -> int:
    k = 0
    while k < n and read_full(proc.stdout, frames[k]):
        k += 1
    proc.stdout.close()
    proc.wait()
    if not k:
        raise RuntimeError(f'no frames decoded (ffmpeg exit {proc.returncode})')
    frames[k:] = frames[k - 1]
    return k


def track_frames(src, meta: dict, start: float, end: float, long_side: int = 1024) -> np.ndarray:
    n, (w, h) = frame_count(start, end), fit(meta, long_side)
    frames = np.memmap(Path(tempfile.mkdtemp()) / 'frames.u8', np.uint8, 'w+', shape=(n, h, w, 3))
    fill(decode(src, start, n, f'{sdr_chain(meta, w, h)},format=rgb24', 'rgb24'), frames, n)
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
        return 'aresample=48000'
    cmd = ['ffmpeg', '-v', 'info', '-nostdin', '-hide_banner', '-ss', f'{start:.3f}', '-t', f'{dur:.3f}',
           '-i', str(src), '-map', '0:a:0', '-af', f'{LOUDNORM}:print_format=json', '-f', 'null', '-']  # fmt: skip
    err = subprocess.run(cmd, check=True, capture_output=True, text=True).stderr
    m = json.loads(err[err.rindex('{') : err.rindex('}') + 1])
    measured = ':'.join(f'measured_{k}={m[f"input_{k.lower()}"]}' for k in ('I', 'TP', 'LRA', 'thresh'))
    return f'{LOUDNORM}:{measured}:offset={m["target_offset"]}:linear=true,aresample=48000'


def audio_input(src, meta: dict, start: float, dur: float) -> list[str]:
    return ['-ss', f'{start:.3f}', '-t', f'{dur:.3f}', '-i', str(src)] if meta['has_audio'] else []
