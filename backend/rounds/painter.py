import sys
import zlib

import modal
import numpy as np

from .cloud import app, fetch, image
from .upscale import DEPTH, clone, pack, unpack

# [DOC: propainter-worker]
CODE = '/opt/propainter'
REPO = 'https://github.com/sczhou/ProPainter', 'e870e79321c31b733e2031af5aa2fb1fe3ac7eec'
RELEASE = 'https://github.com/sczhou/ProPainter/releases/download/v0.1.0'
WEIGHTS = {
    'ProPainter.pth': '12c070c4b48f374c91d8a2a17851140b85c159621080989f9e191bbc18bd6591',
    'raft-things.pth': 'fcfa4125d6418f4de95d84aec20a3c5f4e205101715a79f193243c186ac9a7e1',
    'recurrent_flow_completion.pth': '22939a1a7900da878dbe1ccd011d646b1bfb30b8290039d8ff0e0c2fefbfd283',
}
GPUS, WORKERS, IDLE, TIMEOUT = ['L40S', 'A100-40GB', 'L4'], 3, 60, 1800
RAFT_ITER, RAFT_CLIP = 20, 12
FLOW_SUB, FLOW_PAD, PROP_SUB, PROP_PAD = 80, 5, 100, 10
NEIGHBOR, REF_STRIDE = 10, 10
REF_SPAN = REF_STRIDE * (FLOW_SUB // REF_STRIDE // 2)

downloads = (c for name, sha in WEIGHTS.items() for c in fetch(f'{CODE}/weights/{name}', f'{RELEASE}/{name}', sha))
paint_image = image('gpu', commands=(clone(CODE, *REPO), *downloads))


def load() -> tuple:
    sys.path.insert(0, CODE)
    from model.modules.flow_comp_raft import RAFT_bi
    from model.propainter import InpaintGenerator
    from model.recurrent_flow_completion import RecurrentFlowCompleteNet

    path = f'{CODE}/weights'
    raft = RAFT_bi(f'{path}/raft-things.pth', 'cpu')
    complete = RecurrentFlowCompleteNet(f'{path}/recurrent_flow_completion.pth').eval()
    return raft, complete, InpaintGenerator(model_path=f'{path}/ProPainter.pth').eval()


def to(nets: tuple, device: str) -> tuple:
    import torch

    torch.set_float32_matmul_precision('high')  # tf32
    torch.backends.cudnn.allow_tf32 = True
    return tuple(net.to(device) for net in nets)


def sliced(t: int, length: int, pad: int):
    for f in range(0, t, length):
        s, e = max(0, f - pad), min(t, f + length + pad)
        yield s, e, f - s, e - min(t, f + length)


def flows(raft, x):
    import torch

    t, parts = x.shape[1], []
    for f in range(0, t, RAFT_CLIP):
        parts.append(raft(x[:, max(0, f - 1) : min(t, f + RAFT_CLIP)], iters=RAFT_ITER))
    return torch.cat([p[0] for p in parts], 1), torch.cat([p[1] for p in parts], 1)


def completed(complete, gt, masks):
    import torch

    fw, bw = [], []
    for s, e, ps, pe in sliced(gt[0].shape[1], FLOW_SUB, FLOW_PAD):
        sub = gt[0][:, s:e], gt[1][:, s:e]
        pred, _ = complete.forward_bidirect_flow(sub, masks[:, s : e + 1])
        pred = complete.combine_flow(sub, pred, masks[:, s : e + 1])
        fw.append(pred[0][:, ps : e - s - pe])
        bw.append(pred[1][:, ps : e - s - pe])
    return torch.cat(fw, 1), torch.cat(bw, 1)


def propagated(model, x, done, masks):
    import torch

    (_, t, _, h, w), frames, holes = x.shape, [], []
    for s, e, ps, pe in sliced(t, PROP_SUB, PROP_PAD):
        sub = done[0][:, s : e - 1], done[1][:, s : e - 1]
        imgs, lost = model.img_propagation(x[:, s:e] * (1 - masks[:, s:e]), sub, masks[:, s:e], 'nearest')
        upd = x[:, s:e] * (1 - masks[:, s:e]) + imgs.view(1, e - s, 3, h, w) * masks[:, s:e]
        frames.append(upd[:, ps : e - s - pe])
        holes.append(lost.view(1, e - s, 1, h, w)[:, ps : e - s - pe])
    return torch.cat(frames, 1), torch.cat(holes, 1)


def refs(f: int, near: list, t: int) -> list:
    lo, hi = (max(0, f - REF_SPAN), min(t, f + REF_SPAN)) if t > FLOW_SUB else (0, t)
    return [i for i in range(lo, hi, REF_STRIDE) if i not in near]


# [DOC: propainter-worker]
def inpaint(nets: tuple, src: np.ndarray, holes: np.ndarray, want: list) -> np.ndarray:
    import torch

    raft, complete, model = nets
    (t, h, w), stride, comp = holes.shape, NEIGHBOR // 2, {}
    with torch.inference_mode():
        x = torch.from_numpy(src.astype(np.float32)).cuda().permute(0, 3, 1, 2)[None] * (2 / DEPTH) - 1
        masks = torch.from_numpy(holes).cuda().float()[None, :, None]
        done = completed(complete, flows(raft, x), masks)
        upd, lost = propagated(model, x, done, masks)
        for f in range(0, t, stride):
            near = list(range(max(0, f - stride), min(t, f + stride + 1)))
            if not set(want).intersection(near):
                continue
            ids = near + refs(f, near, t)
            pred = model(upd[:, ids], (done[0][:, near[:-1]], done[1][:, near[:-1]]), masks[:, ids], lost[:, ids],
                         len(near))  # fmt: skip
            pred = ((pred.view(-1, 3, h, w) + 1) / 2).clamp(0, 1)
            for i, k in enumerate(near):
                comp[k] = pred[i] if k not in comp else (comp[k] + pred[i]) / 2
        out = [comp[k] * masks[0, k] + (x[0, k] + 1) / 2 * (1 - masks[0, k]) for k in want]
        return (torch.stack(out) * DEPTH).round().clamp(0, DEPTH).permute(0, 2, 3, 1).cpu().numpy().astype(np.uint16)


def chunk(nets: tuple, blob: bytes, masks: bytes, size: int, skip: int, core: int) -> bytes:
    src = unpack(blob, size)
    holes = np.unpackbits(np.frombuffer(zlib.decompress(masks), np.uint8)).reshape(-1, size, size).astype(bool)
    want = [k for k in range(skip, skip + core) if holes[k].any()]
    return pack(inpaint(nets, src, holes, want))


@app.cls(image=paint_image, gpu=GPUS, cpu=4, memory=16384, timeout=TIMEOUT, max_containers=WORKERS,
         scaledown_window=IDLE, enable_memory_snapshot=True)  # fmt: skip
class Painter:
    @modal.enter(snap=True)
    def setup(self):
        self.nets = load()

    @modal.enter(snap=False)
    def to_gpu(self):
        self.nets = to(self.nets, 'cuda')

    @modal.method()
    def run(self, blob: bytes, masks: bytes, size: int, skip: int, core: int) -> bytes:
        return chunk(self.nets, blob, masks, size, skip, core)
