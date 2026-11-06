import base64
import hashlib
import math
from functools import cache, lru_cache
from pathlib import Path

import cv2
import numpy as np

from .config import VIT_SHA, VIT_WEIGHTS

# [DOC: vit-track]
TEMPLATE, SEARCH, GRID, MIN_SCORE, MARGIN, TAP = 128, 256, 16, 0.2, 10, 0.15
PLANES = ((2, 0.485, 0.229), (1, 0.456, 0.224), (0, 0.406, 0.225))
HANN = (0.5 * (1 - np.cos(2 * np.pi / (GRID + 1) * (np.arange(GRID) + 1)))).astype(np.float32).astype(float)
OUTPUTS = ['output1', 'output2', 'output3']
# [DOC: vit-track]
RELOCK, RELOCK_MIN, HITS, REF_STEPS, SIZE_RATE, SIZE_STEP = 0.55, 0.3, 3, 5, 0.5, 1.1
PROGRESS_EVERY = 30


def js_round(v: float) -> int:
    return math.floor(v + 0.5)


@cache
def load(path: str = VIT_WEIGHTS) -> cv2.dnn.Net:
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != VIT_SHA:
        raise RuntimeError(f'{path} is not the pinned VitTrack weights')
    return cv2.dnn.readNetFromONNX(path)


def crop_of(w: int, h: int, factor: int) -> int:
    return math.ceil(math.sqrt(w * h) * factor)


