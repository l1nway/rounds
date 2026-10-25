from functools import cache

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from transformers import Sam2VideoInferenceSession, Sam2VideoModel
from transformers.image_utils import IMAGENET_DEFAULT_MEAN, IMAGENET_DEFAULT_STD

MODEL_ID = 'facebook/sam2.1-hiera-large'
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
DTYPE = torch.bfloat16 if DEVICE == 'cuda' else torch.float32
MEAN, STD = (torch.tensor(v, device=DEVICE).view(3, 1, 1) for v in (IMAGENET_DEFAULT_MEAN, IMAGENET_DEFAULT_STD))
PLACES = 'inference_device', 'inference_state_device', 'video_storage_device'
OBJ = 1
MIN_AREA = 1e-4
KEEP_BLOB = 0.2
PROGRESS_EVERY = 30


# [DOC: tracker-swap]
@cache
def load() -> Sam2VideoModel:
    return Sam2VideoModel.from_pretrained(MODEL_ID, dtype=DTYPE).to(DEVICE).eval()


def _pixels(frame: np.ndarray, side: int) -> torch.Tensor:
    x = torch.from_numpy(np.array(frame)).to(DEVICE).permute(2, 0, 1)[None].float() / 255
    x = F.interpolate(x, (side, side), mode='bilinear', antialias=True)[0]
    return ((x - MEAN) / STD).to(DTYPE)


def _prompt(points: list, box: list | None, h: int, w: int, side: int) -> dict:
    corners = [box[:2], box[2:]] if box else []
    coords = torch.tensor(corners + [p[:2] for p in points], dtype=torch.float32) * torch.tensor([side / w, side / h])
    labels = torch.tensor(([2, 3] if box else []) + [int(p[2]) for p in points])
    return {'point_coords': coords[None, None], 'point_labels': labels[None, None]}


# [DOC: tracking-memory]
def _pass(net: Sam2VideoModel, frames: np.ndarray, index: int, prompt: dict, reverse: bool):
    h, w = frames.shape[1:3]
    session = Sam2VideoInferenceSession(video_height=h, video_width=w, dtype=DTYPE, **dict.fromkeys(PLACES, DEVICE))
    session.add_point_inputs(session.obj_id_to_idx(OBJ), index, prompt)
    session.obj_with_new_inputs = [OBJ]
    memory = session.output_dict_per_obj[0]['non_cond_frame_outputs']
    step, window = -1 if reverse else 1, net.config.max_object_pointers_in_encoder
    for k in range(index, -1 if reverse else len(frames), step):
        frame = _pixels(frames[k], net.config.image_size)
        out = net(inference_session=session, frame=frame, frame_idx=k, reverse=reverse)
        session.processed_frames.pop(k)
        memory.pop(k - step * window, None)
        yield k, out


# [DOC: tracking-circle]
def _measure(logits: torch.Tensor, h: int, w: int) -> tuple[float, float, float, int]:
    mask = (F.interpolate(logits.float(), (h, w), mode='bilinear')[0, 0] > 0).to(torch.uint8).cpu().numpy()
    _, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    areas = stats[1:, cv2.CC_STAT_AREA]
    if not areas.size:
        return np.nan, np.nan, np.nan, 0
    keep = np.flatnonzero(areas >= KEEP_BLOB * areas.max()) + 1
    contours, _ = cv2.findContours(np.isin(labels, keep).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    (cx, cy), r = cv2.minEnclosingCircle(np.concatenate(contours))
    return cx + 0.5, cy + 0.5, r + 0.5, int(areas[keep - 1].sum())


# [DOC: tracking]
def track(frames: np.ndarray, index: int, points: list, box: list | None, progress=None) -> dict:
    net, (n, h, w) = load(), frames.shape[:3]
    prompt = _prompt(points or [], box, h, w, net.config.image_size)
    values, score, done = np.zeros((4, n)), np.zeros(n), 0
    with torch.inference_mode():
        for reverse in (False, True):
            for k, out in _pass(net, frames, index, prompt, reverse):
                values[:, k], score[k], done = _measure(out.pred_masks, h, w), out.object_score_logits.item(), done + 1
                if progress and (done % PROGRESS_EVERY == 0 or done == n + 1):
                    progress(done / (n + 1))
    present = (score > 0) & (values[3] >= MIN_AREA * h * w)
    cx, cy, r = np.where(present, values[:3], np.nan)
    return {'present': present, 'cx': cx, 'cy': cy, 'r': r, 'area': values[3]}
