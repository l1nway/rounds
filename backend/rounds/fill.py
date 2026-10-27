import math

import numpy as np
import torch
import torch.nn.functional as F

from . import motion
from .config import FPS

# [DOC: edge-fill]
REACH = 0.5
FEATHER = 8
RIM = 1.0
COVER = 0.999
CANVAS = 4096
SAMPLE = {'mode': 'bilinear', 'padding_mode': 'zeros', 'align_corners': False}


class Edges:
    def __init__(self, at, world: dict, size: int, rate: float, union: bool, device):
        self.at, self.world, self.size, self.rate, self.union, self.device = at, world, size, rate, union, device
        n, (w, h) = len(world['p']), world['size']
        m = np.concatenate([motion.matrices(world['p'], (w, h)), np.tile([0, 0, 1.0], (n, 1, 1))], 1)
        self.inv = torch.tensor(np.linalg.inv(m)[:, :2], dtype=torch.float32, device=device)
        v = (torch.arange(size, device=device, dtype=torch.float32) + 0.5) / size - 0.5
        gy, gx = torch.meshgrid(v, v, indexing='ij')
        self.grid, self.wh = torch.stack([gx, gy], -1), (w, h)

    def window(self, k: int) -> np.ndarray:
        return self.at(np.array([k * FPS / self.rate]))[0]

    def bad(self, k: int) -> torch.Tensor:
        x, y, side = self.window(k)
        pts = self.grid * float(side) + torch.tensor([x, y], device=self.device, dtype=torch.float32)
        t, s = self.world['t'], k / self.rate
        i = int(np.clip(np.searchsorted(t, s), 1, len(t) - 1))
        frames = {i - 1, i} if self.union else {i - 1 if s - t[i - 1] < t[i] - s else i}
        (w, h), out = self.wh, torch.zeros(self.size, self.size, dtype=torch.bool, device=self.device)
        for j in frames:
            p = pts @ self.inv[j, :, :2].T + self.inv[j, :, 2]
            if self.world['disc']:
                out |= torch.hypot(p[..., 0] - w / 2, p[..., 1] - h / 2) > motion.DISC_SAFE * min(w, h) / 2
            else:
                out |= (p[..., 0] < RIM) | (p[..., 0] > w - RIM) | (p[..., 1] < RIM) | (p[..., 1] > h - RIM)
        return out


class Canvas:
    def __init__(self, edges: Edges, n: int):
        rows = np.array([edges.window(k) for k in range(n)])
        lo, hi = (rows[:, :2] - rows[:, 2:] / 2).min(0), (rows[:, :2] + rows[:, 2:] / 2).max(0)
        self.edges, self.lo = edges, lo
        self.scale = min(edges.size / np.median(rows[:, 2]), CANVAS / (hi - lo).max())
        w, h = np.ceil((hi - lo) * self.scale).astype(int) + 1
        self.rgb = torch.zeros(3, h, w, device=edges.device, dtype=torch.float16)
        self.seen = torch.zeros(1, h, w, device=edges.device, dtype=torch.float16)

    def write(self, k: int, img: torch.Tensor, good: torch.Tensor):
        x, y, side = self.edges.window(k)
        (x0, y0), (x1, y1) = (np.array([[x, y]]) + [[-side / 2], [side / 2]] - self.lo) * self.scale
        h, w = self.seen.shape[1:]
        x0, y0, x1, y1 = max(int(x0), 0), max(int(y0), 0), min(math.ceil(x1), w), min(math.ceil(y1), h)
        gx, gy = ((torch.arange(a, b, device=img.device, dtype=torch.float32) + 0.5) / self.scale + c - o
                  for a, b, c, o in ((x0, x1, self.lo[0], x), (y0, y1, self.lo[1], y)))  # fmt: skip
        gy, gx = torch.meshgrid(2 * gy / float(side), 2 * gx / float(side), indexing='ij')
        g = torch.stack([gx, gy], -1)[None]
        ok = (F.grid_sample(good[None], g, **SAMPLE)[0] >= COVER).half()
        rgb = F.grid_sample(img[None], g, **SAMPLE)[0].half()
        area = (slice(None), slice(y0, y1), slice(x0, x1))
        self.rgb[area] = ok * rgb + (1 - ok) * self.rgb[area]
        self.seen[area] = torch.maximum(self.seen[area], ok)

    def read(self, k: int) -> tuple[torch.Tensor, torch.Tensor]:
        x, y, side = self.edges.window(k)
        h, w = self.seen.shape[1:]
        world = self.edges.grid * float(side) + torch.tensor([x, y], device=self.seen.device, dtype=torch.float32)
        g = ((world - torch.tensor(self.lo, device=world.device, dtype=torch.float32)) * self.scale / torch.tensor(
            [w, h], device=world.device, dtype=torch.float32) * 2 - 1)[None]  # fmt: skip
        both = F.grid_sample(torch.cat([self.rgb, self.seen]).float()[None], g, **SAMPLE)[0]
        return both[:3], (both[3:] >= COVER).float()


