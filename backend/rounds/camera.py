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
# [DOC: stabilization]
STAB_CROP = 0.2
EDGE_EXIT = 300, 0.3
CROP_SHARE = 0.5


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


def _clamp(p, box, lo):
    z = np.clip(p[:, 2], lo, 1)
    if box is None:
        return np.column_stack([p[:, :2], z])
    return np.column_stack([np.clip(p[:, 0], z, box[0] - z), np.clip(p[:, 1], z, box[1] - z), z])


def _fallback(on, px, py, r, centre, box, lo, fps):
    n, t = len(on), np.flatnonzero(on)
    if not len(t):
        return _clamp(np.column_stack([gaussian_filter1d(centre, fps, axis=0, mode='nearest'), np.ones(n)]), box, lo)
    c = [gaussian_filter1d(np.interp(np.arange(n), t, v[t]), fps, mode='nearest') for v in (px, py)]
    return _clamp(np.column_stack([*c, np.full(n, np.median(r[t]) / FILL)]), box, lo)


def _diff(k):
    return sp.diags([-np.ones(k - 1), np.ones(k - 1)], [0, 1], shape=(k - 1, k), format='csr')


def _stack(blocks):
    cols = zip(*[(a, *(np.broadcast_to(v, a.shape[0]) for v in rest)) for a, *rest in blocks], strict=True)
    return [sp.vstack(c) if not i else np.concatenate(c) for i, c in enumerate(cols)]


def _lp(on, px, py, r, box, lo, rate, zoom, edge):
    n, q, dt, sel = len(on), FPS / rate, 1 / rate, np.flatnonzero(on)
    fit, eye, zero = sel[r[sel] < SAFE], sp.identity(n, format='csr'), sp.csr_matrix((n, n))
    x, y, z = (sp.hstack(b, format='csr') for b in ([eye, zero, zero], [zero, eye, zero], [zero, zero, eye]))
    d = [_diff(n), _diff(n - 1) @ _diff(n), _diff(n - 2) @ _diff(n - 1) @ _diff(n)]
    e1, e2 = sp.eye(n - 1, n, format='csr'), sp.eye(n - 2, n, k=1, format='csr')
    held = np.where(_hold(on, rate), 0, np.inf) if edge is None else np.inf
    axes = ((x, 1), (y, 1), (z, ZOOM_WEIGHT))
    smooth = [(d[i] @ v, 0, k * w / q**i, np.inf if i else held) for v, k in axes for i, w in enumerate(WEIGHTS)]
    data = [(x[sel], px[sel], CENTER * q, np.inf), (y[sel], py[sel], CENTER * q, np.inf)]
    framing = [(z[sel], r[sel] / FILL, FRAMING * q, np.inf)] if zoom else []
    a_t, b_eq, w, ub = _stack([*smooth, *data, *framing])
    vh, ah, zh = 2 * PAN_SPEED * dt, 2 * PAN_ACCEL * dt**2, ZOOM_SPEED * dt
    caps = ((x, 0, e1, vh), (y, 0, e1, vh), (x, 1, e2, ah), (y, 1, e2, ah), (z, 0, e1, zh))
    # [DOC: edge-fill]
    frame = [] if box is None else [(z - x, 0), (x + z, box[0]), (z - y, 0), (y + z, box[1])]
    g0, b0 = _stack([(s * d[o] @ v - c * e @ z, 0) for v, o, e, c in caps for s in (1, -1)] + frame)
    ang = 2 * np.pi * np.arange(SIDES) / SIDES
    ck, ux, uy = np.cos(np.pi / SIDES), np.cos(ang), np.sin(ang)
    sx, sy, sz, m = x[fit], y[fit], z[fit], len(fit)
    inc = [(-a * sx - b * sy - ck * SAFE * sz, -(a * px + b * py + ck * r)[fit]) for a, b in zip(ux, uy, strict=True)]
    gi, bi = _stack([*inc, (-ck * (1 - SAFE) * sz, 0)])
    t, im, pad, u = len(w), sp.identity(m), sp.csr_matrix, 0 if edge is None else n
    slack = sp.vstack([sp.hstack([-im, -im])] * SIDES + [sp.hstack([im, pad((m, m))])])
    a_eq = sp.hstack([a_t, -sp.identity(t), sp.identity(t), pad((t, 2 * m + u))])
    top = sp.hstack([g0, pad((len(b0), 2 * t + 2 * m + u))])
    a_ub = [top, sp.hstack([gi, pad((len(bi), 2 * t)), slack, pad((len(bi), u))])]
    b_ub = [b0, bi]
    # [DOC: stabilization]
    if edge is not None:
        j, nx, ny, c, exit_cost = edge
        out = -sp.csr_matrix((np.ones(len(j)), (np.arange(len(j)), j)), (len(j), n))
        a_ub.append(sp.hstack([sp.diags(-nx) @ x[j] + sp.diags(-ny) @ y[j] + z[j], pad((len(j), 2 * t + 2 * m)), out]))
        b_ub.append(-c)
    (fw, fh), free = (np.inf, np.inf) if box is None else box, -np.inf if box is None else 0
    exit_cost = 0 if edge is None else edge[4]
    exits = np.full(m, SAFE_EXIT * q), np.full(m, CIRCLE_EXIT * q), np.full(u, exit_cost * q)
    cost = np.r_[np.zeros(2 * n), np.full(n, 0 if zoom else -CROP_SHARE * exit_cost * q), w, w, *exits]
    lb = np.r_[np.full(2 * n, free), np.full(n, lo), np.zeros(2 * t + 2 * m + u)]
    hb = np.r_[np.full(n, fw), np.full(n, fh), np.ones(n), ub, ub, np.full(2 * m + u, np.inf)]
    bounds, options = np.column_stack([lb, hb]), {'time_limit': TIME_LIMIT}
    res = linprog(cost, sp.vstack(a_ub), np.concatenate(b_ub), a_eq, b_eq, bounds, method='highs', options=options)
    return res.x[: 3 * n].reshape(3, n).T if res.status == 0 else None


