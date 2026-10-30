# [DOC: free-stabilization]
import math

import cv2
import numpy as np

from .config import OUT_SIZE

# [DOC: lanczos-matrix]
TAPS = 3
# [DOC: stabilization-warp]
OVER = 2
GUARD = 4


def lanczos(x, a: int = TAPS):
    return np.where(np.abs(x) < a, np.sinc(x) * np.sinc(x / a), 0)


def axis(c: float, side: float, size: int) -> tuple[np.ndarray, float]:
    s = side / size
    return c - side / 2 - 0.5 + (np.arange(size) + 0.5) * s, max(s, 1.0)


# [DOC: lanczos-matrix]
def weights(c: float, side: float, n: int, size: int = OUT_SIZE) -> tuple[int, int, np.ndarray]:
    u, sc = axis(c, side, size)
    idx = np.floor(u - TAPS * sc).astype(np.int64)[:, None] + 1 + np.arange(math.ceil(2 * TAPS * sc) + 1)
    w = lanczos((idx - u[:, None]) / sc)
    idx = np.clip(idx, 0, n - 1)  # [DOC: edge-fill]
    lo, hi = int(idx.min()), int(idx.max()) + 1
    m = np.zeros((size, hi - lo))
    np.add.at(m, (np.arange(size)[:, None], idx - lo), w)
    return lo, hi, (m / m.sum(1, keepdims=True)).astype(np.float32)


def bounds(c: float, side: float, n: int, size: int = OUT_SIZE) -> tuple[int, int]:
    u, sc = axis(c, side, size)
    lo, hi = math.floor(u[0] - TAPS * sc) + 1, math.floor(u[-1] - TAPS * sc) + 1 + math.ceil(2 * TAPS * sc)
    return min(max(lo, 0), n - 1), min(max(hi, 0), n - 1) + 1


# [DOC: stabilization-warp]
def box(row, size: int = OUT_SIZE) -> tuple[tuple, tuple[int, int]]:
    if len(row) < 4 or not row[3]:
        return (row[0], row[1], row[2], row[2]), (size, size)
    big = OVER * size
    m = math.ceil(big * (abs(math.cos(row[3])) + abs(math.sin(row[3])))) + 2 * GUARD
    return (row[0], row[1], m * row[2] / big, m * row[2] / big), (m, m)


def window(x: np.ndarray, origin: tuple[int, int], box: tuple, frame: tuple[int, int], out) -> np.ndarray:
    (ox, oy), (w, h) = origin, frame
    y0, y1, wy = weights(box[1], box[3], h, out[1])
    x0, x1, wx = weights(box[0], box[2], w, out[0])
    return wy @ x[:, y0 - oy : y1 - oy, x0 - ox : x1 - ox] @ wx.T


def turned(x: np.ndarray, angle: float, size: int = OUT_SIZE) -> np.ndarray:
    big, m, c, s = OVER * size, x.shape[-1], math.cos(angle), math.sin(angle)
    v = ((np.arange(big, dtype=np.float32) + 0.5) / big - 0.5) * big
    gx, gy = np.meshgrid(v, v)
    px, py = (((g * (2 / m) + 1) * m - 1) / 2 for g in (c * gx - s * gy, s * gx + c * gy))
    hwc = np.ascontiguousarray(x.transpose(1, 2, 0), np.float32)
    big_img = cv2.remap(hwc, px, py, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE).transpose(2, 0, 1)
    _, _, w = weights(big / 2, big, big, size)
    return np.maximum(w @ np.maximum(big_img, 0) @ w.T, 0)