@lru_cache(maxsize=64)
def axis(size: int, crop: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    f = (np.arange(size) + 0.5) * crop / size - 0.5
    s = np.floor(f)
    f -= s
    f[s < 0], s[s < 0] = 0, 0
    top = s >= crop - 1
    f[top], s[top] = 0, crop - 1
    lo = s.astype(np.int64)
    return lo, np.minimum(lo + 1, crop - 1), f.astype(np.float32).astype(float)


# [DOC: vit-track]
def blob(rgb: np.ndarray, rect: tuple, factor: int, size: int) -> np.ndarray:
    (x, y, w, h), (height, width) = rect, rgb.shape[:2]
    crop = crop_of(w, h, factor)
    lo, hi, frac = axis(size, crop)
    xs, ys = (x + int((w - crop) / 2), lo, hi), (y + int((h - crop) / 2), lo, hi)

    def at(v: np.ndarray, u: np.ndarray) -> np.ndarray:
        r, c = ys[0] + v, xs[0] + u
        inside = ((r >= 0) & (r < height))[:, None] & ((c >= 0) & (c < width))[None, :]
        px = rgb[np.clip(r, 0, height - 1)[:, None], np.clip(c, 0, width - 1)[None, :]].astype(float)
        return np.where(inside[..., None], px, 0)

    fx, fy = frac[None, :, None], frac[:, None, None]
    top = at(lo, lo) * (1 - fx) + at(lo, hi) * fx
    bottom = at(hi, lo) * (1 - fx) + at(hi, hi) * fx
    value = np.floor(top * (1 - fy) + bottom * fy + 0.5) / 255
    return np.stack([(value[..., ch] - mean) / std for ch, mean, std in PLANES])[None].astype(np.float32)


def clip(x: int, y: int, w: int, h: int, width: int, height: int) -> tuple[int, int, int, int]:
    mx, my = min(MARGIN, width), min(MARGIN, height)
    x1, y1 = min(max(0, x), width - mx), min(max(0, y), height - my)
    x2, y2 = min(max(mx, x + w), width), min(max(my, y + h), height)
    return x1, y1, max(mx, x2 - x1), max(my, y2 - y1)


def mask_box(data: str) -> list[float] | None:
    img = cv2.imdecode(np.frombuffer(base64.b64decode(data.split(',', 1)[-1]), np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None or img.ndim < 3 or img.shape[2] < 4:
        return None
    ys, xs = np.nonzero(img[..., 3] >= 128)
    if not xs.size:
        return None
    h, w = img.shape[:2]
    return [xs.min() / w, ys.min() / h, (xs.max() + 1) / w, (ys.max() + 1) / h]


def tap_box(points: list, width: int, height: int) -> list[float]:
    picked, half = [p for p in points if p[2] == 1], TAP / 2 * min(width, height)
    xs, ys = [p[0] for p in picked], [p[1] for p in picked]
    return [min(xs) - half / width, min(ys) - half / height, max(xs) + half / width, max(ys) + half / height]


def box_of(prompt: dict, width: int, height: int) -> tuple[int, int, int, int]:
    mask, points = prompt.get('mask'), prompt.get('points') or []
    x0, y0, x1, y1 = (mask and mask_box(mask)) or prompt.get('box') or tap_box(points, width, height)
    x, y = js_round(x0 * width), js_round(y0 * height)
    return clip(x, y, js_round(x1 * width) - x, js_round(y1 * height) - y, width, height)


def grow(prev: float, nxt: float) -> float:
    return prev * min(SIZE_STEP, max(1 / SIZE_STEP, 1 + (nxt / prev - 1) * SIZE_RATE))


# [DOC: vit-track]
class Vit:
    def __init__(self, net: cv2.dnn.Net):
        self.net = net

    def seed(self, rgb: np.ndarray, prompt: dict) -> tuple[tuple, float]:
        self.rect = box_of(prompt, rgb.shape[1], rgb.shape[0])
        self.template = blob(rgb, self.rect, 2, TEMPLATE)
        self.lost, self.scores, self.ref, self.hit = False, [], 1, None
        return self.rect, 1.0

    # [DOC: vit-track]
    def relock(self, rect: tuple, px: float, py: float, score: float, width: int, height: int) -> bool:
        hx, hy, hn = self.hit or (math.nan, math.nan, 0)
        _, _, w, h = rect
        near = math.hypot(px - hx, py - hy) <= math.hypot(w, h)
        hits = 0 if score < max(RELOCK_MIN, RELOCK * self.ref) else hn + 1 if near else 1
        self.hit = (px, py, hits) if hits else None
        self.rect = clip(js_round(px - w / 2), js_round(py - h / 2), w, h, width, height)
        self.lost = hits < HITS
        return not self.lost

    def step(self, rgb: np.ndarray) -> tuple[tuple | None, float]:
        (height, width), rect = rgb.shape[:2], self.rect
        x, y, w, h = rect
        crop = crop_of(w, h, 4)
        self.net.setInput(self.template, 'template')
        self.net.setInput(blob(rgb, rect, 4, SEARCH), 'search')
        conf, size, offset = (o.astype(float).reshape(-1, GRID, GRID) for o in self.net.forward(OUTPUTS))
        scored = conf[0] * HANN[:, None] * HANN[None, :]
        row, col = divmod(int(np.argmax(scored)), GRID)
        score = float(scored[row, col])
        if score < MIN_SCORE:
            self.lost, self.hit = True, None
            return None, score
        x0, y0 = x + int((w - crop) / 2), y + int((h - crop) / 2)
        px, py = (col + offset[0, row, col]) / GRID * crop + x0, (row + offset[1, row, col]) / GRID * crop + y0
        if self.lost:
            return (self.rect if self.relock(rect, px, py, score, width, height) else None), score
        nw, nh = grow(w, size[0, row, col] * crop), grow(h, size[1, row, col] * crop)
        left, up = math.floor(px - nw / 2), math.floor(py - nh / 2)
        self.rect = clip(left, up, math.floor(nw), math.floor(nh), width, height)
        if len(self.scores) < REF_STEPS:
            self.scores.append(score)
            self.ref = sorted(self.scores)[len(self.scores) >> 1]
        return self.rect, score


# [DOC: vit-track]
def track(frames: np.ndarray, index: int, prompt: dict, progress=None, net: cv2.dnn.Net | None = None) -> dict:
    n, vit = len(frames), Vit(net or load())
    boxes, score = [None] * n, np.zeros(n)
    order = [*range(index, n), *range(index - 1, -1, -1)]
    for done, k in enumerate(order, 1):
        boxes[k], score[k] = vit.seed(frames[k], prompt) if k == index else vit.step(frames[k])
        if k == n - 1 and index > 0:
            vit.seed(frames[index], prompt)
        if progress and (done % PROGRESS_EVERY == 0 or done == n):
            progress(done / n)
    present = np.array([b is not None for b in boxes])
    x, y, w, h = np.array([b or (np.nan,) * 4 for b in boxes], float).T
    return {'present': present, 'cx': x + w / 2, 'cy': y + h / 2, 'r': np.hypot(w, h) / 2,
            'area': np.nan_to_num(w * h), 'score': score, 'boxes': boxes}  # fmt: skip