def spread(x: torch.Tensor, w: torch.Tensor) -> torch.Tensor:
    if min(x.shape[-2:]) <= 2:
        return x.sum((-2, -1), keepdim=True) / w.sum((-2, -1), keepdim=True).clamp(min=1e-6) + 0 * x
    coarse = spread(F.avg_pool2d(x[None], 2, ceil_mode=True)[0], F.avg_pool2d(w[None], 2, ceil_mode=True)[0])
    up = F.interpolate(coarse[None], size=x.shape[-2:], mode='bilinear', align_corners=False)[0]
    return x + (1 - w) * up


def toward(edges: Edges, k: int, j: int) -> torch.Tensor:
    (xk, yk, sk), (xj, yj, sj) = edges.window(k), edges.window(j)
    shift = torch.tensor([xk - xj, yk - yj], device=edges.device, dtype=torch.float32)
    return (2 * (edges.grid * float(sk) + shift) / float(sj))[None]


def fill(k: int, img: torch.Tensor, bad: torch.Tensor, donors: list, edges: Edges,
         canvas: Canvas | None = None) -> torch.Tensor:  # fmt: skip
    if not bad.any():
        return img
    good = (~bad).float()[None]
    alpha = good * F.avg_pool2d(good[None], 2 * FEATHER + 1, 1, FEATHER, count_include_pad=False)[0]
    acc, cover = torch.zeros_like(img), torch.zeros_like(alpha)
    for j, other, _, use in donors:
        if (cover + alpha >= COVER).all():
            break
        g = toward(edges, k, j)
        rgb, ok = F.grid_sample(other[None], g, **SAMPLE)[0], F.grid_sample(use[None], g, **SAMPLE)[0]
        take = (ok >= COVER).float() * (1 - cover) * (alpha < 1)
        acc, cover = acc + take * rgb, cover + take
    if canvas is not None:
        rgb, seen = canvas.read(k)
        take = seen * (1 - cover) * (alpha < 1)
        acc, cover = acc + take * rgb, cover + take
    rest = spread(img * alpha + acc * (1 - alpha), (alpha + cover * (1 - alpha)).clamp(max=1))
    return alpha * img + (1 - alpha) * (acc + (1 - cover) * rest)


# [DOC: edge-fill]
@torch.inference_mode()
def frames(stream, edges: Edges, n: int):
    reach, ring, emitted, canvas = max(1, math.ceil(REACH * edges.rate)), [], 0, Canvas(edges, n)

    def emit(k: int):
        nonlocal ring
        centre = next(e for e in ring if e[0] == k)
        donors = sorted((e for e in ring if e[0] != k), key=lambda e: abs(e[0] - k))
        ring = [e for e in ring if e[0] >= k + 1 - reach]
        out = fill(k, centre[1], centre[2], donors, edges, canvas)
        canvas.write(k, centre[1], centre[3])
        return out

    for k, img in enumerate(stream):
        bad = edges.bad(k)
        ring.append((k, img, bad, (~bad).float()[None]))
        while k - emitted >= reach:
            yield emit(emitted)
            emitted += 1
    while ring and emitted <= ring[-1][0]:
        yield emit(emitted)
        emitted += 1
