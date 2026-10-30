import base64
import contextlib
import math
from functools import partial
from pathlib import Path

import cv2
import numpy as np
import torch

from . import camera, color, deblur, encode, fill, look, media, motion, paint, repair, smooth, source, tags, upscale
from .config import FPS, OUT_SIZE
from .warp_np import GUARD, OVER
from .warp_np import weights as matrix

# [DOC: stabilization-warp]
BICUBIC = {'mode': 'bicubic', 'padding_mode': 'border', 'align_corners': False}
PROGRESS_EVERY = 15
FRAMES_SHARE = 0.6
# [DOC: look-preview]
WINDOW = 5
TAIL = 1.5
JPEG = [cv2.IMWRITE_JPEG_QUALITY, 85]


# [DOC: lanczos-matrix]
def weights(c: float, side: float, n: int, device, size: int = OUT_SIZE) -> tuple[int, int, torch.Tensor]:
    lo, hi, m = matrix(c, side, n, size)
    return lo, hi, torch.from_numpy(m).to(device)


def chroma_span(lo: int, hi: int, n: int) -> tuple[int, int]:
    return max(lo // 2 - 3, 0), min(hi // 2 + 4, n)


@torch.inference_mode()
def window(buf, box, geo, device, out: tuple[int, int], look=None) -> torch.Tensor:
    (w, h, cw, ch), (bits, full, matrix, transfer) = geo
    y0, y1, wy = weights(box[1], box[3], h, device, out[1])
    x0, x1, wx = weights(box[0], box[2], w, device, out[0])
    (cy0, cy1), (cx0, cx1) = chroma_span(y0, y1, ch), chroma_span(x0, x1, cw)
    lum = torch.from_numpy(buf[: w * h].reshape(h, w)[y0:y1, x0:x1]).to(device).float()
    uv = torch.from_numpy(buf[w * h :].reshape(2, ch, cw)[:, cy0:cy1, cx0:cx1]).to(device).float()
    uv = color.along(color.up2(uv, 0.0), -2, lambda x: color.up2(x, 0.5))
    uv = uv[:, y0 - 2 * cy0 : y1 - 2 * cy0, x0 - 2 * cx0 : x1 - 2 * cx0]
    lin = color.to_linear(color.yuv_to_rgb(lum, uv, matrix, bits, full), transfer)
    lin = wy @ lin @ wx.T
    return color.to_sdr(look(buf, box, geo, lin) if look and look.on else lin, transfer)


def crop(buf, row, geo, device, size: int = OUT_SIZE, look=None) -> torch.Tensor:
    if len(row) < 4 or not row[3]:
        return window(buf, (row[0], row[1], row[2], row[2]), geo, device, (size, size), look)
    return turned(buf, row, geo, device, size, look)


# [DOC: stabilization-warp]
@torch.inference_mode()
def turned(buf, row, geo, device, size: int, look) -> torch.Tensor:
    (cx, cy, side, angle), big = row[:4], OVER * size
    c, s = math.cos(angle), math.sin(angle)
    m, step = math.ceil(big * (abs(c) + abs(s))) + 2 * GUARD, side / big
    lin = window(buf, (cx, cy, m * step, m * step), geo, device, (m, m), look)
    v = (torch.arange(big, device=device, dtype=torch.float32) + 0.5) / big - 0.5
    gy, gx = torch.meshgrid(v * big, v * big, indexing='ij')
    grid = torch.stack([c * gx - s * gy, s * gx + c * gy], -1) * (2 / m)
    x = torch.nn.functional.grid_sample(lin[None], grid[None], **BICUBIC)
    _, _, w = weights(big / 2, big, big, device, size)
    return (w @ x[0].clamp(min=0) @ w.T).clamp(min=0)


def still(buf, geo, device, out: tuple[int, int], look) -> torch.Tensor:
    (w, h, _, _), _ = geo
    return window(buf, (w / 2, h / 2, w, h), geo, device, out, look)


def layout(meta: dict) -> tuple[tuple, tuple]:
    (w, h), deep = (meta['width'], meta['height']), meta['bit_depth'] > 8
    cw, ch = (w + 1) // 2, (h + 1) // 2
    matrix = meta.get('matrix') or ('bt709' if meta['transfer'] == 'sdr' else 'bt2020')
    geo = (w, h, cw, ch), (10 if deep else 8, meta.get('full_range', False), matrix, meta['transfer'])
    return geo, (w * h + 2 * cw * ch, np.int16 if deep else np.uint8, 'yuv420p10le' if deep else 'yuv420p')


def cfr(src, meta: dict, start: float, n: int, rate: float, at, cut, raw, slow: bool, clean=iter):
    size, dtype, pix_fmt = raw
    rows = at(np.arange(n) * FPS / rate)
    dec = media.decode(src, meta, start, n, '', pix_fmt, rate, slow)
    try:
        for k, buf in enumerate(clean(media.reader(dec, n, size, dtype))):
            yield cut(buf, rows[k])
    finally:
        media.stop(dec)


# [DOC: output-rate]
def render(src, meta: dict, start: float, end: float, path, cuts, out, options: dict, codec: str, tmp: str,
           progress=None, world=None) -> dict:  # fmt: skip
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    rate = source.out_rate(meta, options)
    n, (geo, raw) = media.frame_count(start, end, rate), layout(meta)
    up = upscale.wanted(meta, options)
    size = upscale.side(meta) if up else OUT_SIZE
    path = np.asarray(path, np.float64)
    base, mixed = camera.sampler(path, cuts), source.interpolating(meta, options)
    at = motion.placer(base, world) if world else base
    tone = look.Look(options.get('look', 0), options.get('exposure', 0), meta['transfer'], rate)
    cut = partial(crop, geo=geo, device=device, size=size, look=tone)
    stats = {'synth': 0, 'dupes': 0, 'seams': 0} if mixed else {}
    step, side = options.get('deblur', 0), float(np.median(path[:, 2]))  # [DOC: deblur]
    clean = deblur.cleaner(geo, meta['fps'] if mixed else rate, step, side, stats)
    if mixed:
        frames = media.retrying(
            lambda slow: smooth.frames(src, meta, start, n, rate, at, cuts, cut, raw, device, stats, slow, size, clean)
        )
    else:
        frames = media.retrying(lambda slow: cfr(src, meta, start, n, rate, at, cut, raw, slow, clean))
    if world:  # [DOC: edge-fill]
        fills = paint.frames if paint.wanted() else fill.frames  # [DOC: propainter-fill]
        frames = fills(frames, fill.Edges(base, world, size, rate, mixed, device), n)
    if tone.repair > 0:  # [DOC: repair]
        frames = repair.frames(frames, device, tone.repair, rate)
    if up:
        frames = upscale.frames(frames, device)
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


# [DOC: look-preview]
def preview(src, meta: dict, at: float, value: float, ev: float, size: tuple[int, int], nets: tuple) -> dict:
    device, (geo, raw), fps = torch.device('cuda' if torch.cuda.is_available() else 'cpu'), layout(meta), meta['fps']
    at = min(at, max(0.0, meta['duration'] - TAIL / fps))  # [DOC: preview-tail]
    tone, k = look.Look(value, ev, meta['transfer'], fps), min(WINDOW // 2, round(at * fps))

    def cut(buf, _):
        return still(buf, geo, device, size, tone)

    shots = list(media.retrying(lambda slow: cfr(src, meta, at - k / fps, WINDOW, fps, np.zeros_like, cut, raw, slow)))
    if not shots:
        raise source.Unreadable(media.NO_RANGE)
    window = [shots[min(max(i, 0), len(shots) - 1)] for i in range(k - WINDOW // 2, k + WINDOW // 2 + 1)]
    rgb = repair.middle(window, nets, tone.repair) if tone.repair > 0 else window[WINDOW // 2]
    v = (rgb.clamp(0, 1) ** (1 / color.GAMMA) * 255).round().byte().permute(1, 2, 0).cpu().numpy()
    data = cv2.imencode('.jpg', cv2.cvtColor(v, cv2.COLOR_RGB2BGR), JPEG)[1]
    return {'image': 'data:image/jpeg;base64,' + base64.b64encode(data).decode(), 'width': size[0], 'height': size[1]}
