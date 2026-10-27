import sys

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d

from . import media, smooth
from .config import FPS

# [DOC: stabilization]
SIDE = 480
CORNERS = 600
QUALITY = 0.01
SPACING = 8
LK = {'winSize': (21, 21), 'maxLevel': 3, 'criteria': (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)}
BACK = 1.0
RANSAC = {'method': cv2.RANSAC, 'ransacReprojThreshold': 1.5, 'maxIters': 2000, 'confidence': 0.995}
INLIERS = 24
EXCLUDE = 1.2
SLOW = 0.5
NONE = np.zeros((0, 4), np.float32)
# [DOC: baked-disc]
DISC_IN, DISC_OUT, DISC_FLAT, DISC_SIDES, DISC_SAFE = 0.94, 1.04, 4.0, 16, 0.98


def ring(shape: tuple[int, int], r0: float, r1: float = np.inf) -> np.ndarray:
    h, w = shape
    y, x = np.ogrid[:h, :w]
    rho = np.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / (min(w, h) / 2)
    return (rho >= r0) & (rho < r1)


def flat(img: np.ndarray) -> bool:
    return img.shape[0] == img.shape[1] and img[ring(img.shape, DISC_OUT)].std() < DISC_FLAT


def pair(a: np.ndarray, b: np.ndarray, mask=None) -> np.ndarray:
    p = cv2.goodFeaturesToTrack(a, CORNERS, QUALITY, SPACING, mask=mask)
    if p is None:
        return NONE
    q, ok, _ = cv2.calcOpticalFlowPyrLK(a, b, p, None, **LK)
    back, ok2, _ = cv2.calcOpticalFlowPyrLK(b, a, q, None, **LK)
    good = (ok[:, 0] > 0) & (ok2[:, 0] > 0) & (np.linalg.norm(back - p, axis=2)[:, 0] < BACK)
    return np.hstack([p[good, 0], q[good, 0]])


# [DOC: motion-decode]
def flows(src, meta: dict, start: float, n: int, rate: float, timed: bool) -> dict:
    (w, h), fps = (meta['width'], meta['height']), meta['fps']
    k = min(1.0, SIDE / min(w, h))
    sw, sh = media.even(w * k), media.even(h * k)
    vf = f'scale={sw}:{sh}:flags=area'
    for slow in (False, True):
        if timed:
            proc, stamps = smooth.decode(src, meta, start, n / rate + 2 / fps, 'gray', slow, vf)
        else:
            proc, stamps = media.decode(src, meta, start, n, vf, 'gray', rate, slow), None
        t, pairs, prev, first, mask, ended = [], [], None, None, None, stamps is None
        try:
            for buf in media.reader(proc, sys.maxsize, sw * sh, np.uint8):
                raw = None if ended else stamps.get(timeout=smooth.STAMP_WAIT)
                ended = raw is None
                t.append(smooth.stamp(raw, t[-1] if t else -1 / fps, fps) if timed else len(t) / rate)
                img = buf.reshape(sh, sw)
                if first is None:
                    first = img.copy()
                    mask = ring(img.shape, 0, DISC_IN).astype(np.uint8) * 255 if flat(img) else None
                pairs.append(NONE if prev is None else (pair(prev, img, mask) + 0.5) * np.tile([w / sw, h / sh], 2))
                prev = img.copy()
        finally:
            media.stop(proc)
        if pairs:
            corners = ring(first.shape, DISC_OUT)
            disc = mask is not None and np.abs(prev[corners] - first[corners].astype(float)).mean() < DISC_FLAT
            return {'t': np.asarray(t), 'pairs': pairs, 'disc': bool(disc)}
    return {'t': np.zeros(0), 'pairs': [], 'disc': False}


def _subject(t: float, track: dict | None) -> tuple[float, float, float] | None:
    if not track:
        return None
    j = min(max(round(t * FPS), 0), len(track['present']) - 1)
    c = track['cx'][j], track['cy'][j], track['r'][j]
    return c if track['present'][j] and np.isfinite(c).all() else None


def _step(m: np.ndarray, circle) -> np.ndarray:
    if circle is not None:
        m = m[np.hypot(m[:, 0] - circle[0], m[:, 1] - circle[1]) > EXCLUDE * circle[2]]
    if len(m) < INLIERS:
        return np.eye(3)
    m = np.ascontiguousarray(m, np.float32)
    a, inliers = cv2.estimateAffinePartial2D(m[:, :2].copy(), m[:, 2:].copy(), **RANSAC)
    return np.eye(3) if a is None or inliers.sum() < INLIERS else np.vstack([a, [0, 0, 1]])


