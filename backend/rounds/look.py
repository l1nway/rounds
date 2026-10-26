import math

import torch
import torch.nn.functional as F

from . import color

# [DOC: look-zones]
HONEST = 0.4
# [DOC: look-maps]
GRID, RADIUS, EPS, SPREAD = 256, 8, 0.3, 16
FLOOR = 2.0**-10
CLIP = 0.93, 0.985
# [DOC: look-curve]
PIVOT, LIFT, DARK = math.log2(0.18), 0.75, (math.log2(0.0005), math.log2(0.008))
KNEE, WHITE, TARGET, SOFT = math.log2(0.3), 0.0, math.log2(0.8), 0.5
DETAIL = 0.2
SHOULDER = 0.9
TAU = 0.3


def split(value: float) -> tuple[float, float]:
    return min(value / HONEST, 1.0), max(value - HONEST, 0.0) / (1 - HONEST)


def smoothstep(e0: float, e1: float, x):
    t = ((x - e0) / (e1 - e0)).clamp(0, 1)
    return t * t * (3 - 2 * t)


def box(x, r: int):
    return F.avg_pool2d(F.pad(x[None], (r, r, r, r), mode='replicate'), 2 * r + 1, stride=1)[0]


def lum(x, transfer: str):
    return color.luma(x, *color.KR_KB['bt709' if transfer == 'sdr' else 'bt2020']).clamp(min=0)


def fit(w: int, h: int) -> tuple[int, int]:
    k = GRID / max(w, h)
    return max(1, round(w * k)), max(1, round(h * k))


# [DOC: look-maps]
def grid(x, transfer: str) -> tuple[torch.Tensor, float]:
    y = lum(x, transfer)
    log = torch.log2(y + FLOOR)
    mi, mii = box(torch.stack([log, log * log]), RADIUS)
    var = (mii - mi * mi).clamp(min=0)
    a = var / (var + EPS)
    keep = 1 - smoothstep(*CLIP, x.clamp(0, 1).amax(0) ** (1 / color.GAMMA)) if transfer == 'sdr' else 1
    sums = box(torch.cat([x * keep, (y * keep)[None]]), SPREAD)
    ratio = sums[:3] / sums[3:].clamp(min=1e-6)
    return torch.cat([box(torch.stack([a, mi - a * mi]), RADIUS), ratio]), float(mi.max())


def maps(buf, geo, device) -> tuple[torch.Tensor, float]:
    (w, h, cw, ch), (bits, full, matrix, transfer) = geo
    size = fit(w, h)[::-1]
    y = F.adaptive_avg_pool2d(torch.from_numpy(buf[: w * h].reshape(1, h, w)).to(device).float(), size)
    uv = F.adaptive_avg_pool2d(torch.from_numpy(buf[w * h :].reshape(2, ch, cw)).to(device).float(), size)
    return grid(working(color.yuv_to_rgb(y[0], uv, matrix, bits, full), transfer), transfer)


def working(rgb, transfer: str):
    lin = color.to_linear(rgb, transfer).clamp(min=0)
    return lin if transfer == 'sdr' else lin / color.SDR_WHITE


# [DOC: look-rebuild]
def rebuild(x, ratio, t: float):
    m = smoothstep(*CLIP, x.clamp(0, 1) ** (1 / color.GAMMA))
    keep, ratio = 1 - m, ratio.clamp(min=1e-3)
    est = (keep * x).sum(0) / (keep * ratio).sum(0).clamp(min=1e-3)
    return x + m * (ratio * est - x).clamp(min=0) * (t * smoothstep(0.0, 0.5, keep.sum(0)))


# [DOC: look-curve]
def curve(base, top: float, t: float, ev: float):
    b = base + ev
    b = b + t * LIFT * (PIVOT - b).clamp(min=0) * smoothstep(*DARK, b)
    peak = top + ev
    cap = min(peak, max(top, WHITE))
    cap += t * (min(cap, TARGET) - cap)
    if peak <= cap or peak <= KNEE:
        return b
    d = b - KNEE
    return b - (1 - (cap - KNEE) / (peak - KNEE)) * 0.5 * (d + torch.sqrt(d * d + SOFT * SOFT))


def shoulder(x):
    m = x.amax(0, keepdim=True)
    f = torch.where(m > SHOULDER, SHOULDER + (1 - SHOULDER) * (1 - torch.exp((SHOULDER - m) / (1 - SHOULDER))), m)
    return (x * f / m.clamp(min=color.EPS)).clamp(0, 1)


def apply(x, m, top: float, at, t: float, ev: float, transfer: str):
    s = F.grid_sample(m[None], at[None], mode='bilinear', padding_mode='border', align_corners=False)[0]
    if transfer == 'sdr' and t > 0:
        x = rebuild(x, s[2:5], t)
    log = torch.log2(lum(x, transfer) + FLOOR)
    base = s[0] * log + s[1]
    return x * torch.exp2(curve(base, top, t, ev) + (log - base) * (1 + t * DETAIL) - log)


def coords(box, w: int, h: int, out: tuple[int, int], device) -> torch.Tensor:
    gx, gy = (2 * (c + ((torch.arange(k, device=device, dtype=torch.float64) + 0.5) / k - 0.5) * side) / n - 1
              for c, side, n, k in ((box[0], box[2], w, out[0]), (box[1], box[3], h, out[1])))  # fmt: skip
    return torch.stack(torch.meshgrid(gx, gy, indexing='xy'), -1).float()


class Look:
    def __init__(self, value: float, ev: float, transfer: str, rate: float):
        (self.t, self.repair), self.ev, self.transfer = split(value), ev, transfer
        self.alpha, self.top = 1 - math.exp(-1 / (rate * TAU)), None

    @property
    def on(self) -> bool:
        return self.t > 0 or self.ev != 0

    def __call__(self, buf, box, geo, lin):
        (w, h, _, _), (*_, transfer) = geo
        m, top = maps(buf, geo, lin.device)
        self.top = top if self.top is None else self.top + self.alpha * (top - self.top)
        hdr, out = transfer != 'sdr', (lin.shape[-1], lin.shape[-2])
        x = lin / color.SDR_WHITE if hdr else lin.clamp(min=0)
        x = apply(x, m, self.top, coords(box, w, h, out, lin.device), self.t, self.ev, transfer)
        return x * color.SDR_WHITE if hdr else shoulder(x)
