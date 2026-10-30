# [DOC: free-stabilization]
import math

import cv2
import numpy as np
from scipy.ndimage import uniform_filter

from . import motion
from .config import FPS

# [DOC: edge-fill]
REACH = 0.5
FEATHER = 8
RIM = 1.0
COVER = 0.999
CANVAS = 4096
F32 = np.float32


def sample(img: np.ndarray, ix: np.ndarray, iy: np.ndarray) -> np.ndarray:
    px, py = np.broadcast_arrays(ix[None, :], iy[:, None])
    hwc = np.ascontiguousarray(img.transpose(1, 2, 0), F32)
    out = cv2.remap(hwc, np.ascontiguousarray(px), np.ascontiguousarray(py), cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_CONSTANT, borderValue=0)  # fmt: skip
    return out.reshape(*out.shape[:2], -1).transpose(2, 0, 1)


def index(g: np.ndarray, n: int) -> np.ndarray:
    return (((g + 1) * n - 1) / 2).astype(F32)


class Edges:
    def __init__(self, at, world: dict, size: int, rate: float, union: bool):
        self.at, self.world, self.size, self.rate, self.union = at, world, size, rate, union
        n, (w, h) = len(world['p']), world['size']
        m = np.concatenate([motion.matrices(world['p'], (w, h)), np.tile([0, 0, 1.0], (n, 1, 1))], 1)
        self.inv = np.linalg.inv(m)[:, :2].astype(F32)
        self.v = (np.arange(size, dtype=F32) + 0.5) / size - 0.5
        gy, gx = np.meshgrid(self.v, self.v, indexing='ij')
        self.grid, self.wh = np.stack([gx, gy], -1), (w, h)

    def window(self, k: int) -> np.ndarray:
        return self.at(np.array([k * FPS / self.rate]))[0]

    def bad(self, k: int) -> np.ndarray:
        x, y, side = self.window(k)
        pts = self.grid * float(side) + np.array([x, y], F32)
        t, s = self.world['t'], k / self.rate
        i = int(np.clip(np.searchsorted(t, s), 1, len(t) - 1))
        frames = {i - 1, i} if self.union else {i - 1 if s - t[i - 1] < t[i] - s else i}
        (w, h), out = self.wh, np.zeros((self.size, self.size), bool)
        for j in frames:
            p = pts @ self.inv[j, :, :2].T + self.inv[j, :, 2]
            if self.world['disc']:
                out |= np.hypot(p[..., 0] - w / 2, p[..., 1] - h / 2) > motion.DISC_SAFE * min(w, h) / 2
            else:
                out |= (p[..., 0] < RIM) | (p[..., 0] > w - RIM) | (p[..., 1] < RIM) | (p[..., 1] > h - RIM)
        return out


class Canvas:
    def __init__(self, edges: Edges, n: int, start: int = 0):
        rows = np.array([edges.window(k) for k in range(start, start + n)])
        lo, hi = (rows[:, :2] - rows[:, 2:] / 2).min(0), (rows[:, :2] + rows[:, 2:] / 2).max(0)
        self.edges, self.lo = edges, lo
        self.scale = min(edges.size / np.median(rows[:, 2]), CANVAS / (hi - lo).max())
        w, h = np.ceil((hi - lo) * self.scale).astype(int) + 1
        self.rgb, self.seen = np.zeros((3, h, w), np.float16), np.zeros((1, h, w), np.float16)

    def write(self, k: int, img: np.ndarray, good: np.ndarray):
        x, y, side = self.edges.window(k)
        (x0, y0), (x1, y1) = (np.array([[x, y]]) + [[-side / 2], [side / 2]] - self.lo) * self.scale
        h, w = self.seen.shape[1:]
        x0, y0, x1, y1 = max(int(x0), 0), max(int(y0), 0), min(math.ceil(x1), w), min(math.ceil(y1), h)
        if x1 <= x0 or y1 <= y0:
            return
        gx, gy = ((np.arange(a, b, dtype=F32) + 0.5) / F32(self.scale) + F32(c) - F32(o)
                  for a, b, c, o in ((x0, x1, self.lo[0], x), (y0, y1, self.lo[1], y)))  # fmt: skip
        ix, iy = (index(2 * g / F32(side), self.edges.size) for g in (gx, gy))
        both = sample(np.concatenate([img, good]), ix, iy)
        ok = (both[3:] >= COVER).astype(np.float16)
        area = (slice(None), slice(y0, y1), slice(x0, x1))
        self.rgb[area] = ok * both[:3].astype(np.float16) + (1 - ok) * self.rgb[area]
        self.seen[area] = np.maximum(self.seen[area], ok)

    def read(self, k: int) -> tuple[np.ndarray, np.ndarray]:
        x, y, side = self.edges.window(k)
        (h, w), v = self.seen.shape[1:], self.edges.v * float(side)
        ix, iy = (index((v + F32(c) - F32(lo)) * F32(self.scale) / F32(n) * 2 - 1, n)
                  for c, lo, n in ((x, self.lo[0], w), (y, self.lo[1], h)))  # fmt: skip
        (a, b), (c, d) = ((max(int(i.min()) - 1, 0), min(int(i.max()) + 3, n)) for i, n in ((ix, w), (iy, h)))
        if b <= a or d <= c:
            size = self.edges.size
            return np.zeros((3, size, size), F32), np.zeros((1, size, size), F32)
        part = np.concatenate([self.rgb[:, c:d, a:b], self.seen[:, c:d, a:b]]).astype(F32)
        both = sample(part, ix - a, iy - c)
        return both[:3], (both[3:] >= COVER).astype(F32)


