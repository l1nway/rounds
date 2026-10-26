import contextlib
import math
import queue
import subprocess
import threading
from functools import partial
from pathlib import Path

import numpy as np
import torch

from . import camera, color, media, smooth, source, tags
from .config import FPS, OUT_SIZE

X264 = ['-c:v', 'libx264', '-preset', 'slower', '-crf', '16', '-tune', 'film', '-profile:v', 'high',
        '-pix_fmt', 'yuv420p', '-g', '60']  # fmt: skip
MAXRATE, LEVEL = 6000, '4.2'
AAC = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
TAPS = 3
DEPTH = 4
PROGRESS_EVERY = 15


# [DOC: lanczos-matrix]
def weights(c: float, side: float, n: int, device, size: int = OUT_SIZE) -> tuple[int, int, torch.Tensor]:
    s = side / size
    sc = max(s, 1.0)
    u = c - side / 2 - 0.5 + (torch.arange(size, device=device, dtype=torch.float64) + 0.5) * s
    idx = torch.floor(u - TAPS * sc).long()[:, None] + 1 + torch.arange(math.ceil(2 * TAPS * sc) + 1, device=device)
    w = color.lanczos((idx - u[:, None]) / sc)
    idx = idx.clamp(0, n - 1)  # [DOC: edge-fill]
    lo, hi = int(idx.min()), int(idx.max()) + 1
    m = torch.zeros(size, hi - lo, device=device, dtype=torch.float64).scatter_add_(1, idx - lo, w)
    return lo, hi, (m / m.sum(1, keepdim=True)).float()


def chroma_span(lo: int, hi: int, n: int) -> tuple[int, int]:
    return max(lo // 2 - 3, 0), min(hi // 2 + 4, n)


@torch.inference_mode()
def crop(buf, row, geo, device, size: int = OUT_SIZE) -> torch.Tensor:
    (w, h, cw, ch), (bits, full, matrix, transfer) = geo
    y0, y1, wy = weights(row[1], row[2], h, device, size)
    x0, x1, wx = weights(row[0], row[2], w, device, size)
    (cy0, cy1), (cx0, cx1) = chroma_span(y0, y1, ch), chroma_span(x0, x1, cw)
    lum = torch.from_numpy(buf[: w * h].reshape(h, w)[y0:y1, x0:x1]).to(device).float()
    uv = torch.from_numpy(buf[w * h :].reshape(2, ch, cw)[:, cy0:cy1, cx0:cx1]).to(device).float()
    uv = color.along(color.up2(uv, 0.0), -2, lambda x: color.up2(x, 0.5))
    uv = uv[:, y0 - 2 * cy0 : y1 - 2 * cy0, x0 - 2 * cx0 : x1 - 2 * cx0]
    lin = color.to_linear(color.yuv_to_rgb(lum, uv, matrix, bits, full), transfer)
    return color.to_sdr(wy @ lin @ wx.T, transfer)


def cfr(src, meta: dict, start: float, n: int, rate: float, at, cut, raw, slow: bool):
    size, dtype, pix_fmt = raw
    rows = at(np.arange(n) * FPS / rate)
    dec = media.decode(src, meta, start, n, '', pix_fmt, rate, slow)
    try:
        for k, buf in enumerate(media.reader(dec, n, size, dtype)):
            yield cut(buf, rows[k])
    finally:
        media.stop(dec)


# [DOC: output-encode]
def sized(size: int) -> list[str]:
    rate, level = round(MAXRATE * (size / OUT_SIZE) ** 1.5), ['-level:v', LEVEL] if size > OUT_SIZE else []
    return ['-maxrate', f'{rate}k', '-bufsize', f'{2 * rate}k', *level]


def writer(proc) -> tuple[queue.Queue, threading.Thread]:
    q = queue.Queue(DEPTH)

    def run():
        ok = True
        while (b := q.get()) is not None:
            if ok:
                try:
                    proc.stdin.write(b)
                except OSError:
                    ok = False
        with contextlib.suppress(OSError):
            proc.stdin.close()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return q, t


def encoder(src, meta: dict, start: float, dur: float, rate: float, out, options: dict, size: int) -> subprocess.Popen:
    # [DOC: render-options]
    audio = ['-map', '1:a:0', '-af', media.audio_filter(src, start, dur, options), *AAC] if meta['has_audio'] else []
    cmd = ['ffmpeg', '-v', 'error', '-y', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
           '-s', f'{size}x{size}', '-framerate', str(rate), '-i', 'pipe:0',
           *media.audio_input(src, meta, start, dur),
           '-map', '0:v', '-vf', f'{media.BT709},setsar=1', *X264, *sized(size), *audio,
           *tags.created(tags.kept(meta, options)), '-t', f'{dur:.3f}', '-movflags', '+faststart',
           str(out)]  # fmt: skip
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


# [DOC: output-rate]
def render(src, meta: dict, start: float, end: float, path, cuts, out, options: dict, progress=None) -> dict:
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    rate, size = source.out_rate(meta, options), source.out_size(meta, options)
    n, (w, h), bits = media.frame_count(start, end, rate), (meta['width'], meta['height']), max(meta['bit_depth'], 8)
    cw, ch = (w + 1) // 2, (h + 1) // 2
    deep = bits > 8
    matrix = meta.get('matrix') or ('bt709' if meta['transfer'] == 'sdr' else 'bt2020')
    geo = (w, h, cw, ch), (10 if deep else 8, meta.get('full_range', False), matrix, meta['transfer'])
    raw = w * h + 2 * cw * ch, np.int16 if deep else np.uint8, 'yuv420p10le' if deep else 'yuv420p'
    at, stats = camera.sampler(np.asarray(path, np.float64), cuts), {}
    cut = partial(crop, geo=geo, device=device, size=size)
    if source.interpolating(meta, options):
        stats = {'synth': 0, 'dupes': 0}
        frames = media.retrying(
            lambda slow: smooth.frames(src, meta, start, n, rate, at, cuts, cut, size, raw, device, stats, slow)
        )
    else:
        frames = media.retrying(lambda slow: cfr(src, meta, start, n, rate, at, cut, raw, slow))
    enc = encoder(src, meta, start, n / rate, rate, out, options, size)
    q, t = writer(enc)
    noise, k, last = color.dither(size, device), 0, None
    try:
        with torch.inference_mode(), contextlib.closing(frames):
            for rgb in frames:
                last = color.encode(rgb, noise).cpu().numpy()
                q.put(last)
                k += 1
                if progress and k % PROGRESS_EVERY == 0:
                    progress(k / n)
    except BaseException:
        enc.kill()
        raise
    if last is None:
        enc.kill()
        raise source.Unreadable(media.NO_RANGE)
    for _ in range(n - k):
        q.put(last)
    q.put(None)
    t.join()
    if enc.wait():
        raise RuntimeError(f'encoder failed (ffmpeg exit {enc.returncode})')
    tags.write(out, tags.kept(meta, options))
    if progress:
        progress(1.0)
    return {'size': Path(out).stat().st_size, 'side': size, 'duration': n / rate, 'rate': rate, 'frames': n, **stats}
