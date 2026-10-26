import base64
import subprocess
from collections import OrderedDict

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from transformers import Sam2Model
from transformers.image_utils import IMAGENET_DEFAULT_MEAN, IMAGENET_DEFAULT_STD

from .config import FPS, JOBS_DIR, SAM_MODEL

DTYPE = torch.bfloat16
EMBEDDINGS = 8
KEEP_BLOB, FEATHER, EDGE = 0.2, 1.2, 4
SAME = 0.9
NORM = IMAGENET_DEFAULT_MEAN, IMAGENET_DEFAULT_STD


def frame(job_id: str, index: int, w: int, h: int) -> np.ndarray:
    cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-ss', f'{index / FPS:.4f}', '-i', f'{JOBS_DIR}/{job_id}/proxy.mp4',
           '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']  # fmt: skip
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    if len(raw) < w * h * 3:
        raise ValueError('This frame could not be read')
    return np.frombuffer(raw[: w * h * 3], np.uint8).reshape(h, w, 3)


# [DOC: lift-mask]
def clean(logits: torch.Tensor, w: int, h: int) -> np.ndarray:
    up = F.interpolate(logits[None, None].float(), (h, w), mode='bilinear', align_corners=False)[0, 0]
    m = cv2.morphologyEx((up > 0).to(torch.uint8).cpu().numpy(), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    _, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    areas = stats[1:, cv2.CC_STAT_AREA]
    if not areas.size:
        return m
    keep = np.isin(labels, np.flatnonzero(areas >= KEEP_BLOB * areas.max()) + 1).astype(np.uint8)
    contours, _ = cv2.findContours(keep, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = cv2.drawContours(np.zeros_like(keep), contours, -1, 1, cv2.FILLED)
    filled[:EDGE], filled[-EDGE:], filled[:, :EDGE], filled[:, -EDGE:] = 0, 0, 0, 0
    return filled


def png(mask: np.ndarray) -> str:
    alpha = (cv2.GaussianBlur(mask.astype(np.float32), (0, 0), FEATHER) * 255).round().astype(np.uint8)
    rgba = np.dstack([np.full_like(alpha, 255)] * 3 + [alpha])
    data = cv2.imencode('.png', rgba, [cv2.IMWRITE_PNG_COMPRESSION, 9])[1].tobytes()
    return 'data:image/png;base64,' + base64.b64encode(data).decode()


def distinct(masks: list[np.ndarray]) -> list[np.ndarray]:
    kept = []
    for m in sorted((m for m in masks if m.any()), key=lambda m: m.sum()):
        if all((m & k).sum() < SAME * (m | k).sum() for k in kept):
            kept.append(m)
    return kept


# [DOC: lift]
class Segmenter:
    def __init__(self):
        self.net = Sam2Model.from_pretrained(SAM_MODEL, dtype=DTYPE).eval()
        self.side = self.net.config.prompt_encoder_config.image_size
        self.cache = OrderedDict()

    def to(self, device: str) -> None:
        self.net.to(device)
        self.device = device
        self.mean, self.std = (torch.tensor(v, device=device).view(3, 1, 1) for v in NORM)

    def embed(self, job_id: str, index: int, w: int, h: int) -> list[torch.Tensor]:
        key = job_id, index
        if key not in self.cache:
            x = torch.from_numpy(frame(job_id, index, w, h).copy()).to(self.device).permute(2, 0, 1)[None].float() / 255
            x = F.interpolate(x, (self.side, self.side), mode='bilinear', antialias=True)
            self.cache[key] = self.net.get_image_embeddings(((x - self.mean) / self.std).to(DTYPE))
            while len(self.cache) > EMBEDDINGS:
                self.cache.popitem(last=False)
        self.cache.move_to_end(key)
        return self.cache[key]

    @torch.inference_mode()
    def segment(self, job_id: str, at: float, points: list, box: list | None, size: tuple[int, int]) -> dict:
        w, h = size
        corners = [box[:2], box[2:]] if box else []
        coords = torch.tensor(corners + [p[:2] for p in points], dtype=torch.float32, device=self.device) * self.side
        labels = torch.tensor(([2, 3] if box else []) + [int(p[2]) for p in points], device=self.device)
        out = self.net(image_embeddings=self.embed(job_id, int(at * FPS + 1e-3), w, h),
                       input_points=coords[None, None], input_labels=labels[None, None],
                       multimask_output=len(points) == 1 and not box)  # fmt: skip
        masks = distinct([clean(x, w // 2, h // 2) for x in out.pred_masks[0, 0]])
        return {'candidates': [{'mask': png(m), 'area': round(float(m.mean()), 4)} for m in masks],
                'best': len(masks) // 2}  # fmt: skip
