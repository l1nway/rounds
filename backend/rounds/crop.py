import tempfile
from pathlib import Path

import numpy as np

from . import encode, media, source, tags
from .config import OUT_SIZE

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
    side = min(w, h)
    if zoom and span:
        side = min(side, max(span * ZOOM_MARGIN, side * ZOOM_FLOOR))
    side = int(side) // 2 * 2
    return side, int(np.clip(cx - side / 2, 0, w - side)), int(np.clip(cy - side / 2, 0, h - side))


def frames(src, meta: dict, start: float, n: int, rate: float, vf: str):
    def make(slow: bool):
        dec = media.decode(src, meta, start, n, vf, 'yuv420p', rate, slow)
        try:
            yield from media.reader(dec, n, FRAME_BYTES, np.uint8)
        finally:
            media.stop(dec)

    return media.retrying(make)


# [DOC: free-render]
def render(src, meta: dict, request: dict, out, progress=None) -> dict:
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
    with tempfile.TemporaryDirectory() as tmp:
        first = encode.first_pass(tmp, codec, rate, n / rate, meta['has_audio'])
        q, t = encode.writer(tmp, first)
        k, last = 0, None
        try:
            for buf in clean(frames(src, meta, start, n, rate, vf)):
                last = buf.tobytes()
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
    return {'size': Path(out).stat().st_size, 'duration': n / rate, 'rate': rate, 'frames': n, 'codec': codec,
            'fit': round(scale, 2), 'frame': (side, x, y)}  # fmt: skip
