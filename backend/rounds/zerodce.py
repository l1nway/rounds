# [DOC: repair]
import torch
import torch.nn as nn

C = 32
STEPS = 8
LAYERS = (3, C), (C, C), (C, C), (C, C), (2 * C, C), (2 * C, C), (2 * C, 3)


class CSDN(nn.Module):
    def __init__(self, cin: int, cout: int):
        super().__init__()
        self.depth_conv = nn.Conv2d(cin, cin, 3, padding=1, groups=cin)
        self.point_conv = nn.Conv2d(cin, cout, 1)

    def forward(self, x):
        return self.point_conv(self.depth_conv(x))


class ZeroDCE(nn.Module):
    def __init__(self):
        super().__init__()
        for i, (cin, cout) in enumerate(LAYERS, 1):
            setattr(self, f'e_conv{i}', CSDN(cin, cout))

    def forward(self, x):
        x1 = self.e_conv1(x).relu()
        x2 = self.e_conv2(x1).relu()
        x3 = self.e_conv3(x2).relu()
        x5 = self.e_conv5(torch.cat((x3, self.e_conv4(x3).relu()), 1)).relu()
        x6 = self.e_conv6(torch.cat((x2, x5), 1)).relu()
        return torch.tanh(self.e_conv7(torch.cat((x1, x6), 1)))


def curve(x, alpha):
    for _ in range(STEPS):
        x = x + alpha * (x * x - x)
    return x


def load(path: str) -> ZeroDCE:
    net = ZeroDCE()
    net.load_state_dict(torch.load(path, map_location='cpu', weights_only=True))
    return net.eval()
