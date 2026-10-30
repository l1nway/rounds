import base64
import contextlib
import math
import multiprocessing
import os
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from functools import cache, partial

import cv2
import numpy as np
from scipy.ndimage import correlate1d

from . import look_np as lk
from . import media, source, warp_np, zerodce_np
from .config import DCE_WEIGHTS, OUT_SIZE

# [DOC: free-look]
WORKERS = max(1, (os.cpu_count() or 2) - 1)
AHEAD = 2
RGB = 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb48le'
THREADS = ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS')
# [DOC: look-preview]
TAIL = 1.5
JPEG = [cv2.IMWRITE_JPEG_QUALITY, 85]


def graph(meta: dict, cut: str, out: tuple[int, int]) -> tuple[str, int, tuple[int, int]]:
    gw, gh = lk.fit(meta['width'], meta['height'])
    wide = max(out[0], gw)
    vf = (f'split[a][b];[a]{cut}{media.sdr_chain(meta, *out)},{RGB},pad={wide}:{out[1]}[m];'
          f'[b]{media.sdr_chain(meta, gw, gh)},{RGB},pad={wide}:{gh}[g];[m][g]vstack')  # fmt: skip
    return vf, wide, (gw, gh)


def shrink(n: int) -> np.ndarray:
    return lk.lerp((np.arange(int(n / lk.REPAIR_SCALE)) + 0.5) * lk.REPAIR_SCALE - 0.5, n)


@cache
def placed(geo: tuple) -> tuple[np.ndarray, np.ndarray]:
    box, w, h, out, gw, gh = geo
    return lk.sampler(*lk.coords(box, w, h, out), gw, gh)


@cache
def widen(n: int, small: int) -> np.ndarray:
    return lk.lerp(np.arange(n) * (small - 1) / max(n - 1, 1), small)


# [DOC: chroma-siting]
def down2(x: np.ndarray, off: float, axis: int) -> np.ndarray:
    w = warp_np.lanczos((np.arange(-6, 7) - off) / 2)
    return correlate1d(x, w / w.sum(), axis, mode='nearest').take(np.arange(0, x.shape[axis], 2), axis)


