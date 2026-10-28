from functools import cache, partial

import cv2
import numpy as np
from scipy.ndimage import distance_transform_edt, maximum_filter1d

from . import lucky
from .config import DSTNET_WEIGHTS

# [DOC: deblur]
WORK = 640
REF = 384
SPEED, STILL = 2.0, 0.05
DEFICIT = 0.15
WINDOW = 0.3
DILATE, GAP, CONTEXT = 1, 4, 2
BLOCK = 24
CLIP, OVERLAP = 10, 2
FEED = {2: 0.0, 3: 0.5, 4: 1.0}


def even(x: float) -> int:
    return max(2, round(x / 2) * 2)


def scales(bits: int, full: bool) -> tuple[int, int, int, int, int]:
    top, s = 2**bits - 1, 1 << (bits - 8)
    return (0, top, 128 * s, top, top) if full else (16 * s, 219 * s, 128 * s, 224 * s, top)


@cache
def network():
    from . import dstnet

    return partial(dstnet.run, model=dstnet.load(DSTNET_WEIGHTS, 'L'), clip=CLIP, overlap=OVERLAP, half=True)


# [DOC: deblur-detect]
def flags(sharp: list, move: list, reach: int) -> np.ndarray:
    ln, move = np.log(sharp), np.asarray(move)
    nxt = np.r_[move[1:], 0.0]
    pace = np.where((move > STILL) & (nxt > STILL), (move + nxt) / 2, np.maximum(move, nxt))
    return (pace >= SPEED) | (maximum_filter1d(ln, 2 * reach + 1, mode='nearest') - ln >= DEFICIT)


def weights(raw: np.ndarray) -> np.ndarray:
    f = maximum_filter1d(raw.astype(np.uint8), 2 * DILATE + 1, mode='constant') > 0
    on = np.flatnonzero(f)
    for a, b in zip(on[:-1], on[1:], strict=True):
        if b - a <= GAP + 1:
            f[a:b] = True
    if not f.any():
        return np.zeros(len(f))
    return np.clip(1 - distance_transform_edt(~f) / (CONTEXT + 1), 0, 1)


# [DOC: deblur-model]
def modelled(feed: list, uvs: list, net, matrix: str, stats: dict) -> np.ndarray:
    import torch

    from . import color

    kr, kb = color.KR_KB[matrix]
    x = torch.stack([color.yuv_to_rgb(torch.from_numpy(y), torch.from_numpy(uv), matrix, 8, False)
                     for y, uv in zip(feed, uvs, strict=True)]).clamp(0, 1)  # fmt: skip
    out = net(x).float().cpu()
    ok = torch.isfinite(out).flatten(1).all(1)
    stats['deblur_nan'] = stats.get('deblur_nan', 0) + int((~ok).sum())
    d = (color.luma(out.transpose(0, 1), kr, kb) - color.luma(x.transpose(0, 1), kr, kb)) * lucky.RANGE
    return torch.where(ok[:, None, None], d, 0).numpy()


# [DOC: deblur]
def cleaner(geo: tuple, rate: float, step: int, side: float, stats: dict):
    if not step:
        return iter
    return partial(frames, geo=geo, rate=rate, step=step, side=side, stats=stats, net=network() if step > 1 else None)


# [DOC: deblur-stream]
def frames(stream, geo: tuple, rate: float, step: int, side: float, stats: dict, net=None):
    (w, h, cw, ch), (bits, full, matrix, _) = geo
    y0, yr, c0, cr, top = scales(bits, full)
    k = min(1.0, WORK / side)
    size = even(w * k), even(h * k)
    small = even(size[0] * REF / (side * k)), even(size[1] * REF / (side * k))
    reach = max(1, round(WINDOW * rate))
    ahead, behind = reach + 1 + DILATE + GAP + CONTEXT, reach + OVERLAP
    bufs, ys, uvs, fixed, sharp, move, last = {}, {}, {}, {}, [], [], None
    stats.setdefault('deblurred', 0)

    def take(buf):
        nonlocal last
        i, bufs[i] = len(sharp), buf.copy()
        plane = bufs[i][: w * h].reshape(h, w).astype(np.float32)
        ys[i] = (cv2.resize(plane, size, interpolation=cv2.INTER_AREA) - y0) * (lucky.RANGE / yr) + lucky.BLACK
        if net:
            uv = bufs[i][w * h :].reshape(2, ch, cw).astype(np.float32)
            uv = np.stack([cv2.resize(p, size, interpolation=cv2.INTER_LINEAR) for p in uv])
            uvs[i] = (uv - c0) * (224 / cr) + 128
        sharp.append(lucky.sharpness(ys[i]))
        s = cv2.resize(ys[i], small, interpolation=cv2.INTER_AREA)
        move.append(lucky.speed(last, s) if last is not None else 0.0)
        last = s

    def classic(j: int) -> np.ndarray:
        if j not in fixed:
            fixed[j] = lucky.restore(ys, sharp, j, reach)
        return fixed[j]

    def solve(todo: list) -> dict:
        if step == 1:
            return {j: classic(j) for j in todo}
        span = range(max(todo[0] - OVERLAP, 0), min(todo[-1] + OVERLAP + 1, len(sharp)))
        feed = [ys[j] + FEED[step] * (classic(j) - ys[j]) if FEED[step] else ys[j] for j in span]
        d = modelled(feed, [uvs[j] for j in span], net, matrix, stats)
        return {j: f + dj for j, f, dj in zip(span, feed, d, strict=True) if j in todo}

    def emit(a: int, b: int):
        wt = weights(flags(sharp, move, reach))
        todo = [j for j in range(a, b) if wt[j] > 0]
        new = solve(todo) if todo else {}
        stats['deblurred'] += len(new)
        for j in range(a, b):
            buf = bufs.pop(j)
            if j in new:
                d = cv2.resize((wt[j] * (new[j] - ys[j])).astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
                plane = buf[: w * h].reshape(h, w)
                plane[:] = np.clip(np.rint(plane + d * (yr / lucky.RANGE)), 0, top)
            yield buf
        for j in [j for j in ys if j < b - behind]:
            ys.pop(j), uvs.pop(j, None), fixed.pop(j, None)

    a = 0
    for buf in stream:
        take(buf)
        if len(sharp) - a >= BLOCK + ahead:
            yield from emit(a, a + BLOCK)
            a += BLOCK
    while a < len(sharp):
        yield from emit(a, min(a + BLOCK, len(sharp)))
        a += BLOCK
