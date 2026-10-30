# [DOC: zero-dce-port]
import pickle
import zipfile
from collections import OrderedDict
from functools import cache

import numpy as np

STEPS = 8
STORAGES = {'FloatStorage': '<f4'}


def rebuild(storage, offset, size, stride, *_):
    item = storage.itemsize
    return np.lib.stride_tricks.as_strided(storage[offset:], size, [s * item for s in stride]).copy()


class Checkpoint(pickle.Unpickler):
    GLOBALS = {('collections', 'OrderedDict'): OrderedDict, ('torch._utils', '_rebuild_tensor_v2'): rebuild}

    def __init__(self, archive: zipfile.ZipFile, root: str):
        super().__init__(archive.open(f'{root}/data.pkl'))
        self.archive, self.root = archive, root

    def find_class(self, module: str, name: str):
        if (module, name) in self.GLOBALS:
            return self.GLOBALS[module, name]
        if module == 'torch' and name in STORAGES:
            return name
        raise pickle.UnpicklingError(f'{module}.{name} is not allowed in a checkpoint')

    def persistent_load(self, pid):
        _, kind, key, *_ = pid
        return np.frombuffer(self.archive.read(f'{self.root}/data/{key}'), STORAGES[kind])


def read(path: str) -> dict[str, np.ndarray]:
    with zipfile.ZipFile(path) as archive:
        root = archive.namelist()[0].split('/')[0]
        return Checkpoint(archive, root).load()


def depthwise(x: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    h, wd = x.shape[1:]
    p = np.pad(x, ((0, 0), (1, 1), (1, 1)), mode='constant')
    out = np.zeros_like(x)
    for i in range(3):
        for j in range(3):
            out += w[:, 0, i, j, None, None] * p[:, i : i + h, j : j + wd]
    return out + b[:, None, None]


def csdn(x: np.ndarray, params: dict, name: str) -> np.ndarray:
    x = depthwise(x, params[f'{name}.depth_conv.weight'], params[f'{name}.depth_conv.bias'])
    w = params[f'{name}.point_conv.weight'][:, :, 0, 0]
    return np.tensordot(w, x, 1) + params[f'{name}.point_conv.bias'][:, None, None]


def net(x: np.ndarray, params: dict) -> np.ndarray:
    def conv(k: int, v):
        return np.maximum(csdn(v, params, f'e_conv{k}'), 0)

    x1 = conv(1, x)
    x2 = conv(2, x1)
    x3 = conv(3, x2)
    x5 = conv(5, np.concatenate([x3, conv(4, x3)]))
    x6 = conv(6, np.concatenate([x2, x5]))
    return np.tanh(csdn(np.concatenate([x1, x6]), params, 'e_conv7'))


def curve(x, alpha):
    for _ in range(STEPS):
        x = x + alpha * (x * x - x)
    return x


@cache
def load(path: str) -> dict[str, np.ndarray]:
    params = {k: v.astype(np.float32) for k, v in read(path).items()}
    if missing := {f'e_conv{i}.{p}.{t}' for i in range(1, 8) for p in ('depth_conv', 'point_conv')
                   for t in ('weight', 'bias')} ^ params.keys():  # fmt: skip
        raise ValueError(f'unexpected Zero-DCE++ checkpoint keys: {sorted(missing)}')
    return params
