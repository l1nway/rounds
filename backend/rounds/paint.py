import contextlib
import itertools
import zlib

import modal
import numpy as np
import torch
import torch.nn.functional as F

from . import fill
from .color import GAMMA
from .config import FPS, OUT_SIZE
from .painter import WORKERS, Painter
from .upscale import DEPTH, pack, unpack

# [DOC: propainter-fill]
LEAD, TAIL, MIN_CHUNK, MAX_CHUNK = 40, 24, 150, 300
DILATE, ALIGN = 4, 8
WAIT = 1500


def wanted() -> bool:
    return not modal.is_local()


def plan(n: int) -> list[tuple[int, int, int, int]]:
    k = max(-(-n // MAX_CHUNK), min(WORKERS, n // MIN_CHUNK), 1)
    edges = [round(i * n / k) for i in range(k + 1)]
    return [(max(0, a - LEAD), a, b, min(n, b + TAIL)) for a, b in itertools.pairwise(edges)]


def side(edges: fill.Edges, n: int) -> int:
    footprint = min(float(np.median(edges.at(np.arange(n) * FPS / edges.rate)[:, 2])), edges.size)
    return min(ALIGN * int(footprint // ALIGN), OUT_SIZE)


def disc(size: int, device) -> torch.Tensor:
    v = torch.arange(size, device=device, dtype=torch.float32) + 0.5 - size / 2
    return torch.hypot(v[:, None], v[None]) <= size / 2 + fill.FEATHER


def shrink(x: torch.Tensor, work: int) -> torch.Tensor:
    return x if x.shape[-1] == work else F.interpolate(x[None], size=(work, work), mode='area')[0]


def hole_mask(hole: torch.Tensor, work: int) -> np.ndarray:
    m = shrink(hole.float()[None], work)[None] > 0
    return F.max_pool2d(m.float(), 2 * DILATE + 1, 1, DILATE)[0, 0].bool().cpu().numpy()


def send(imgs: list, masks: list, span: tuple, work: int, device):
    s, a, b, e = span
    gamma = [(shrink(imgs[k].to(device).float(), work).clamp(0, 1) ** (1 / GAMMA) * DEPTH).round() for k in range(s, e)]
    video = torch.stack(gamma).permute(0, 2, 3, 1).cpu().numpy().astype(np.uint16)
    holes = zlib.compress(np.concatenate(masks[s:e]).tobytes())
    return Painter().run.spawn(pack(video), holes, work, a - s, b - a)


def blend(img: torch.Tensor, painted: np.ndarray, hole: torch.Tensor) -> torch.Tensor:
    up = torch.from_numpy(painted.astype(np.float32)).to(img.device).permute(2, 0, 1) / DEPTH
    if up.shape[-1] != img.shape[-1]:
        up = F.interpolate(up[None], size=img.shape[-2:], mode='bicubic', align_corners=False)[0]
    keep = fill.alpha(hole)
    return keep * img + (1 - keep) * up.clamp(0, 1) ** GAMMA


def painted(call, edges: fill.Edges, span: tuple, work: int, imgs: list, holed: list, ring, stats: dict):
    s, a, b, e = span
    try:
        out = iter(unpack(call.get(timeout=WAIT), work))
    except Exception as error:  # [DOC: propainter-fallback]
        if isinstance(error, TimeoutError):
            call.cancel()
        print(f'paint {a}-{b} failed, fill instead: {error!r}', flush=True)
        stats['fallback'] += 1
        yield from fill.frames((imgs[k].to(edges.device).float() for k in range(a, b)), edges, b - a, start=a)
        return
    for k in range(a, b):
        img = imgs[k].to(edges.device).float()
        if holed[k]:
            stats['painted'] += 1
            img = blend(img, next(out), edges.bad(k) & ring)
        yield img


# [DOC: propainter-fill]
@torch.inference_mode()
def frames(stream, edges: fill.Edges, n: int):
    spans, ring, work, stats = plan(n), disc(edges.size, edges.device), None, {'painted': 0, 'fallback': 0}
    imgs, masks, holed, calls = [], [], [], {}
    try:
        with contextlib.closing(stream):
            for k, img in enumerate(stream):
                hole = edges.bad(k) & ring
                work = work or side(edges, n)
                imgs.append(img.half().cpu())
                masks.append(np.packbits(hole_mask(hole, work)))
                holed.append(bool(hole.any()))
                for i, span in enumerate(spans):
                    if span[3] == k + 1 and any(holed[span[1] : span[2]]):
                        calls[i] = send(imgs, masks, span, work, edges.device)
        got = len(imgs)
        for i, (s, a, b, e) in enumerate(spans):
            if i not in calls and e > got > a and any(holed[a : min(b, got)]):
                calls[i] = send(imgs, masks, (s, a, min(b, got), got), work, edges.device)
        for i, (s, a, b, e) in enumerate(spans):
            span = s, min(a, got), min(b, got), min(e, got)
            if i in calls:
                yield from painted(calls.pop(i), edges, span, work, imgs, holed, ring, stats)
            else:
                yield from (imgs[k].to(edges.device).float() for k in range(span[1], span[2]))
        print(f'paint: {stats["painted"]} frames painted, {stats["fallback"]} chunks filled instead', flush=True)
    finally:
        for call in calls.values():
            call.cancel()
