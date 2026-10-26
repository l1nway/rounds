# [DOC: repair]
import torch
import torch.nn as nn

WIDTHS = 32, 64, 128
FRAMES, MID = 3, 30


def cbr(cin: int, cout: int, **conv) -> list[nn.Module]:
    return [nn.Conv2d(cin, cout, 3, padding=1, bias=False, **conv), nn.BatchNorm2d(cout), nn.ReLU(True)]


class Seq(nn.Module):
    def __init__(self, *layers: nn.Module):
        super().__init__()
        self.convblock = nn.Sequential(*layers)

    def forward(self, x):
        return self.convblock(x)


def down(cin: int, cout: int) -> Seq:
    return Seq(*cbr(cin, cout, stride=2), Seq(*cbr(cout, cout), *cbr(cout, cout)))


def up(cin: int, cout: int) -> Seq:
    return Seq(Seq(*cbr(cin, cin), *cbr(cin, cin)), nn.Conv2d(cin, cout * 4, 3, padding=1, bias=False),
               nn.PixelShuffle(2))  # fmt: skip


class DenBlock(nn.Module):
    def __init__(self):
        super().__init__()
        a, b, c = WIDTHS
        self.inc = Seq(*cbr(FRAMES * 4, FRAMES * MID, groups=FRAMES), *cbr(FRAMES * MID, a))
        self.downc0, self.downc1, self.upc2, self.upc1 = down(a, b), down(b, c), up(c, b), up(b, a)
        self.outc = Seq(*cbr(a, a), nn.Conv2d(a, 3, 3, padding=1, bias=False))

    def forward(self, x0, x1, x2, sigma):
        top = self.inc(torch.cat((x0, sigma, x1, sigma, x2, sigma), 1))
        mid = self.downc0(top)
        return x1 - self.outc(top + self.upc1(mid + self.upc2(self.downc1(mid))))


class FastDVDnet(nn.Module):
    def __init__(self):
        super().__init__()
        self.temp1, self.temp2 = DenBlock(), DenBlock()


def load(path: str) -> FastDVDnet:
    state = torch.load(path, map_location='cpu', weights_only=True)
    net = FastDVDnet()
    net.load_state_dict({k.removeprefix('module.'): v for k, v in state.items()})
    return net.eval()
