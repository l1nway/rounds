# [DOC: dstnet]
from collections import OrderedDict

import torch
import torch.nn.functional as F
from torch import nn

SIZES = {'base': {'num_feat': 64, 'num_kernel_block': 3, 'num_block': 15},
         'L': {'num_feat': 96, 'num_kernel_block': 5, 'num_block': 25}}  # fmt: skip
PAD, KERNEL = 16, 3
HAAR = [[[1, 1], [1, 1]], [[1, -1], [1, -1]], [[1, 1], [-1, -1]], [[1, -1], [-1, 1]]]


def blocks(channels: int, n: int) -> nn.Sequential:
    return nn.Sequential(*(ResBlock(channels) for _ in range(n)))


def idynamic(x: torch.Tensor, weight: torch.Tensor, padding: int) -> torch.Tensor:
    b, c, h, w = x.shape
    groups, kh, kw = weight.shape[1:4]
    cols = F.unfold(x, (kh, kw), padding=padding).view(b, groups, c // groups, kh * kw, h, w)
    return (cols * weight.view(b, groups, 1, kh * kw, h, w)).sum(3).view(b, c, h, w)


class ResBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.conv1 = nn.Conv2d(channels, channels, 3, 1, 1)
        self.conv2 = nn.Conv2d(channels, channels, 3, 1, 1)
        self.relu = nn.LeakyReLU(0.1, True)

    def forward(self, x):
        return self.conv2(self.relu(self.conv1(x))) + x


class IDynamicDWConv(nn.Module):
    def __init__(self, channels: int, n_blocks: int):
        super().__init__()
        self.Block1, self.Block2, self.Block3 = (blocks(channels, n_blocks) for _ in range(3))
        self.tokernel = nn.Conv2d(channels * 3, KERNEL**2 * channels, 1, 1, 0)

    def forward(self, x):
        b, c, h, w = x.shape
        y, feats = x, []
        for i, block in enumerate((self.Block1, self.Block2, self.Block3), 1):
            y = block(F.adaptive_max_pool2d(y, (h >> i, w >> i)))
            feats.append(F.interpolate(y, size=(h, w), mode='bilinear'))
        weight = self.tokernel(torch.cat(feats, 1)).view(b, c, KERNEL, KERNEL, h, w)
        return idynamic(x, weight, KERNEL // 2)


class HaarDownsampling(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.c = channels
        self.haar_weights = nn.Parameter(torch.tensor(HAAR, dtype=torch.float32)[:, None].repeat(channels, 1, 1, 1),
                                         requires_grad=False)  # fmt: skip

    def forward(self, x):
        n, _, h, w = x.shape
        out = F.conv2d(x, self.haar_weights, stride=2, groups=self.c) / 4.0
        out = out.reshape(n, self.c, 4, h // 2, w // 2).transpose(1, 2).reshape(n, self.c * 4, h // 2, w // 2)
        return out[:, : self.c], out[:, self.c :]

    def inverse(self, x):
        n, _, h, w = x.shape
        out = x.reshape(n, 4, self.c, h, w).transpose(1, 2).reshape(n, self.c * 4, h, w)
        return F.conv_transpose2d(out, self.haar_weights, stride=2, groups=self.c)


class PAGF(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.conv0 = nn.Conv2d(channels * 2, channels * 2, 1, 1, 0)
        self.conv1 = nn.Conv2d(channels, channels, 3, 1, 1)

    def forward(self, x, prop):
        q, k = self.conv0(torch.cat([x, prop], 1)).chunk(2, 1)
        sim = torch.sigmoid(q * k)
        return self.conv1(x * (1 - sim) + prop * sim)


class Propagation(nn.Module):
    def __init__(self, channels: int, kernel_blocks: int, n_blocks: int, reverse: bool):
        super().__init__()
        self.reverse = reverse
        self.fusion = PAGF(channels)
        self.kernel_conv_pixel = IDynamicDWConv(channels, kernel_blocks)
        self.resblock_bcakward2d = nn.Sequential(OrderedDict(main=nn.Sequential(blocks(channels, n_blocks))))

    def forward(self, feature):
        b, t, c, h, w = feature.shape
        prop, out = feature.new_zeros(b, c, h, w), []
        for i in reversed(range(t)) if self.reverse else range(t):
            prop = self.resblock_bcakward2d(self.kernel_conv_pixel(self.fusion(feature[:, i], prop)))
            out.append(prop)
        return torch.stack(out[::-1] if self.reverse else out, 1)


class DSTNetPlus_Final(nn.Module):
    def __init__(self, num_feat: int = 96, num_kernel_block: int = 5, num_block: int = 25):
        super().__init__()
        self.feat_extractor = nn.Conv2d(3, num_feat, 3, 1, 1)
        self.recons = nn.Conv2d(num_feat, 3, 3, 1, 1)
        self.wave = HaarDownsampling(num_feat)
        self.x_wave_2_conv1 = nn.Conv2d(num_feat * 3, num_feat * 3, 1, 1, 0, groups=3)
        self.x_wave_2_conv2 = nn.Conv2d(num_feat * 3, num_feat * 3, 1, 1, 0, groups=3)
        self.forward_propagation = Propagation(num_feat, num_kernel_block, num_block, False)
        self.backward_propagation = Propagation(num_feat, num_kernel_block, num_block, True)
        self.lrelu = nn.LeakyReLU(0.1, True)

    def forward(self, lrs):
        b, t, c, h, w = lrs.shape
        lrs = F.pad(lrs.flatten(0, 1), [0, w % 2, 0, h % 2], mode='reflect').unflatten(0, (b, t))
        low, high = self.wave(self.feat_extractor(lrs.flatten(0, 1)))
        high = self.x_wave_2_conv2(self.lrelu(self.x_wave_2_conv1(high)))
        low = self.forward_propagation(self.backward_propagation(low.unflatten(0, (b, t)))).flatten(0, 1)
        out = self.recons(self.wave.inverse(torch.cat([low, high], 1))).unflatten(0, (b, t)) + lrs
        return out[..., :h, :w]


def load(path: str, size: str = 'base') -> DSTNetPlus_Final:
    model = DSTNetPlus_Final(**SIZES[size])
    model.load_state_dict(torch.load(path, map_location='cpu', weights_only=True)['params'], strict=True)
    return model.eval()


def starts(t: int, clip: int, overlap: int) -> list[int]:
    return sorted({*range(0, max(t - clip, 0), clip - overlap), max(t - clip, 0)})


def ramp(n: int, overlap: int, head: bool, tail: bool) -> torch.Tensor:
    w, up = torch.ones(n), torch.arange(1, overlap + 1, dtype=torch.float32) / (overlap + 1)
    if head:
        w[:overlap] = up
    if tail:
        w[n - overlap :] = up.flip(0)
    return w


def run(frames: torch.Tensor, model: nn.Module, clip: int = 10, overlap: int = 2, half: bool = True) -> torch.Tensor:
    t, _, h, w = frames.shape
    pad_h, pad_w = (PAD - h % PAD) % PAD, (PAD - w % PAD) % PAD
    dtype = torch.float16 if half else torch.float32
    scale = 255 if frames.dtype == torch.uint8 else 1
    model = model.to('cuda', dtype)
    out, seen = torch.zeros(t, 3, h, w), torch.zeros(t, 1, 1, 1)
    with torch.no_grad():
        for s in starts(t, clip, overlap):
            e = min(s + clip, t)
            x = F.pad(frames[s:e].to('cuda', dtype) / scale, [0, pad_w, 0, pad_h], mode='reflect')
            y = model(x[None])[0, :, :, :h, :w].float().clamp_(0, 1).cpu()
            r = ramp(e - s, min(overlap, e - s), s > 0, e < t).view(-1, 1, 1, 1)
            out[s:e] = (out[s:e] * seen[s:e] + y * r) / (seen[s:e] + r)
            seen[s:e] += r
    return out
