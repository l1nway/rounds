import math
from functools import cache
from typing import NamedTuple

import torch
import torch.nn.functional as F

HOLE, LONE, LEAD, FADE = 0.25, 0.2, 0.75, 0.3
CUT_LEVEL, BLUR = 50.0, 0.02


class Seam(NamedTuple):
    a: float
    b: float
    lo: float
    hi: float
    f0: float
    f1: float
    soft: float


# [DOC: seams]
def make(a: float, b: float, end: float, soft: float) -> Seam:
    mid = (a + b) / 2
    f0, f1 = mid - FADE / 2, mid + FADE / 2
    return Seam(a, b, max(a - LEAD, 0.0), max(min(b + LEAD, end), f1), f0, f1, min(soft, 1.0))


def sources(tau: float, seams) -> tuple[list[tuple[float, float]], float]:
    for s in seams:
        if s.lo <= tau <= s.hi:
            old = s.lo + (tau - s.lo) * (s.a - s.lo) / (s.f1 - s.lo)
            new = s.b + (tau - s.f0) * (s.hi - s.b) / (s.hi - s.f0)
            w = min(max((tau - s.f0) / FADE, 0.0), 1.0)
            w = w * w * (3 - 2 * w)
            return [(t, k) for t, k in ((min(old, s.a), 1 - w), (max(new, s.b), w)) if k > 0], s.soft
    return [(tau, 1.0)], 0.0


@cache
def kernel(sigma: float, device, dtype) -> torch.Tensor:
    r = math.ceil(3 * sigma)
    k = torch.exp(-((torch.arange(-r, r + 1, device=device, dtype=torch.float32) / sigma) ** 2) / 2)
    return (k / k.sum()).to(dtype)


def blur(img: torch.Tensor, sigma: float) -> torch.Tensor:
    if sigma < 0.5:
        return img
    k = kernel(round(sigma * 2) / 2, img.device, img.dtype)
    r, c = len(k) // 2, img.shape[1]
    img = F.conv2d(F.pad(img, (r, r, 0, 0), mode='replicate'), k.view(1, 1, 1, -1).expand(c, 1, 1, -1), groups=c)
    return F.conv2d(F.pad(img, (0, 0, r, r), mode='replicate'), k.view(1, 1, -1, 1).expand(c, 1, -1, 1), groups=c)


def dissolve(parts: list[tuple[torch.Tensor, float]], soft: float) -> torch.Tensor:
    if len(parts) == 1:
        return parts[0][0]
    (a, wa), (b, wb) = parts
    return blur(a * wa + b * wb, soft * BLUR * a.shape[-1] * math.sin(math.pi * wb))
