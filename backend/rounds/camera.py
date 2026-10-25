from itertools import pairwise

import numpy as np
import scipy.sparse as sp
from scipy.interpolate import CubicSpline
from scipy.ndimage import gaussian_filter1d
from scipy.optimize import linprog

from .config import FPS, OUT_SIZE

# [DOC: camera-path]
WEIGHTS = (10, 1, 100)
ZOOM_WEIGHT = 8
CENTER = 0.2
FRAMING = 0.5
SAFE_EXIT = 1000
CIRCLE_EXIT = 20000
SAFE = 0.85
FILL = 0.55
SIDES = 8
PAN_SPEED = 0.5
PAN_ACCEL = 1.5
ZOOM_SPEED = 0.12
HAMPEL = 11
JUMP = 2
JUMP_SIZE = 2
SPIKE = 1
GAP_HOLD = 1
GAP_LEAD = 1
STEP = 2
TIME_LIMIT = 30


def _hampel(v):
    k = HAMPEL // 2
    w = np.lib.stride_tricks.sliding_window_view(np.pad(v, k, mode='reflect'), 2 * k + 1)
    med = np.median(w, 1)
    mad = 1.4826 * np.median(np.abs(w - med[:, None]), 1)
    return np.where(np.abs(v - med) > 3 * mad, med, v)


def _clean(on, px, py, r, fps):
    t = np.flatnonzero(on)
    if len(t) > HAMPEL:
        px[t], py[t], r[t] = (_hampel(v[t]) for v in (px, py, r))
    if len(t) < 2:
        return on
    gap, rt = np.diff(t), r[t]
    big, small = np.maximum(rt[1:], rt[:-1]), np.maximum(np.minimum(rt[1:], rt[:-1]), 1e-6)
    jump = (np.hypot(np.diff(px[t]), np.diff(py[t])) > JUMP * big * gap) | ((big > JUMP_SIZE * small) & (gap == 1))
    run = np.r_[0, np.cumsum(jump)]
    lens = np.bincount(run)
    bad = (lens < SPIKE * fps) & (lens < np.maximum(np.r_[0, lens[:-1]], np.r_[lens[1:], 0]))
    on = on.copy()
    on[t[bad[run]]] = False
    return on


def _hold(on, rate):
    hold, t = np.zeros(len(on) - 1, bool), np.flatnonzero(on)
    long = np.diff(t) > GAP_HOLD * rate
    for a, b in zip(t[:-1][long], t[1:][long], strict=True):
        hold[a : max(a, b - round(GAP_LEAD * rate))] = True
    return hold


def _clamp(p, fw, fh, lo):
    z = np.clip(p[:, 2], lo, 1)
    return np.column_stack([np.clip(p[:, 0], z, fw - z), np.clip(p[:, 1], z, fh - z), z])


def _fallback(on, px, py, r, fw, fh, lo, fps):
    n, t = len(on), np.flatnonzero(on)
    if not len(t):
        return np.tile([fw / 2, fh / 2, 1.0], (n, 1))
    c = [gaussian_filter1d(np.interp(np.arange(n), t, v[t]), fps, mode='nearest') for v in (px, py)]
    return _clamp(np.column_stack([*c, np.full(n, np.median(r[t]) / FILL)]), fw, fh, lo)


def _diff(k):
    return sp.diags([-np.ones(k - 1), np.ones(k - 1)], [0, 1], shape=(k - 1, k), format='csr')


def _stack(blocks):
    cols = zip(*[(a, *(np.broadcast_to(v, a.shape[0]) for v in rest)) for a, *rest in blocks], strict=True)
    return [sp.vstack(c) if not i else np.concatenate(c) for i, c in enumerate(cols)]


