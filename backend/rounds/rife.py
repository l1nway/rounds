# [DOC: rife]
import torch
import torch.nn as nn
import torch.nn.functional as F

SCALES = (16, 8, 4, 2, 1)
WIDTHS = (192, 128, 96, 64, 32)


def grid(h: int, w: int, device) -> tuple[torch.Tensor, torch.Tensor]:
    gx = torch.linspace(-1, 1, w, device=device).view(1, 1, 1, w).expand(1, 1, h, w)
    gy = torch.linspace(-1, 1, h, device=device).view(1, 1, h, 1).expand(1, 1, h, w)
    return torch.cat((gx, gy), 1), torch.tensor([(w - 1) / 2, (h - 1) / 2], device=device).view(1, 2, 1, 1)


def warp(x, flow, base) -> torch.Tensor:
    g = (base[0] + flow.float() / base[1]).permute(0, 2, 3, 1)
    return F.grid_sample(x.float(), g, mode='bilinear', padding_mode='border', align_corners=True).to(x.dtype)


def conv(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(cin, cout, 3, 2, 1), nn.LeakyReLU(0.2, True))


class Head(nn.Module):
    def __init__(self):
        super().__init__()
        self.cnn0 = nn.Conv2d(3, 16, 3, 2, 1)
        self.cnn1 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn2 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn3 = nn.ConvTranspose2d(16, 4, 4, 2, 1)
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        x = self.relu(self.cnn0(x.clamp(0, 1)))
        return self.cnn3(self.relu(self.cnn2(self.relu(self.cnn1(x)))))


class ResConv(nn.Module):
    def __init__(self, c: int):
        super().__init__()
        self.conv = nn.Conv2d(c, c, 3, 1, 1)
        self.beta = nn.Parameter(torch.ones((1, c, 1, 1)))
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        return self.relu(self.conv(x) * self.beta + x)


class IFBlock(nn.Module):
    def __init__(self, cin: int, c: int):
        super().__init__()
        self.conv0 = nn.Sequential(conv(cin, c // 2), conv(c // 2, c))
        self.convblock = nn.Sequential(*(ResConv(c) for _ in range(8)))
        self.lastconv = nn.Sequential(nn.ConvTranspose2d(c, 4 * 13, 4, 2, 1), nn.PixelShuffle(2))

    def forward(self, x, flow, scale: int):
        x = F.interpolate(x, scale_factor=1 / scale, mode='bilinear')
        if flow is not None:
            x = torch.cat((x, F.interpolate(flow, scale_factor=1 / scale, mode='bilinear') / scale), 1)
        tmp = F.interpolate(self.lastconv(self.convblock(self.conv0(x))), scale_factor=scale, mode='bilinear')
        return tmp[:, :4] * scale, tmp[:, 4:5], tmp[:, 5:]


class IFNet(nn.Module):
    def __init__(self):
        super().__init__()
        for i, c in enumerate(WIDTHS):
            setattr(self, f'block{i}', IFBlock(15 if i == 0 else 28, c))

    def forward(self, img0, img1, t, f0, f1, base):
        img0, img1, flow = img0.clamp(0, 1), img1.clamp(0, 1), None
        w0, w1 = img0, img1
        for i, scale in enumerate(SCALES):
            block = getattr(self, f'block{i}')
            if flow is None:
                flow, mask, feat = block(torch.cat((img0, img1, f0, f1, t), 1), None, scale)
            else:
                wf0, wf1 = warp(f0, flow[:, :2], base), warp(f1, flow[:, 2:4], base)
                fd, mask, feat = block(torch.cat((w0, w1, wf0, wf1, t, mask, feat), 1), flow, scale)
                flow = flow + fd
            w0, w1 = warp(img0, flow[:, :2], base), warp(img1, flow[:, 2:4], base)
        mask = torch.sigmoid(mask)
        return w0 * mask + w1 * (1 - mask)


def load(path: str, device) -> tuple[IFNet, Head, torch.dtype]:
    dtype = torch.half if device.type == 'cuda' else torch.float
    state = {k.removeprefix('module.'): v for k, v in torch.load(path, map_location='cpu', weights_only=True).items()}
    net, head = IFNet(), Head()
    net.load_state_dict({k: v for k, v in state.items() if k.startswith('block')})
    head.load_state_dict({k.removeprefix('encode.'): v for k, v in state.items() if k.startswith('encode.')})
    return net.to(device, dtype).eval(), head.to(device, dtype).eval(), dtype
