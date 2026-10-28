import bisect
import math
import queue
import re
import subprocess
import sys
import threading
from functools import cache
from typing import NamedTuple

import numpy as np
import torch

from . import media, rife, seam
from .color import GAMMA
from .config import FPS, OUT_SIZE, RIFE_WEIGHTS

PAD = 32
SNAP = 0.25
MAX_GAP = 1.0
DUP_LEVEL, DUP_GRID, DUP_STEP = 2.0, 16, 4
STAMP = re.compile(rb'\bn:\s*\d+\s+pts:\s*\S+\s+pts_time:(\S+)')
STAMP_WAIT = 60


class Anchor(NamedTuple):
    t: float
    luma: np.ndarray
    img: torch.Tensor
    feat: torch.Tensor
    jump: float


@cache
def model(device, side: int):
    net, head, dtype = rife.load(RIFE_WEIGHTS, device)
    return net, head, dtype, rife.grid(side, side, device)


# [DOC: timed-decode]
def decode(src, meta: dict, start: float, dur: float, pix_fmt: str, slow: bool,
           vf: str = '') -> tuple[subprocess.Popen, queue.Queue]:  # fmt: skip
    head, cut = media.open_at(src, start, slow)
    chain = ','.join(x for x in (cut, f'trim=end={dur:.3f}', vf, 'showinfo') if x)
    cmd = ['ffmpeg', '-v', 'level+info', '-hide_banner', '-nostats', '-nostdin', *head, '-map', media.video(meta),
           '-vf', chain, '-fps_mode', 'passthrough', '-pix_fmt', pix_fmt, '-f', 'rawvideo', 'pipe:1']  # fmt: skip
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    stamps = queue.Queue()

    def drain():
        for line in proc.stderr:
            if m := STAMP.search(line):
                stamps.put(m[1].decode())
            elif b'[error]' in line or b'[fatal]' in line:
                sys.stderr.buffer.write(line)
        stamps.put(None)

    threading.Thread(target=drain, daemon=True).start()
    return proc, stamps


def stamp(raw: str | None, last: float, fps: float) -> float:
    try:
        t = float(raw)
    except (TypeError, ValueError):
        t = last + 1 / fps
    return t if t > last else last + 1e-3