def pool(a: np.ndarray) -> np.ndarray:
    c, h, w = a.shape
    pad = ((0, 0), (0, h % 2), (0, w % 2))
    s = np.pad(a, pad).reshape(c, (h + 1) // 2, 2, (w + 1) // 2, 2).sum((2, 4))
    return s / np.pad(np.ones((1, h, w), F32), pad).reshape(1, (h + 1) // 2, 2, (w + 1) // 2, 2).sum((2, 4))


def spread(x: np.ndarray, w: np.ndarray) -> np.ndarray:
    if min(x.shape[-2:]) <= 2:
        return x.sum((-2, -1), keepdims=True) / np.maximum(w.sum((-2, -1), keepdims=True), 1e-6) + 0 * x
    coarse = spread(pool(x), pool(w))
    hwc = np.ascontiguousarray(coarse.transpose(1, 2, 0))
    up = cv2.resize(hwc, x.shape[:0:-1], interpolation=cv2.INTER_LINEAR)
    return x + (1 - w) * up.reshape(*up.shape[:2], -1).transpose(2, 0, 1)


def alpha(bad: np.ndarray) -> np.ndarray:
    good, size = (~bad).astype(F32), (2 * FEATHER + 1,) * 2
    share = uniform_filter(good, size, mode='constant') / uniform_filter(np.ones_like(good), size, mode='constant')
    return (good * share)[None]


def fill(k: int, img: np.ndarray, bad: np.ndarray, donors: list, edges: Edges, canvas: Canvas | None = None):
    if not bad.any():
        return img
    keep = alpha(bad)
    acc, cover, open_ = np.zeros_like(img), np.zeros_like(keep), (keep < 1).astype(F32)
    (xk, yk, sk), v = edges.window(k), edges.v
    for j, other, _, use in donors:
        if (cover + keep >= COVER).all():
            break
        xj, yj, sj = edges.window(j)
        ix, iy = (index(2 * (v * float(sk) + F32(d)) / float(sj), edges.size) for d in (xk - xj, yk - yj))
        both = sample(np.concatenate([other, use]), ix, iy)
        take = (both[3:] >= COVER).astype(F32) * (1 - cover) * open_
        acc, cover = acc + take * both[:3], cover + take
    if canvas is not None:
        rgb, seen = canvas.read(k)
        take = seen * (1 - cover) * open_
        acc, cover = acc + take * rgb, cover + take
    rest = spread(img * keep + acc * (1 - keep), np.minimum(keep + cover * (1 - keep), 1))
    return keep * img + (1 - keep) * (acc + (1 - cover) * rest)


# [DOC: edge-fill]
def frames(stream, edges: Edges, n: int, start: int = 0):
    reach, ring, emitted, canvas = max(1, math.ceil(REACH * edges.rate)), [], start, Canvas(edges, n, start)

    def emit(k: int):
        nonlocal ring
        centre = next(e for e in ring if e[0] == k)
        donors = sorted((e for e in ring if e[0] != k), key=lambda e: abs(e[0] - k))
        ring = [e for e in ring if e[0] >= k + 1 - reach]
        out = fill(k, centre[1], centre[2], donors, edges, canvas)
        canvas.write(k, centre[1], centre[3])
        return out

    for k, img in enumerate(stream, start):
        bad = edges.bad(k)
        ring.append((k, img, bad, (~bad).astype(F32)[None]))
        while k - emitted >= reach:
            yield emit(emitted)
            emitted += 1
    while ring and emitted <= ring[-1][0]:
        yield emit(emitted)
        emitted += 1
