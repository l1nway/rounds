# [DOC: look-port]
import math

import numpy as np
from scipy.ndimage import uniform_filter

# [DOC: look-zones]
HONEST = 0.4
# [DOC: look-maps]
GRID, RADIUS, EPS, SPREAD = 256, 8, 0.3, 16
FLOOR = 2.0**-10
CLIP = 0.93, 0.985
# [DOC: look-curve]
PIVOT, LIFT, DARK = math.log2(0.18), 0.75, (math.log2(0.0005), math.log2(0.008))
SHADE, EV_LIFT = (math.log2(0.004), math.log2(0.125)), 0.25
KNEE, WHITE, TARGET, SOFT = math.log2(0.3), 0.0, math.log2(0.8), 0.5
DETAIL = 0.2
SHOULDER = 0.9
TAU = 0.3
# [DOC: repair]
REPAIR_LIFT, REPAIR_SCALE, REPAIR_TAU, REPAIR_EPS = 0.5, 12, 0.5, 1e-4
GAMMA, KR, KB, TINY = 2.4, 0.2126, 0.0722, 1e-6
LINEAR = (np.arange(65536, dtype=np.float32) / 65535) ** GAMMA


def split(value: float) -> tuple[float, float]:
    return min(value / HONEST, 1.0), max(value - HONEST, 0.0) / (1 - HONEST)


def smoothstep(e0: float, e1: float, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def box(x: np.ndarray, r: int) -> np.ndarray:
    return uniform_filter(x, (1, 2 * r + 1, 2 * r + 1), mode='nearest')


def lum(x: np.ndarray) -> np.ndarray:
    return np.maximum(KR * x[0] + (1 - KR - KB) * x[1] + KB * x[2], 0)


def fit(w: int, h: int) -> tuple[int, int]:
    k = GRID / max(w, h)
    return max(1, round(w * k)), max(1, round(h * k))


def linear(rgb16: np.ndarray) -> np.ndarray:
    return LINEAR[rgb16.transpose(2, 0, 1)]


# [DOC: look-maps]
def grid(x: np.ndarray) -> tuple[np.ndarray, float]:
    y = lum(x)
    log = np.log2(y + FLOOR)
    mi, mii = box(np.stack([log, log * log]), RADIUS)
    var = np.maximum(mii - mi * mi, 0)
    a = var / (var + EPS)
    keep = 1 - smoothstep(*CLIP, np.clip(x, 0, 1).max(0) ** (1 / GAMMA))
    sums = box(np.concatenate([x * keep, (y * keep)[None]]), SPREAD)
    ratio = sums[:3] / np.maximum(sums[3:], 1e-6)
    return np.concatenate([box(np.stack([a, mi - a * mi]), RADIUS), ratio]), float(mi.max())


# [DOC: look-rebuild]
def rebuild(x: np.ndarray, ratio: np.ndarray, t: float) -> np.ndarray:
    m = smoothstep(*CLIP, np.clip(x, 0, 1) ** (1 / GAMMA))
    keep, ratio = 1 - m, np.maximum(ratio, 1e-3)
    est = (keep * x).sum(0) / np.maximum((keep * ratio).sum(0), 1e-3)
    return x + m * np.maximum(ratio * est - x, 0) * (t * smoothstep(0.0, 0.5, keep.sum(0)))


# [DOC: look-curve]
def curve(base: np.ndarray, top: float, t: float, ev: float) -> np.ndarray:
    b = base + ev * (smoothstep(*SHADE, base) if ev < 0 else 1.0)
    b = b + max(t, EV_LIFT * max(ev, 0.0)) * LIFT * np.maximum(PIVOT - b, 0) * smoothstep(*DARK, b)
    peak = top + ev
    cap = min(peak, max(top, WHITE))
    cap += t * (min(cap, TARGET) - cap)
    if peak <= cap or peak <= KNEE:
        return b
    d = b - KNEE
    return b - (1 - (cap - KNEE) / (peak - KNEE)) * 0.5 * (d + np.sqrt(d * d + SOFT * SOFT))


def shoulder(x: np.ndarray) -> np.ndarray:
    m = x.max(0, keepdims=True)
    f = np.where(m > SHOULDER, SHOULDER + (1 - SHOULDER) * (1 - np.exp((SHOULDER - m) / (1 - SHOULDER))), m)
    return np.clip(x * f / np.maximum(m, TINY), 0, 1)


def apply(x: np.ndarray, s: np.ndarray, top: float, t: float, ev: float) -> np.ndarray:
    if t > 0:
        x = rebuild(x, s[2:5], t)
    log = np.log2(lum(x) + FLOOR)
    base = s[0] * log + s[1]
    return x * np.exp2(curve(base, top, t, ev) + (log - base) * (1 + t * DETAIL) - log)


def lerp(u: np.ndarray, n: int) -> np.ndarray:
    u = np.clip(u, 0, n - 1)
    i0 = np.floor(u).astype(int)
    f, i1, m = u - i0, np.minimum(i0 + 1, n - 1), np.zeros((len(u), n))
    np.add.at(m, (np.arange(len(u)), i0), 1 - f)
    np.add.at(m, (np.arange(len(u)), i1), f)
    return m.astype(np.float32)


def coords(box, w: int, h: int, out: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    return tuple(2 * (c + ((np.arange(k) + 0.5) / k - 0.5) * side) / n - 1
                 for c, side, n, k in ((box[0], box[2], w, out[0]), (box[1], box[3], h, out[1])))  # fmt: skip


def sampler(gx: np.ndarray, gy: np.ndarray, gw: int, gh: int) -> tuple[np.ndarray, np.ndarray]:
    return lerp(((gx + 1) * gw - 1) / 2, gw), lerp(((gy + 1) * gh - 1) / 2, gh)


def sample(m: np.ndarray, mx: np.ndarray, my: np.ndarray) -> np.ndarray:
    return my @ m @ mx.T


class Look:
    def __init__(self, value: float, ev: float, rate: float):
        (self.t, self.repair), self.ev = split(value), ev
        self.alpha, self.top = 1 - math.exp(-1 / (rate * TAU)), None

    @property
    def on(self) -> bool:
        return self.t > 0 or self.ev != 0

    def maps(self, rgb16: np.ndarray) -> tuple[np.ndarray, float]:
        m, top = grid(linear(rgb16))
        self.top = top if self.top is None else self.top + self.alpha * (top - self.top)
        return m, self.top

    def __call__(self, x: np.ndarray, s: np.ndarray, top: float) -> np.ndarray:
        return shoulder(apply(np.maximum(x, 0), s, top, self.t, self.ev))