def _shot(on, px, py, r, centre, box, lo, fps, zoom, bound):
    on, n = _clean(on, px, py, r, fps), len(on)
    t = np.arange(0, n + STEP - 1, STEP)
    idx, edge = np.minimum(t, n - 1), None
    if bound is not None:
        ft, nrm, off, exit_cost = bound
        j = np.repeat(np.clip(np.round(ft / STEP), 0, len(t) - 1).astype(int), nrm.shape[1])
        edge = j, nrm[..., 0].ravel(), nrm[..., 1].ravel(), off.ravel(), exit_cost
    go = len(t) > 7 and (on[idx].any() or edge is not None)
    p = _lp(on[idx], px[idx], py[idx], r[idx], box, lo, fps / STEP, zoom, edge) if go else None
    if p is None:
        return _fallback(on, px, py, r, centre, box, lo, fps)
    return _clamp(CubicSpline(t, p)(np.arange(n)), box, lo)


def solve(track, width, height, cuts=(), fps=FPS, zoom=False, world=None):
    s, half = min(width, height) / 2, np.array([width / 2, height / 2])
    cx, cy, r = (np.array(track[k], float) for k in ('cx', 'cy', 'r'))
    on = np.asarray(track['present'], bool) & np.isfinite(cx + cy + r)
    n, box, centre = len(on), (width / s, height / s), np.tile(half, (len(on), 1))
    # [DOC: stabilization]
    if world is not None:
        m, box = world['track'], None
        cx, cy = (m[:, i, 0] * cx + m[:, i, 1] * cy + m[:, i, 2] for i in (0, 1))
        r, centre = r * np.hypot(m[:, 0, 0], m[:, 1, 0]), m[:, :, 2] + m[:, :, :2] @ half
        nrm, off = world['nrm'], world['off'] / s
        exit_cost = EDGE_EXIT[0] * (EDGE_EXIT[1] / EDGE_EXIT[0]) ** world['strength']
    px, py, r = cx / s, cy / s, r / s
    stab = 1.0 if box or 2 * s <= OUT_SIZE else max(OUT_SIZE / (2 * s), 1 - STAB_CROP)
    # [DOC: zoom-option]
    lo = min(OUT_SIZE / 2, s) / s if zoom else stab
    edges = np.unique(np.r_[0, [c for c in cuts if 0 < c < n], n]).astype(int)
    shot = None if world is None else np.searchsorted(edges[1:-1], np.round(world['ft']), side='right')

    def bound(i, a):
        return None if shot is None else (world['ft'][shot == i] - a, nrm[shot == i], off[shot == i], exit_cost)

    shots = [_shot(on[a:b], px[a:b], py[a:b], r[a:b], centre[a:b] / s, box, lo, fps, zoom, bound(i, a))
             for i, (a, b) in enumerate(pairwise(edges))]  # fmt: skip
    return (np.concatenate(shots) if shots else np.zeros((0, 3))) * [s, s, 2 * s]


# [DOC: square-source]
def still(n, width, height):
    return np.tile([width / 2, height / 2, min(width, height)], (n, 1)).astype(float)


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