# [DOC: duplicate-frames]
def luma(buf: np.ndarray, w: int, h: int) -> np.ndarray:
    s = DUP_STEP
    y = buf[: w * h].reshape(h, w)[: h // s * s, : w // s * s]
    return y.reshape(h // s, s, w // s, s).mean((1, 3), dtype=np.float32)


def cells(v: np.ndarray) -> np.ndarray:
    return v.reshape(DUP_GRID, v.shape[0] // DUP_GRID, DUP_GRID, -1).sum((1, 3))


@cache
def disc(k: int) -> tuple[np.ndarray, np.ndarray]:
    r = np.arange(k) + 0.5 - k / 2
    mask = np.hypot(*np.meshgrid(r, r)) <= k / 2
    return mask, cells(mask)


def moved(a: np.ndarray, b: np.ndarray, win: np.ndarray) -> np.ndarray:
    k = min(max(int(win[2] / DUP_STEP) // DUP_GRID * DUP_GRID, DUP_GRID), min(a.shape) // DUP_GRID * DUP_GRID)
    x, y = np.clip(np.round(win[:2] / DUP_STEP - k / 2), 0, np.subtract(a.shape[::-1], k)).astype(int)
    mask, inside = disc(k)
    return (cells(np.abs(a - b)[y : y + k, x : x + k] * mask) / np.maximum(inside, 1))[inside >= inside.max() / 4]


def pick(a: Anchor | None, b: Anchor, tau: float, bounds: np.ndarray, snap: float) -> tuple[Anchor | None, float]:
    if a is None or b.t - tau <= snap < tau - a.t:
        return b, 0.0
    if tau - a.t <= snap:
        return a, 0.0
    if b.t - a.t > MAX_GAP or ((bounds > a.t) & (bounds <= b.t)).any():
        return (a if tau - a.t < b.t - tau else b), 0.0
    return None, (tau - a.t) / (b.t - a.t)


# [DOC: seams]
def switch(chain: list[Anchor], level: float, plain: bool) -> Anchor | None:
    for x, y in zip(reversed(chain[:-2]), reversed(chain[1:-1]), strict=True):
        if chain[-2].t - y.t > seam.LONE:
            break
        if y.jump > level:
            return x
    return chain[-2] if chain[-1].jump > level or plain else None


def final(img: torch.Tensor) -> torch.Tensor:
    return img[0, :, PAD:-PAD, PAD:-PAD].float().clamp(0, 1) ** GAMMA


# [DOC: interpolation]
@torch.inference_mode()
def frames(src, meta: dict, start: float, n: int, rate: float, at, cuts, cut, raw, device, stats: dict, slow: bool,
           out: int = OUT_SIZE, clean=iter):  # fmt: skip
    (size, dtype, pix_fmt), (w, h), side = raw, (meta['width'], meta['height']), out + 2 * PAD
    net, head, half, base = model(device, side)
    deep = 4 if dtype == np.int16 else 1
    level, jump = DUP_LEVEL * deep, seam.CUT_LEVEL * deep
    bounds, snap, end = (np.asarray(cuts, float) - 0.5) / FPS, SNAP / rate, n / rate
    kept, seams, slot, last, ended = [], [], 0, -1 / meta['fps'], False

    def image(s: float) -> torch.Tensor:
        i = bisect.bisect_right(kept, s, key=lambda x: x.t)
        if i == len(kept):
            return kept[-1].img
        a, b = kept[i - 1] if i else None, kept[i]
        hold, k = pick(a, b, s, bounds, snap)
        stats['synth'] += hold is None
        return hold.img if hold else net(a.img, b.img, torch.full_like(b.img[:, :1], k), a.feat, b.feat, base)

    def emit(top: float):
        nonlocal slot
        while slot < n:
            parts, soft = seam.sources(slot / rate, seams)
            if slot / rate >= top - seam.LONE - seam.LEAD or parts[-1][0] >= top - snap:
                return
            while len(kept) > 1 and kept[1].t <= parts[0][0]:
                kept.pop(0)
            yield final(seam.dissolve([(image(s), k) for s, k in parts], soft))
            slot += 1

    proc, stamps = decode(src, meta, start, n / rate + 2 / meta['fps'], pix_fmt, slow)
    try:
        for buf in clean(media.reader(proc, sys.maxsize, size, dtype)):  # [DOC: deblur]
            raw_t = None if ended else stamps.get(timeout=STAMP_WAIT)
            ended = raw_t is None
            t = stamp(raw_t, last, meta['fps'])
            gap, last = t - last, t
            y, win = luma(buf, w, h), at(t * FPS)[0]
            diff = moved(y, kept[-1].luma, win) if kept else np.zeros(1)
            if kept and gap <= seam.HOLE and t - kept[-1].t < MAX_GAP and diff.max() <= level:
                stats['dupes'] += 1
                continue
            img = (cut(buf, np.r_[win[:2], win[2] * side / out, win[3:]], size=side).clamp(0, 1) ** (1 / GAMMA))[None]
            img = img.to(half)
            kept.append(Anchor(t, y, img, head(img), float(diff.mean())))
            frozen = diff.max() <= level
            if len(kept) > 1 and gap > seam.HOLE and (a := switch(kept, jump, gap > MAX_GAP or frozen)):
                seams.append(seam.make(a.t, t, end, float(moved(y, a.luma, win).mean()) / jump))
                stats['seams'] += 1
            yield from emit(t)
    finally:
        media.stop(proc)
    if kept:
        yield from emit(math.inf)
