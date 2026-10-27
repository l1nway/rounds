import contextlib
import json
import re
import subprocess

import numpy as np
from scipy.ndimage import maximum_filter1d

from . import tags
from .config import FPS, MAX_FPS

TRANSFERS = {'arib-std-b67': 'hlg', 'smpte2084': 'pq'}
MATRICES = {'bt2020nc': 'bt2020', 'bt2020c': 'bt2020', 'bt470bg': 'bt601', 'smpte170m': 'bt601', 'bt709': 'bt709'}
PROBE = ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format']
PACKETS = ['ffprobe', '-v', 'error', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0']
RATES = (24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 100, 120, 240)
SNAP, FPS_RANGE = 0.015, (1, 480)
JITTER = 0.25
THUMB, DUP_LEVEL, MOTION, SHARE = 32, 1, 1.0, 0.005
HOLE, HOLE_STEPS, BEFORE, AFTER, CHANGE, MIN_SEGMENT = 0.12, 4, 0.1, 0.3, 1.0, 0.5
_r = np.arange(THUMB) + 0.5 - THUMB / 2
DISC = np.hypot(*np.meshgrid(_r, _r)) <= THUMB / 2


# [DOC: broken-sources]
class Unreadable(ValueError):
    pass


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def fraction(text: str | None) -> float:
    num, _, den = (text or '0').partition('/')
    with contextlib.suppress(ValueError, ZeroDivisionError):
        return float(num) / float(den or 1)
    return 0.0


def snap(fps: float) -> float:
    near = min(RATES, key=lambda r: abs(r - fps))
    return near if abs(near - fps) <= SNAP * near else round(fps, 3)


# [DOC: source-cadence]
def cadence(path, stream: int) -> tuple[float, float, float]:
    out = run([*PACKETS, '-select_streams', str(stream), str(path)])
    t = np.unique([float(x) for x in re.findall(r'^(-?\d+(?:\.\d+)?)', out, re.M)])
    if len(t) < 3:
        return 0.0, 0.0, 0.0
    d = np.diff(t)
    step = float(np.median(d))
    gaps = (d[d > (1 + JITTER) * step] / step - 1).sum() / len(t)
    return 1 / step, round(float(gaps), 4), float(t[-1] - t[0] + step)


def probe(path) -> dict:
    try:
        info = json.loads(run([*PROBE, str(path)]))
    except subprocess.CalledProcessError as error:
        raise Unreadable('The file is damaged or incomplete and cannot be opened') from error
    streams = info['streams']
    videos = [s for s in streams if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')]
    if not videos:
        raise Unreadable('The file has no video track')
    v = videos[0]
    sides = [s['rotation'] for s in v.get('side_data_list', []) if 'rotation' in s]
    rot = int(float(sides[0] if sides else v.get('tags', {}).get('rotate', 0)))
    w, h = (v['height'], v['width']) if rot % 180 else (v['width'], v['height'])
    nominal, gaps, span = cadence(path, v['index'])
    listed = fraction(v.get('avg_frame_rate')) or fraction(v.get('r_frame_rate'))
    fps = next((x for x in (nominal, listed) if FPS_RANGE[0] <= x <= FPS_RANGE[1]), FPS)
    duration = float(info['format'].get('duration') or v.get('duration') or span)
    if not duration > 0:
        raise Unreadable('Could not read the length of the video')
    pix = v.get('pix_fmt', 'yuv420p')
    return {
        'duration': duration,
        'fps': snap(fps),
        'gaps': gaps,
        'width': w,
        'height': h,
        'rotation': rot,
        'transfer': TRANSFERS.get(v.get('color_transfer'), 'sdr'),
        'bit_depth': int(m[1]) if (m := re.search(r'p(\d+)', pix)) else 8,
        'has_audio': any(s['codec_type'] == 'audio' for s in streams),
        'codec': v['codec_name'],
        'matrix': MATRICES.get(v.get('color_space'), ''),
        'full_range': v.get('color_range') == 'pc' or pix.startswith('yuvj'),
        'stream': v['index'],
        'tags': tags.read(path, info['format'].get('tags', {})),
    }


# [DOC: output-rate]
def interpolable(meta: dict) -> bool:
    return meta['fps'] < MAX_FPS - 0.01 or meta.get('gaps', 0) >= SHARE or meta.get('dupes', 0) >= SHARE


def interpolating(meta: dict, options: dict) -> bool:
    return bool(options.get('interpolate') and meta.get('interpolable'))


def out_rate(meta: dict, options: dict) -> float:
    return MAX_FPS if interpolating(meta, options) else min(meta['fps'], MAX_FPS)


# [DOC: duplicate-frames]
def dupes(thumbs: np.ndarray, fps: float) -> float:
    if len(thumbs) < 3:
        return 0.0
    d = np.abs(np.diff(thumbs.astype(np.int16), axis=0)).reshape(len(thumbs) - 1, -1)
    near = maximum_filter1d(d.mean(1), 2 * max(1, round(fps / 2)) + 1)
    return round(float(np.mean((d.max(1) <= DUP_LEVEL) & (near >= MOTION))), 4)


def counts(p: np.ndarray, bins: int) -> np.ndarray:
    flat = (p.reshape(len(p), -1).astype(np.int64) + np.arange(len(p))[:, None] * bins).ravel()
    return np.bincount(flat, minlength=len(p) * bins).reshape(len(p), bins)


def looks(f: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    v = f[:, 0][:, DISC].astype(np.float32)
    shape = (v - v.mean(1, keepdims=True)) / (v.std(1, keepdims=True) + 4)
    return shape, np.concatenate([counts(f[:, 0] >> 4, 16), counts(f[:, 1] >> 5, 8), counts(f[:, 2] >> 5, 8)], 1)


def change(f: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    (ya, ha), (yb, hb) = looks(f[a]), looks(f[b])
    return 1 - np.mean(ya * yb, 1) + np.abs(ha - hb).sum(1) / (3 * THUMB**2)


# [DOC: segment-cuts]
def switches(frames: np.ndarray, stamps: np.ndarray, duration: float) -> list[float]:
    n = min(len(frames), len(stamps))
    f, t = frames[:n], stamps[:n]
    if n < 3:
        return []
    k = np.nonzero(np.diff(t) >= max(HOLE, HOLE_STEPS * float(np.median(np.diff(t)))))[0] + 1
    if not len(k):
        return []
    a, b = np.searchsorted(t, t[k - 1] - BEFORE), np.minimum(n - 1, np.searchsorted(t, t[k] + AFTER))
    at = np.where(change(f, k - 1, b) < change(f, k - 1, a), t[k - 1], t[k])[change(f, a, b) >= CHANGE]
    kept = []
    for c in at:
        if c - (kept[-1] if kept else 0) >= MIN_SEGMENT and duration - c >= MIN_SEGMENT:
            kept.append(round(float(c), 3))
    return kept