def params(flow: dict, size: tuple[int, int], track: dict | None = None, cuts=()) -> np.ndarray:
    bounds, c, acc, out = (np.asarray(cuts, float) - 0.5) / FPS, np.array([size[0] / 2, size[1] / 2, 1]), np.eye(3), []
    for i, (t, m) in enumerate(zip(flow['t'], flow['pairs'], strict=True)):
        if i and not ((bounds > flow['t'][i - 1]) & (bounds <= t)).any():
            acc = acc @ np.linalg.inv(_step(m, _subject(t, track)))
        out.append([*(acc @ c)[:2] - c[:2], np.arctan2(acc[1, 0], acc[0, 0]), np.log(np.hypot(acc[0, 0], acc[1, 0]))])
    return np.asarray(out).reshape(-1, 4)


def matrices(p: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    (cx, cy), s = (size[0] / 2, size[1] / 2), np.exp(p[:, 3])
    a, b = s * np.cos(p[:, 2]), s * np.sin(p[:, 2])
    return np.stack([np.stack([a, -b, cx + p[:, 0] - a * cx + b * cy], -1),
                     np.stack([b, a, cy + p[:, 1] - b * cx - a * cy], -1)], 1)  # fmt: skip


# [DOC: stabilization]
def world(flow: dict, p: np.ndarray, strength: float, size: tuple[int, int], n: int) -> dict:
    t, c0 = flow['t'], np.array(size) / 2
    sigma = SLOW * (len(t) - 1) / max(t[-1] - t[0], 1e-6) if len(t) > 1 else 1
    c = c0 + p[:, :2]
    cs, a, s = (gaussian_filter1d(v, sigma, axis=0, mode='nearest') for v in (c, p[:, 2], p[:, 3]))
    turn = np.stack([np.stack([np.cos(a), np.sin(a)], -1), np.stack([-np.sin(a), np.cos(a)], -1)], 1)
    pivot = cs + np.einsum('kij,kj->ki', turn, c - cs) * np.exp(-s)[:, None] - c0
    p = np.column_stack([pivot, p[:, 2] - a, p[:, 3] - s])
    (w, h), ft = size, np.arange(n) / FPS
    corners = np.array([[0, 0, 1], [w, 0, 1], [w, h, 1], [0, h, 1]], float)
    m = matrices(p, size)
    lerp, quads = np.column_stack([np.interp(ft, t, p[:, i]) for i in range(4)]), corners @ m.transpose(0, 2, 1)
    if flow.get('disc'):
        ang = 2 * np.pi * np.arange(DISC_SIDES) / DISC_SIDES
        u = -np.column_stack([np.cos(ang), np.sin(ang)]) / np.cos(np.pi / DISC_SIDES)
        nrm = np.broadcast_to(u, (len(p), DISC_SIDES, 2)).copy()
        off = (c0 + p[:, :2]) @ u.T - DISC_SAFE * min(size) / 2 * np.exp(p[:, 3:])
    else:
        d = np.roll(quads, -1, 1) - quads
        nrm = np.stack([-d[..., 1], d[..., 0]], -1) / np.linalg.norm(d, axis=-1, keepdims=True)
        nrm *= np.sign(((quads.mean(1, keepdims=True) - quads) * nrm).sum(-1, keepdims=True))
        off = (nrm * quads).sum(-1)
    return {'t': t, 'p': p, 'size': size, 'ft': t * FPS, 'track': matrices(lerp, size), 'nrm': nrm, 'off': off,
            'strength': strength, 'disc': bool(flow.get('disc'))}  # fmt: skip


# [DOC: stabilization]
def placer(at, world: dict):
    t, p, size = world['t'], world['p'], world['size']

    def place(frames) -> np.ndarray:
        rows, s = at(frames), np.atleast_1d(np.asarray(frames, float)) / FPS
        i = np.clip(np.searchsorted(t, s), 1, len(t) - 1)
        q = p[np.where(s - t[i - 1] < t[i] - s, i - 1, i)]
        m = matrices(q, size)
        lin = np.linalg.inv(m[:, :, :2])
        c = np.einsum('kij,kj->ki', lin, rows[:, :2] - m[:, :, 2])
        return np.column_stack([c, rows[:, 2] * np.exp(-q[:, 3]), -q[:, 2]])

    return place
