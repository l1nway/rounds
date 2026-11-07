import numpy as np

from . import media, vittrack
from .config import FPS

# [DOC: device-track]
LONG = 640
KEYS = ('cx', 'cy', 'r', 'area')


def samples(track: dict, meta: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rows = sorted(track['samples'], key=lambda s: s[0])
    t, on = np.array([s[0] for s in rows], float), np.array([len(s) == 5 for s in rows])
    box = np.array([s[1:] if len(s) == 5 else (np.nan,) * 4 for s in rows], float)
    b = box * np.array([meta['width'], meta['height']] * 2)
    bw, bh = b[:, 2] - b[:, 0], b[:, 3] - b[:, 1]
    v = np.column_stack([b[:, 0] + bw / 2, b[:, 1] + bh / 2, np.hypot(bw, bh) / 2, np.nan_to_num(bw * bh)])
    return t, on, v, box


def usable(track: dict | None) -> bool:
    return bool(track) and any(len(s) == 5 for s in track['samples'])


# [DOC: device-track]
def expand(t: np.ndarray, on: np.ndarray, v: np.ndarray, times: np.ndarray) -> dict:
    j = np.clip(np.searchsorted(t, times, side='right') - 1, 0, len(t) - 1)
    k = np.minimum(j + 1, len(t) - 1)
    span = np.where(t[k] > t[j], t[k] - t[j], 1)
    f = np.where(t[k] > t[j], np.clip((times - t[j]) / span, 0, 1), 0)[:, None]
    both, near = on[j] & on[k], np.where(f[:, 0] < 0.5, j, k)
    present = both | on[near]
    value = np.where(both[:, None], v[j] * (1 - f) + v[k] * f, v[near])
    return {'present': present, **{key: np.where(present, value[:, i], np.nan) for i, key in enumerate(KEYS)}}


def rest(src, meta: dict, a: float, b: float, prompt: dict, index: int | None) -> tuple[dict, np.ndarray]:
    frames = media.track_frames(src, meta, a, b, LONG)
    try:
        found = vittrack.track(frames, min(len(frames) - 1, len(frames) - 1 if index is None else index), prompt)
        sx, sy = meta['width'] / frames.shape[2], meta['height'] / frames.shape[1]
        scaled = {'present': found['present'], 'cx': found['cx'] * sx, 'cy': found['cy'] * sy,
                  'r': found['r'] * max(sx, sy), 'area': found['area'] * sx * sy}  # fmt: skip
        return scaled, media.changes(frames)
    finally:
        media.release(frames)


def boxed(box: np.ndarray) -> dict:
    return {'box': box.tolist(), 'points': []}


# [DOC: server-vit]
def full(src, meta: dict, request: dict) -> dict:
    start, end, prompt = request['start'], request['end'], request['prompt']
    index = round((prompt['time'] - start) * FPS)
    found, d = rest(src, meta, start, end, prompt, index)
    return {'found': found, 'cuts': media.scene_cuts(d)}


# [DOC: device-track]
def hit(src, meta: dict, request: dict) -> dict:
    start, end, track = request['start'], request['end'], request.get('track')
    if not usable(track):
        return full(src, meta, request)
    n = media.frame_count(start, end)
    times = start + np.arange(n) / FPS
    t, on, v, box = samples(track, meta)
    found, half = expand(t, on, v, times), 0.5 / track['fps']
    lo = min(int(np.searchsorted(times, t[0] - half)), n - 1)
    hi = max(int(np.searchsorted(times, t[-1] + half, side='right')), lo + 1)
    cuts = [round((c - start) * FPS) for c in track.get('cuts', [])]
    hits = np.flatnonzero(on)
    if hi < n:
        part, d = rest(src, meta, times[hi - 1], end, boxed(box[hits[-1]]), 0)
        for key in found:
            found[key][hi:] = part[key][1 : n - hi + 1]
        cuts += [hi - 1 + c for c in media.scene_cuts(d)]
    if lo > 0:
        part, d = rest(src, meta, start, times[lo] + 1 / FPS, boxed(box[hits[0]]), None)
        for key in found:
            found[key][:lo] = part[key][:lo]
        cuts += media.scene_cuts(d)
    return {'found': found, 'cuts': sorted({c for c in cuts if 0 < c < n})}
