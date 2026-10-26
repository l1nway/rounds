import contextlib
import math
import tempfile
from functools import partial
from pathlib import Path

import numpy as np
import torch

from . import camera, color, encode, media, smooth, source, tags, upscale
from .config import FPS, OUT_SIZE

TAPS = 3
PROGRESS_EVERY = 15
FRAMES_SHARE = 0.6


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


# [DOC: output-rate]
def render(
    src, meta: dict, start: float, end: float, path, cuts, out, options: dict, codec: str, progress=None
) -> dict:
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    rate = source.out_rate(meta, options)
    n, (w, h), bits = media.frame_count(start, end, rate), (meta['width'], meta['height']), max(meta['bit_depth'], 8)
    cw, ch = (w + 1) // 2, (h + 1) // 2
    deep = bits > 8
    matrix = meta.get('matrix') or ('bt709' if meta['transfer'] == 'sdr' else 'bt2020')
    geo = (w, h, cw, ch), (10 if deep else 8, meta.get('full_range', False), matrix, meta['transfer'])
    raw = w * h + 2 * cw * ch, np.int16 if deep else np.uint8, 'yuv420p10le' if deep else 'yuv420p'
    up = upscale.wanted(meta, options)
    size = upscale.side(meta) if up else OUT_SIZE
    at, stats = camera.sampler(np.asarray(path, np.float64), cuts), {}
    cut = partial(crop, geo=geo, device=device, size=size)
    if source.interpolating(meta, options):
        stats = {'synth': 0, 'dupes': 0}
        frames = media.retrying(
            lambda slow: smooth.frames(src, meta, start, n, rate, at, cuts, cut, raw, device, stats, slow, size)
        )
    else:
        frames = media.retrying(lambda slow: cfr(src, meta, start, n, rate, at, cut, raw, slow))
    if up:
        frames = upscale.frames(frames, device)
    with tempfile.TemporaryDirectory() as tmp:
        first = encode.first_pass(tmp, codec, rate, n / rate, meta['has_audio'])
        q, t = encode.writer(tmp, first)
        noise, k, last = color.dither(OUT_SIZE, device), 0, None
        try:
            with torch.inference_mode(), contextlib.closing(frames):
                for rgb in frames:
                    last = color.encode(rgb, noise).cpu().numpy()
                    q.put(last)
                    k += 1
                    if progress and k % PROGRESS_EVERY == 0:
                        progress(FRAMES_SHARE * k / n)
            if last is None:
                raise source.Unreadable(media.NO_RANGE)
        except BaseException:
            first.kill()
            q.put(None)
            raise
        for _ in range(n - k):
            q.put(last)
        q.put(None)
        t.join()
        if first.wait():
            raise RuntimeError(f'first pass failed (ffmpeg exit {first.returncode})')
        tail = progress and (lambda f: progress(FRAMES_SHARE + (1 - FRAMES_SHARE) * f))
        scale = encode.second_pass(tmp, src, meta, start, n / rate, n, rate, out, options, codec, tail)
    tags.write(out, tags.kept(meta, options))
    if progress:
        progress(1.0)
    return {'size': Path(out).stat().st_size, 'duration': n / rate, 'rate': rate, 'frames': n, 'codec': codec,
            'fit': round(scale, 2), 'upscale': up, **stats}  # fmt: skip