@cache
def noise() -> list[np.ndarray]:
    rng = np.random.default_rng(7)
    return [rng.random((s, s), np.float32) - 0.5 for s in (OUT_SIZE, OUT_SIZE // 2, OUT_SIZE // 2)]


# [DOC: output-encode]
def encode(v: np.ndarray) -> np.ndarray:
    y = lk.KR * v[0] + (1 - lk.KR - lk.KB) * v[1] + lk.KB * v[2]
    c = np.stack([(v[2] - y) / (2 * (1 - lk.KB)), (v[0] - y) / (2 * (1 - lk.KR))])
    c = down2(down2(c, 0.5, -2), 0.0, -1)
    planes = 16 + 219 * y, 128 + 224 * c[0], 128 + 224 * c[1]
    return np.concatenate([np.clip(np.rint(p + n), 0, 255).astype(np.uint8).ravel()
                           for p, n in zip(planes, noise(), strict=True)])  # fmt: skip


def grade(frame: np.ndarray, m: np.ndarray, top: float, alpha, geo: tuple, value: float, ev: float) -> np.ndarray:
    look, (mx, my) = lk.Look(value, ev, 1.0), placed(geo)
    v = np.clip(look(lk.linear(frame), lk.sample(m, mx, my), top), 0, 1) ** (1 / lk.GAMMA)
    return v if alpha is None else lift(v, alpha, look.repair)


def lift(v: np.ndarray, alpha: np.ndarray, strength: float) -> np.ndarray:
    (h, w), n = v.shape[1:], alpha.shape
    a = widen(h, n[0]) @ alpha @ widen(w, n[1]).T * (strength * lk.REPAIR_LIFT)
    peak = v.max(0)
    return np.clip(v * zerodce_np.curve(peak, a) / np.maximum(peak, lk.REPAIR_EPS), 0, 1)


def finish(frame, m, top, alpha, geo: tuple, value: float, ev: float) -> np.ndarray:
    return encode(grade(frame, m, top, alpha, geo, value, ev))


# [DOC: free-look]
class Alpha:
    def __init__(self, out: tuple[int, int], rate: float):
        dx, dy = (shrink(n) for n in out)
        self.cols, self.rows = np.flatnonzero(dx.any(0)), np.flatnonzero(dy.any(0))
        self.dx, self.dy = dx[:, self.cols], dy[:, self.rows]
        self.params, self.ema = zerodce_np.load(DCE_WEIGHTS), None
        self.k = 1 - math.exp(-1 / (rate * lk.REPAIR_TAU))

    def step(self, v: np.ndarray) -> np.ndarray:
        a = zerodce_np.net(self.dy @ v @ self.dx.T, self.params).mean(0)
        self.ema = a if self.ema is None else self.ema + self.k * (a - self.ema)
        return self.ema


class Curve(Alpha):
    def __init__(self, geo: tuple, rate: float):
        box, w, h, out, gw, gh = geo
        super().__init__(out, rate)
        gx, gy = lk.coords(box, w, h, out)
        self.mx, self.my = lk.sampler(gx[self.cols], gy[self.rows], gw, gh)

    def __call__(self, frame: np.ndarray, m: np.ndarray, top: float, look: lk.Look) -> np.ndarray:
        x = lk.linear(frame[self.rows][:, self.cols])
        return self.step(np.clip(look(x, lk.sample(m, self.mx, self.my), top), 0, 1) ** (1 / lk.GAMMA))


@contextlib.contextmanager
def pool():
    for name in THREADS:
        os.environ.setdefault(name, '1')
    workers = ProcessPoolExecutor(WORKERS, mp_context=multiprocessing.get_context('spawn'))
    try:
        yield workers
    finally:
        workers.shutdown(cancel_futures=True)


def ordered(pool: ProcessPoolExecutor, work, items, ahead: int):
    pending = deque()
    for item in items:
        pending.append(pool.submit(work, *item))
        if len(pending) >= ahead:
            yield pending.popleft().result()
    while pending:
        yield pending.popleft().result()


def decoded(src, meta: dict, start: float, n: int, rate: float, vf: str, size: int):
    def make(slow: bool):
        dec = media.decode(src, meta, start, n, vf, 'rgb48le', rate, slow)
        try:
            yield from media.reader(dec, n, size, np.uint16)
        finally:
            media.stop(dec)

    return media.retrying(make)


def frames(src, meta: dict, start: float, n: int, rate: float, square: tuple, value: float, ev: float):
    (side, x, y), out = square, (OUT_SIZE, OUT_SIZE)
    vf, wide, (gw, gh) = graph(meta, f'crop={side}:{side}:{x}:{y},', out)
    geo = (x + side / 2, y + side / 2, side, side), meta['width'], meta['height'], out, gw, gh
    look = lk.Look(value, ev, rate)
    curve = Curve(geo, rate) if look.repair > 0 else None

    def items():
        with contextlib.closing(decoded(src, meta, start, n, rate, vf, wide * (OUT_SIZE + gh) * 3)) as bufs:
            for buf in bufs:
                f = buf.reshape(-1, wide, 3)
                frame, (m, top) = f[:OUT_SIZE, :OUT_SIZE].copy(), look.maps(f[OUT_SIZE:, :gw])
                yield frame, m, top, curve and curve(frame, m, top, look)

    with pool() as workers:
        yield from ordered(workers, partial(finish, geo=geo, value=value, ev=ev), items(), AHEAD * WORKERS)


# [DOC: free-look]
def preview(src, meta: dict, at: float, value: float, ev: float, size: tuple[int, int]) -> dict:
    (w, h), fps = (meta['width'], meta['height']), meta['fps']
    at = min(at, max(0.0, meta['duration'] - TAIL / fps))  # [DOC: preview-tail]
    vf, wide, (gw, gh) = graph(meta, '', size)
    with contextlib.closing(decoded(src, meta, at, 1, fps, vf, wide * (size[1] + gh) * 3)) as bufs:
        buf = next(bufs, None)
        if buf is None:
            raise source.Unreadable(media.NO_RANGE)
        f = buf.reshape(-1, wide, 3).copy()
    geo, look = ((w / 2, h / 2, w, h), w, h, size, gw, gh), lk.Look(value, ev, fps)
    frame, (m, top) = f[: size[1], : size[0]], look.maps(f[size[1] :, :gw])
    alpha = Curve(geo, fps)(frame, m, top, look) if look.repair > 0 else None
    v = np.rint(grade(frame, m, top, alpha, geo, value, ev).transpose(1, 2, 0) * 255).astype(np.uint8)
    data = cv2.imencode('.jpg', cv2.cvtColor(v, cv2.COLOR_RGB2BGR), JPEG)[1]
    return {'image': 'data:image/jpeg;base64,' + base64.b64encode(data).decode(), 'width': size[0], 'height': size[1]}
