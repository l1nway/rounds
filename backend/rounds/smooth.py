import queue
import re
import subprocess
import sys
import threading
from functools import cache
from typing import NamedTuple

import numpy as np
import torch

from . import media, rife
from .color import GAMMA
from .config import FPS, OUT_SIZE, RIFE_WEIGHTS

PAD = 32
SNAP = 0.25
MAX_GAP = 1.0
DUP_LEVEL, DUP_GRID, DUP_STEP = 0.5, 8, 4
STAMP = re.compile(rb'\bn:\s*\d+\s+pts:\s*\S+\s+pts_time:(\S+)')
STAMP_WAIT = 60


class Anchor(NamedTuple):
    t: float
    luma: np.ndarray
    img: torch.Tensor
    feat: torch.Tensor


@cache
def model(device, side: int):
    net, head, dtype = rife.load(RIFE_WEIGHTS, device)
    return net, head, dtype, rife.grid(side, side, device)


# [DOC: timed-decode]
def decode(src, meta: dict, start: float, dur: float, pix_fmt: str, slow: bool) -> tuple[subprocess.Popen, queue.Queue]:
    head, cut = media.open_at(src, start, slow)
    chain = ','.join(x for x in (cut, f'trim=end={dur:.3f}', 'showinfo') if x)
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
    y = buf[: w * h].reshape(h, w)[::DUP_STEP, ::DUP_STEP]
    return y[: y.shape[0] // DUP_GRID * DUP_GRID, : y.shape[1] // DUP_GRID * DUP_GRID].astype(np.float32)


def still(a: np.ndarray, b: np.ndarray, level: float) -> bool:
    return np.abs(a - b).reshape(DUP_GRID, a.shape[0] // DUP_GRID, DUP_GRID, -1).mean((1, 3)).max() <= level


def pick(a: Anchor | None, b: Anchor, tau: float, bounds: np.ndarray, snap: float) -> tuple[Anchor | None, float]:
    if a is None or tau - a.t <= snap:
        return a or b, 0.0
    if b.t - a.t > MAX_GAP or ((bounds > a.t) & (bounds <= b.t)).any():
        return (a if tau - a.t < b.t - tau else b), 0.0
    return None, (tau - a.t) / (b.t - a.t)


def final(img: torch.Tensor) -> torch.Tensor:
    return img[0, :, PAD:-PAD, PAD:-PAD].float().clamp(0, 1) ** GAMMA


# [DOC: interpolation]
@torch.inference_mode()
def frames(src, meta: dict, start: float, n: int, rate: float, at, cuts, cut, raw, device, stats: dict, slow: bool,
           out: int = OUT_SIZE):  # fmt: skip
    (size, dtype, pix_fmt), (w, h), side = raw, (meta['width'], meta['height']), out + 2 * PAD
    net, head, half, base = model(device, side)
    level = DUP_LEVEL * (4 if dtype == np.int16 else 1)
    bounds, snap = (np.asarray(cuts, float) - 0.5) / FPS, SNAP / rate
    prev, slot, last, ended = None, 0, -1 / meta['fps'], False
    proc, stamps = decode(src, meta, start, n / rate + 2 / meta['fps'], pix_fmt, slow)
    try:
        for buf in media.reader(proc, sys.maxsize, size, dtype):
            raw_t = None if ended else stamps.get(timeout=STAMP_WAIT)
            ended = raw_t is None
            t = last = stamp(raw_t, last, meta['fps'])
            y = luma(buf, w, h)
            if prev is not None and t - prev.t < MAX_GAP and still(y, prev.luma, level):
                stats['dupes'] += 1
                continue
            img = (cut(buf, at(t * FPS)[0] * [1, 1, side / out], size=side).clamp(0, 1) ** (1 / GAMMA))[None]
            img = img.to(half)
            cur = Anchor(t, y, img, head(img))
            while slot < n and slot / rate < t - snap:
                hold, k = pick(prev, cur, slot / rate, bounds, snap)
                stats['synth'] += hold is None
                yield final(hold.img if hold else net(prev.img, cur.img, torch.full_like(img[:, :1], k), prev.feat,
                                                      cur.feat, base))  # fmt: skip
                slot += 1
            prev = cur
    finally:
        media.stop(proc)
    while prev is not None and slot < n:
        yield final(prev.img)
        slot += 1
