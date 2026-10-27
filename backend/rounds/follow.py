import tempfile
from collections.abc import Callable

import cv2
import numpy as np
import torch
from transformers import Sam2VideoModel

from . import media
from .config import FPS, SAM_MODEL

DTYPE = torch.bfloat16
RATES = 10, 6, 5
STEPS = 360


# [DOC: track-preview]
def load() -> Sam2VideoModel:
    return Sam2VideoModel.from_pretrained(SAM_MODEL, dtype=DTYPE).eval()


def grid(time: float, start: float, end: float) -> tuple[int, float, int, int]:
    rate = next((r for r in RATES if (end - start) * r <= STEPS), RATES[-1])
    anchor = int(time * FPS + 1e-3) / FPS
    before, after = int((anchor - start) * rate + 1e-6), int((end - anchor) * rate + 1e-6)
    return rate, anchor - before / rate, before, before + after + 1


def frames(proxy: str, size: tuple[int, int], t0: float, n: int, rate: int, file) -> np.ndarray:
    w, h = size
    out = np.memmap(file, np.uint8, 'w+', shape=(n, h, w, 3))
    if not media.fill(media.decode(proxy, {}, t0, n, '', 'rgb24', rate=rate), out, n):
        raise ValueError(media.NO_RANGE)
    return out


# [DOC: track-preview]
def bounds(logits: torch.Tensor, score: float, keep: float, least: float) -> list[float] | None:
    _, _, stats, _ = cv2.connectedComponentsWithStats((logits > 0).to(torch.uint8).cpu().numpy(), connectivity=8)
    areas, (h, w) = stats[1:, cv2.CC_STAT_AREA], logits.shape
    if score <= 0 or areas.sum() < least * h * w:
        return None
    kept = stats[1:][areas >= keep * areas.max()]
    x0, y0, x1, y1 = *kept[:, :2].min(0), *(kept[:, :2] + kept[:, 2:4]).max(0)
    return [round(float(v), 4) for v in (x0 / w, y0 / h, x1 / w, y1 / h)]


# [DOC: track-preview]
def follow(net: Sam2VideoModel, proxy: str, size: tuple[int, int], prompt: dict, start: float, end: float,
           stop: Callable[[], bool] = lambda: False) -> dict | None:  # fmt: skip
    from . import track  # no gpu at snapshot

    rate, t0, index, n = grid(prompt['time'], start, end)
    (w, h), side = size, net.config.image_size
    lifted = track._mask(prompt['mask'], side) if prompt.get('mask') else None
    points = [(x * w, y * h, label) for x, y, label in prompt.get('points') or []]
    box = [v * s for v, s in zip(prompt['box'], (w, h, w, h), strict=True)] if prompt.get('box') else None
    query = {'mask': lifted} if lifted is not None else track._prompt(points, box, h, w, side)
    boxes = [None] * n
    with tempfile.TemporaryFile() as tmp, torch.inference_mode():
        clip = frames(proxy, size, t0, n, rate, tmp)
        for reverse in (False, True):
            for k, out in track._pass(net, clip, index, query, reverse):
                if stop():
                    return None
                logits, score = out.pred_masks[0, 0], out.object_score_logits.item()
                boxes[k] = bounds(logits, score, track.KEEP_BLOB, track.MIN_AREA)
    return {'fps': rate, 'start': round(t0, 3), 'boxes': boxes}
