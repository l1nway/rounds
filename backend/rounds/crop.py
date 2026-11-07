import contextlib
from pathlib import Path

import cv2
import numpy as np

from . import encode, freelook, freestab, media, source, tags
from .config import FPS, OUT_SIZE

# [DOC: free-frame]
ZOOM_MARGIN = 1.6
ZOOM_FLOOR = 0.25
PROGRESS_EVERY = 15
FRAMES_SHARE = 0.6
GEO = (OUT_SIZE, OUT_SIZE, OUT_SIZE // 2, OUT_SIZE // 2), (8, False, 'bt709', 'sdr')
FRAME_BYTES = OUT_SIZE * OUT_SIZE * 3 // 2


# [DOC: free-frame]
def centre(prompt: dict, w: int, h: int) -> tuple[float, float, float | None]:
    if box := prompt.get('box'):
        x0, y0, x1, y1 = box
        return (x0 + x1) / 2 * w, (y0 + y1) / 2 * h, max((x1 - x0) * w, (y1 - y0) * h)
    if picked := [(x, y) for x, y, label in prompt.get('points') or () if label == 1]:
        return np.mean([p[0] for p in picked]) * w, np.mean([p[1] for p in picked]) * h, None
    return w / 2, h / 2, None


def frame(meta: dict, prompt: dict, zoom: bool) -> tuple[int, int, int]:
    w, h = meta['width'], meta['height']
    cx, cy, span = centre(prompt, w, h)
    side, fit = min(w, h), 1 if prompt.get('crop') else zoom and ZOOM_MARGIN  # [DOC: crop-mode]
    if fit and span:
        side = min(side, max(span * fit, side * ZOOM_FLOOR))
    side = int(side) // 2 * 2
    return side, int(np.clip(cx - side / 2, 0, w - side)), int(np.clip(cy - side / 2, 0, h - side))


def frames(src, meta: dict, start: float, n: int, rate: float, vf: str, size: int = FRAME_BYTES):
    def make(slow: bool):
        dec = media.decode(src, meta, start, n, vf, 'yuv420p', rate, slow)
        try:
            yield from media.reader(dec, n, size, np.uint8)
        finally:
            media.stop(dec)

    return media.retrying(make)


# [DOC: free-follow]
def followed(src, meta: dict, request: dict, rate: float, n: int) -> dict | None:
    from . import camera, devicetrack, locate

    if not locate.follows(meta, request):
        return None
    hit, size = devicetrack.hit(src, meta, request), (meta['width'], meta['height'])
    path = camera.solve(hit['found'], *size, hit['cuts'], FPS, request['options'].get('zoom', False))
    return {**hit, 'rows': camera.sampler(path, hit['cuts'])(np.arange(n) * FPS / rate)}


def window(cx: float, cy: float, side: float, w: int, h: int) -> tuple[int, int, int]:
    s = min(media.even(side), w // 2 * 2, h // 2 * 2)
    x, y = (int(np.clip(round((c - s / 2) / 2) * 2, 0, top - s)) for c, top in ((cx, w), (cy, h)))
    return s, x, y


# [DOC: free-follow]
def moving(src, meta: dict, start: float, n: int, rate: float, rows: np.ndarray):
    k = min(1.0, OUT_SIZE / rows[:, 2].min())
    w, h = media.even(meta['width'] * k), media.even(meta['height'] * k)
    area, half = w * h, OUT_SIZE // 2
    for i, buf in enumerate(frames(src, meta, start, n, rate, media.sdr_chain(meta, w, h), area * 3 // 2)):
        s, x, y = window(*(rows[min(i, len(rows) - 1)] * k), w, h)
        planes = buf[:area].reshape(h, w), buf[area : area * 5 // 4].reshape(h // 2, w // 2), buf[area * 5 // 4 :]
        y_plane = cv2.resize(planes[0][y : y + s, x : x + s], (OUT_SIZE, OUT_SIZE), interpolation=cv2.INTER_AREA)
        uv = (cv2.resize(p.reshape(h // 2, w // 2)[y // 2 : (y + s) // 2, x // 2 : (x + s) // 2], (half, half),
                         interpolation=cv2.INTER_AREA) for p in planes[1:])  # fmt: skip
        yield np.concatenate([y_plane.ravel(), *(p.ravel() for p in uv)])


# [DOC: free-render]
def render(src, meta: dict, request: dict, out, tmp: str, progress=None) -> dict:
    options = {**request['options'], 'denoise': request.get('denoise', 0)}
    start, end, codec = request['start'], request['end'], request.get('codec', 'av1')
    rate = source.out_rate(meta, {})
    n = media.frame_count(start, end, rate)
    side, x, y = frame(meta, request['prompt'], options.get('zoom', False))
    vf = f'crop={side}:{side}:{x}:{y},{media.sdr_chain(meta, OUT_SIZE, OUT_SIZE)}'
    clean = iter
    if step := request.get('deblur', 0):  # [DOC: deblur]
        from . import deblur

        clean = deblur.cleaner(GEO, rate, step, OUT_SIZE, {})
    graded, steady = request.get('look') or request.get('exposure'), request.get('stabilize')
    hit = followed(src, meta, request, rate, n)  # [DOC: free-follow]
    stream = clean(moving(src, meta, start, n, rate, hit['rows']) if hit else frames(src, meta, start, n, rate, vf))
    size = meta['width'], meta['height']
    if graded and hit and not steady:
        stream = freestab.frames(src, meta, request, rate, n, freestab.framed(hit['rows'], size))
    elif graded and not hit:  # [DOC: free-look]
        stream = freelook.frames(src, meta, start, n, rate, (side, x, y), request['look'], request['exposure'])
    if steady:  # [DOC: free-stabilization]
        at = centre(request['prompt'], *size)
        if plan := freestab.plan(src, meta, request, rate, n, at, (side, x, y), hit):
            stream = freestab.frames(src, meta, request, rate, n, plan)
    first = encode.first_pass(tmp, codec, rate, n / rate, meta['has_audio'])
    q, t = encode.writer(tmp, first)
    k, last = 0, None
    try:
        with contextlib.closing(stream):
            for buf in stream:
                last = buf.tobytes()
                q.put(last)
                k += 1
                if progress and k % PROGRESS_EVERY == 0:
                    progress(FRAMES_SHARE * k / n)
        if last is None:
            raise source.Unreadable(media.NO_RANGE)
    except BaseException:
        first.kill()
        first.wait()  # [DOC: killed-pass]
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
    return {'size': Path(out).stat().st_size, 'duration': n / rate, 'rate': rate, 'frames': n, 'codec': codec,
            'fit': round(scale, 2), 'frame': (side, x, y)}  # fmt: skip