def _lp(on, px, py, r, fw, fh, lo, rate):
    n, q, dt, sel = len(on), FPS / rate, 1 / rate, np.flatnonzero(on)
    fit, eye, zero = sel[r[sel] < SAFE], sp.identity(n, format='csr'), sp.csr_matrix((n, n))
    x, y, z = (sp.hstack(b, format='csr') for b in ([eye, zero, zero], [zero, eye, zero], [zero, zero, eye]))
    d = [_diff(n), _diff(n - 1) @ _diff(n), _diff(n - 2) @ _diff(n - 1) @ _diff(n)]
    e1, e2 = sp.eye(n - 1, n, format='csr'), sp.eye(n - 2, n, k=1, format='csr')
    held = np.where(_hold(on, rate), 0, np.inf)
    axes = ((x, 1), (y, 1), (z, ZOOM_WEIGHT))
    smooth = [(d[i] @ v, 0, k * w / q**i, np.inf if i else held) for v, k in axes for i, w in enumerate(WEIGHTS)]
    # [DOC: stabilization]
    data = [(x[sel], px[sel], CENTER * q, np.inf), (y[sel], py[sel], CENTER * q, np.inf)]
    a_t, b_eq, w, ub = _stack([*smooth, *data, (z[sel], r[sel] / FILL, FRAMING * q, np.inf)])
    vh, ah, zh = 2 * PAN_SPEED * dt, 2 * PAN_ACCEL * dt**2, ZOOM_SPEED * dt
    caps = ((x, 0, e1, vh), (y, 0, e1, vh), (x, 1, e2, ah), (y, 1, e2, ah), (z, 0, e1, zh))
    # [DOC: edge-fill]
    frame = [(z - x, 0), (x + z, fw), (z - y, 0), (y + z, fh)]
    g0, b0 = _stack([(s * d[o] @ v - c * e @ z, 0) for v, o, e, c in caps for s in (1, -1)] + frame)
    ang = 2 * np.pi * np.arange(SIDES) / SIDES
    ck, ux, uy = np.cos(np.pi / SIDES), np.cos(ang), np.sin(ang)
    sx, sy, sz, m = x[fit], y[fit], z[fit], len(fit)
    inc = [(-a * sx - b * sy - ck * SAFE * sz, -(a * px + b * py + ck * r)[fit]) for a, b in zip(ux, uy, strict=True)]
    gi, bi = _stack([*inc, (-ck * (1 - SAFE) * sz, 0)])
    t, im, pad = len(w), sp.identity(m), sp.csr_matrix
    slack = sp.vstack([sp.hstack([-im, -im])] * SIDES + [sp.hstack([im, pad((m, m))])])
    a_eq = sp.hstack([a_t, -sp.identity(t), sp.identity(t), pad((t, 2 * m))])
    a_ub = sp.vstack([sp.hstack([g0, pad((len(b0), 2 * t + 2 * m))]), sp.hstack([gi, pad((len(bi), 2 * t)), slack])])
    cost = np.r_[np.zeros(3 * n), w, w, np.full(m, SAFE_EXIT * q), np.full(m, CIRCLE_EXIT * q)]
    lb = np.r_[np.zeros(2 * n), np.full(n, lo), np.zeros(2 * t + 2 * m)]
    hb = np.r_[np.full(n, fw), np.full(n, fh), np.ones(n), ub, ub, np.full(2 * m, np.inf)]
    bounds, options = np.column_stack([lb, hb]), {'time_limit': TIME_LIMIT}
    res = linprog(cost, a_ub, np.r_[b0, bi], a_eq, b_eq, bounds, method='highs', options=options)
    return res.x[: 3 * n].reshape(3, n).T if res.status == 0 else None


def _shot(on, px, py, r, fw, fh, lo, fps):
    on, n = _clean(on, px, py, r, fps), len(on)
    t = np.arange(0, n + STEP - 1, STEP)
    idx = np.minimum(t, n - 1)
    p = _lp(on[idx], px[idx], py[idx], r[idx], fw, fh, lo, fps / STEP) if len(t) > 7 and on[idx].any() else None
    if p is None:
        return _fallback(on, px, py, r, fw, fh, lo, fps)
    return _clamp(CubicSpline(t, p)(np.arange(n)), fw, fh, lo)


def solve(track, width, height, cuts=(), fps=FPS, out_size=OUT_SIZE):
    s = min(width, height) / 2
    px, py, r = (np.array(track[k], float) / s for k in ('cx', 'cy', 'r'))
    on = np.asarray(track['present'], bool) & np.isfinite(px + py + r)
    n, lo, fw, fh = len(on), min(out_size / 2, s) / s, width / s, height / s
    edges = np.unique(np.r_[0, [c for c in cuts if 0 < c < n], n]).astype(int)
    shots = [_shot(on[a:b], px[a:b], py[a:b], r[a:b], fw, fh, lo, fps) for a, b in pairwise(edges)]
    return (np.concatenate(shots) if shots else np.zeros((0, 3))) * [s, s, 2 * s]


# [DOC: path-sampler]
def sampler(path, cuts=()):
    n = len(path)
    edges = np.unique(np.r_[0, [c for c in cuts if 0 < c < n], n]).astype(int)
    shots = [(a, b, CubicSpline(np.arange(a, b), path[a:b]) if b - a > 1 else None) for a, b in pairwise(edges)]

    def at(frames) -> np.ndarray:
        frames = np.atleast_1d(np.asarray(frames, float))
        shot, out = np.searchsorted(edges[1:-1], np.round(frames), side='right'), np.empty((len(frames), 3))
        for i, (a, b, spline) in enumerate(shots):
            sel = shot == i
            out[sel] = spline(np.clip(frames[sel], a, b - 1)) if spline else path[a]
        return out

    return at
