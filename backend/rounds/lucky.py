from functools import cache

import cv2
import numpy as np

# [DOC: deblur-classical]
TAU = 0.5
DONORS = 4
MARGIN, RAMP = 1.1, 0.4
FB_SIGMA, PHOTO_SIGMA, PHOTO_BLUR = 2.0, 8.0, 1.5
POWER = 2.0
CONF_BLUR = 2.0
TAPS = 41
BLACK, RANGE, GAMMA = 16.0, 219.0, 2.4
EPS = 1e-12
BOX = np.ones((3, 3), np.uint8)


@cache
def dis():
    d = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    d.setFinestScale(0)
    return d


@cache
def grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.mgrid[:h, :w].astype(np.float32)
    return xx, yy


def byte(y: np.ndarray) -> np.ndarray:
    return np.clip(y + 0.5, 0, 255).astype(np.uint8)


def flow(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return dis().calc(byte(a), byte(b), None)


def speed(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.median(np.hypot(*flow(a, b).transpose(2, 0, 1))))


def sharpness(y: np.ndarray) -> float:
    gx, gy = cv2.Sobel(y, cv2.CV_32F, 1, 0), cv2.Sobel(y, cv2.CV_32F, 0, 1)
    return float((gx * gx + gy * gy).mean()) + EPS


def lin(y: np.ndarray) -> np.ndarray:
    return np.clip((y - BLACK) / RANGE, 0, 1) ** GAMMA


def gam(v: np.ndarray) -> np.ndarray:
    return (BLACK + RANGE * np.clip(v, 0, 1) ** (1 / GAMMA)).astype(np.float32)


def warp(img: np.ndarray, f: np.ndarray, interp=cv2.INTER_CUBIC) -> np.ndarray:
    xx, yy = grid(*f.shape[:2])
    return cv2.remap(img, xx + f[..., 0], yy + f[..., 1], interp, borderMode=cv2.BORDER_REPLICATE)


def blur(img: np.ndarray, path: np.ndarray) -> np.ndarray:
    n = int(min(TAPS, np.ceil(np.abs(path).max()) + 1))
    if n <= 1:
        return img
    xx, yy = grid(*img.shape)
    acc = np.zeros_like(img)
    for s in np.linspace(-0.5, 0.5, n, dtype=np.float32):
        acc += cv2.remap(img, xx + s * path[..., 0], yy + s * path[..., 1], cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_REPLICATE)  # fmt: skip
    return acc / n


def reblur(y: np.ndarray, path: np.ndarray) -> np.ndarray:
    return gam(blur(lin(y).astype(np.float32), path))


def velocity(y: np.ndarray, near: list[tuple[np.ndarray, int]]) -> np.ndarray:
    fs = [(flow(y, img), dt) for img, dt in near]
    if len(fs) == 2:
        return (fs[1][0] - fs[0][0]) / (fs[1][1] - fs[0][1])
    return fs[0][0] / fs[0][1] if fs else np.zeros((*y.shape, 2), np.float32)


def align(yk: np.ndarray, yj: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    (h, w), (xx, yy) = yk.shape, grid(*yk.shape)
    fkj, fjk = flow(yk, yj), flow(yj, yk)
    efb = np.hypot(*(fkj + warp(fjk, fkj, cv2.INTER_LINEAR)).transpose(2, 0, 1))
    x, y = xx + fkj[..., 0], yy + fkj[..., 1]
    inside = ((x >= 0) & (x <= w - 1) & (y >= 0) & (y <= h - 1)).astype(np.float32)
    return warp(yj, fkj), efb, inside


# [DOC: deblur-classical]
def transfer(yk: np.ndarray, sk: float, donors: list, path: np.ndarray) -> np.ndarray:
    num, den, miss, near = 0.0, 0.0, 1.0, 0.0
    for sj, wj, efb, inside in donors:
        bj = reblur(wj, path)
        eph = cv2.GaussianBlur(np.abs(yk - bj), (0, 0), PHOTO_BLUR)
        gain = min(max((sj / sk - MARGIN) / RAMP, 0.0), 1.0)
        conf = inside * np.exp(-((efb / FB_SIGMA) ** 2)) * np.exp(-((eph / PHOTO_SIGMA) ** 2)) * gain
        w = conf * sj**POWER + EPS
        num, den, miss, near = num + w * (lin(wj) - lin(bj)), den + w, miss * (1 - conf), near + w * wj
    alpha = cv2.GaussianBlur((1 - miss).astype(np.float32), (0, 0), CONF_BLUR)
    out = gam(lin(yk) + alpha * num / np.maximum(den, EPS))
    wb = np.where(den > 1e-9, near / np.maximum(den, EPS), yk).astype(np.float32)
    lo, hi = np.minimum(cv2.erode(yk, BOX), cv2.erode(wb, BOX)), np.maximum(cv2.dilate(yk, BOX), cv2.dilate(wb, BOX))
    return np.clip(out, lo, hi)


def restore(ys: dict, sharp: list, k: int, reach: int) -> np.ndarray:
    y, span = ys[k], [j for j in range(k - reach, k + reach + 1) if j in ys and j != k]
    pool = sorted((j for j in span if sharp[j] > MARGIN * sharp[k]), key=lambda j: -sharp[j])[:DONORS]
    if not pool:
        return y
    moved = [j for j in span if not np.array_equal(ys[j], y)]
    near = [(ys[j], j - k) for j in [j for j in moved if j < k][-1:] + [j for j in moved if j > k][:1]]
    path = TAU * velocity(y, near)
    return transfer(y, sharp[k], [(sharp[j], *align(y, ys[j])) for j in pool], path)
