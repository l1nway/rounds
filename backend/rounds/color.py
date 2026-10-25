import torch
import torch.nn.functional as F

KR_KB = {'bt709': (0.2126, 0.0722), 'bt2020': (0.2627, 0.0593), 'bt601': (0.299, 0.114)}
BT2020_TO_709 = ((1.6605, -0.5876, -0.0728), (-0.1246, 1.1329, -0.0083), (-0.0182, -0.1006, 1.1187))
M1, M2, C1, C2, C3 = 2610 / 16384, 2523 / 4096 * 128, 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
HLG_A, HLG_B, HLG_C = 0.17883277, 0.28466892, 0.55991073
GAMMA = 2.4
HDR_PEAK, SDR_WHITE = 1000.0, 203.0
KNEE = 0.9
EPS = 1e-6


def lanczos(x, a: int = 3):
    return torch.where(x.abs() < a, torch.sinc(x) * torch.sinc(x / a), 0)


def along(x, dim: int, f):
    return f(x.transpose(dim, -1)).transpose(dim, -1)


# [DOC: chroma-siting]
def up2(x, off: float):
    k = torch.arange(-3, 4, device=x.device, dtype=x.dtype)
    w = torch.stack([lanczos(k - (p - off) / 2) for p in (0, 1)])
    xs = F.pad(x.reshape(-1, 1, x.shape[-1]), (3, 3), mode='replicate')
    return F.conv1d(xs, (w / w.sum(1, keepdim=True))[:, None]).transpose(1, 2).reshape(*x.shape[:-1], -1)


def down2(x, off: float):
    w = lanczos((torch.arange(-6, 7, device=x.device, dtype=x.dtype) - off) / 2)
    xs = F.pad(x.reshape(-1, 1, x.shape[-1]), (6, 6), mode='replicate')
    return F.conv1d(xs, (w / w.sum()).view(1, 1, -1), stride=2).reshape(*x.shape[:-1], -1)


def luma(rgb, kr: float, kb: float):
    return kr * rgb[0] + (1 - kr - kb) * rgb[1] + kb * rgb[2]


def yuv_to_rgb(y, uv, matrix: str, bits: int, full: bool):
    kr, kb = KR_KB[matrix]
    top = 2**bits - 1
    y0, ys, cs = (0, top, top) if full else (16 << (bits - 8), 219 << (bits - 8), 224 << (bits - 8))
    y, cb, cr = (y - y0) / ys, *((uv - (128 << (bits - 8))) / cs)
    kg = 1 - kr - kb
    r, b = y + 2 * (1 - kr) * cr, y + 2 * (1 - kb) * cb
    return torch.stack([r, (y - kr * r - kb * b) / kg, b])


def pq_inv(nits):
    y = (nits / 10000) ** M1
    return ((C1 + C2 * y) / (1 + C3 * y)) ** M2


def pq_eotf(e):
    p = e ** (1 / M2)
    return ((p - C1).clamp(min=0) / (C2 - C3 * p)) ** (1 / M1) * 10000


def hlg_display(e):
    s = torch.where(e <= 0.5, e * e / 3, (torch.exp((e - HLG_C) / HLG_A) + HLG_B) / 12)
    return HDR_PEAK * luma(s, *KR_KB['bt2020']).clamp(min=0) ** 0.2 * s


# [DOC: linear-light]
def to_linear(rgb, transfer: str):
    if transfer == 'pq':
        return pq_eotf(rgb.clamp(0, 1))
    return hlg_display(rgb.clamp(0, 1)) if transfer == 'hlg' else rgb.clamp(min=0) ** GAMMA


# [DOC: hdr-tonemap]
def eetf(nits):
    peak = pq_inv(HDR_PEAK)
    e1, top = (pq_inv(nits) / peak).clamp(max=1), pq_inv(SDR_WHITE) / peak
    ks = 1.5 * top - 0.5
    t = ((e1 - ks) / (1 - ks)).clamp(min=0)
    p = (2 * t**3 - 3 * t**2 + 1) * ks + (t**3 - 2 * t**2 + t) * (1 - ks) + (3 * t**2 - 2 * t**3) * top
    return pq_eotf(torch.where(e1 < ks, e1, p) * peak)


def soft_gamut(rgb):
    y = luma(rgb, *KR_KB['bt709']).clamp(0, 1)
    c = rgb - y
    d = torch.maximum((-c / y.clamp(min=EPS)).amax(0), (c / (1 - y).clamp(min=EPS)).amax(0))
    dk = torch.where(d > KNEE, KNEE + (1 - KNEE) * torch.tanh((d - KNEE) / (1 - KNEE)), d)
    return y + c * (dk / d.clamp(min=EPS))


def to_sdr(lin, transfer: str):
    if transfer == 'sdr':
        return lin.clamp(0, 1)
    lin = lin.clamp(min=0)
    m = lin.amax(0, keepdim=True)
    lin = lin * (eetf(m) / m.clamp(min=EPS)) / SDR_WHITE
    mat = torch.tensor(BT2020_TO_709, device=lin.device, dtype=lin.dtype)
    return soft_gamut(torch.einsum('ij,jhw->ihw', mat, lin)).clamp(0, 1)


def dither(size: int, device, seed: int = 7):
    g = torch.Generator().manual_seed(seed)
    return [(torch.rand(s, s, generator=g) - 0.5).to(device) for s in (size, size // 2, size // 2)]


# [DOC: output-encode]
def encode(rgb, noise):
    kr, kb = KR_KB['bt709']
    v = rgb.clamp(0, 1) ** (1 / GAMMA)
    y = luma(v, kr, kb)
    cb, cr = (v[2] - y) / (2 * (1 - kb)), (v[0] - y) / (2 * (1 - kr))
    c = down2(along(torch.stack([cb, cr]), -2, lambda x: down2(x, 0.5)), 0.0)
    planes = [16 + 219 * y, 128 + 224 * c[0], 128 + 224 * c[1]]
    out = [(p + n).round().clamp(0, 255).to(torch.uint8).flatten() for p, n in zip(planes, noise, strict=True)]
    return torch.cat(out)
