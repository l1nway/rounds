import contextlib
from functools import partial

import numpy as np

from . import camera, fill_np, freelook, media, motion, warp_np
from . import look_np as lk
from .config import FPS, OUT_SIZE

# [DOC: free-stabilization]
POINT_R = 0.125


def track(world: dict, prompt: dict, centre, size: tuple[int, int], start: float, n: int) -> dict:
    if prompt.get('time') is None or not (prompt.get('box') or prompt.get('points')):
        return {'present': np.zeros(n, bool), **dict.fromkeys(('cx', 'cy', 'r'), np.full(n, np.nan))}
    (cx, cy, span), t = centre, world['track']
    k = int(np.clip(round((prompt['time'] - start) * FPS), 0, n - 1))
    fixed, scale = t[k] @ [cx, cy, 1.0], np.hypot(t[:, 0, 0], t[:, 1, 0])
    src = np.einsum('kij,kj->ki', np.linalg.inv(t[:, :, :2]), fixed - t[:, :, 2])
    r = (span / 2 if span else POINT_R * min(size)) * scale[k] / scale
    return {'present': np.ones(n, bool), 'cx': src[:, 0], 'cy': src[:, 1], 'r': r}


def even(lo: int, hi: int, n: int) -> tuple[int, int]:
    lo -= lo % 2
    return lo, min(hi + (hi - lo) % 2, n) - lo


# [DOC: free-stabilization]
def plan(src, meta: dict, request: dict, rate: float, n: int, centre, square: tuple) -> dict | None:
    start, end, size, prompt = request['start'], request['end'], (meta['width'], meta['height']), request['prompt']
    flow = motion.flows(src, meta, start, n, rate, False)
    if len(flow['t']) < 2:
        return None
    steps = media.frame_count(start, end)
    world = motion.world(flow, motion.params(flow, size), request['stabilize'], size, steps)
    if prompt.get('crop'):
        side, x, y = square
        path = np.tile([x + side / 2, y + side / 2, side], (steps, 1)).astype(float)
    else:
        found, zoom = track(world, prompt, centre, size, start, steps), request['options'].get('zoom', False)
        path = camera.solve(found, *size, (), FPS, zoom, world)
    base = camera.sampler(path)
    rows = motion.placer(base, world)(np.arange(n) * FPS / rate)
    spans = [(warp_np.bounds(b[0], b[2], size[0], o[0]), warp_np.bounds(b[1], b[3], size[1], o[1]))
             for b, o in map(warp_np.box, rows)]  # fmt: skip
    (x0, y0), (x1, y1) = np.min([[s[0][0], s[1][0]] for s in spans], 0), np.max([[s[0][1], s[1][1]] for s in spans], 0)
    crop = (*even(int(x0), int(x1), size[0]), *even(int(y0), int(y1), size[1]))
    return {'base': base, 'world': world, 'rows': rows, 'spans': spans, 'crop': crop}


def warp(part, origin, row, m, top, frame: tuple, grid: tuple, value: float, ev: float) -> np.ndarray:
    box, out = warp_np.box(row)
    lin = warp_np.window(lk.linear(part), origin, box, frame, out)
    if m is None:
        lin = np.clip(lin, 0, 1)
    else:
        mx, my = lk.sampler(*lk.coords(box, *frame, out), *grid)
        lin = lk.Look(value, ev, 1.0)(lin, lk.sample(m, mx, my), top)
    return warp_np.turned(lin, row[3]) if len(row) > 3 and row[3] else lin


def finish(img: np.ndarray, alpha, strength: float, encoded: bool) -> np.ndarray:
    v = np.clip(img, 0, 1) ** (1 / lk.GAMMA)
    v = v if alpha is None else freelook.lift(v, alpha, strength)
    return freelook.encode(v) if encoded else v


def frames(src, meta: dict, request: dict, rate: float, n: int, plan: dict, encoded: bool = True):
    (bx, bw, by, bh), size = plan['crop'], (meta['width'], meta['height'])
    vf, wide, grid = freelook.graph(meta, f'crop={bw}:{bh}:{bx}:{by},', (bw, bh))
    look = lk.Look(request.get('look', 0), request.get('exposure', 0), rate)
    lift = freelook.Alpha((OUT_SIZE, OUT_SIZE), rate) if look.repair > 0 else None
    edges = fill_np.Edges(plan['base'], plan['world'], OUT_SIZE, rate, False)
    ahead = freelook.AHEAD * freelook.WORKERS

    def items():
        bufs = freelook.decoded(src, meta, request['start'], n, rate, vf, wide * (bh + grid[1]) * 3)
        with contextlib.closing(bufs):
            for k, buf in enumerate(bufs):
                f, ((x0, x1), (y0, y1)) = buf.reshape(-1, wide, 3), plan['spans'][k]
                m, top = look.maps(f[bh:, : grid[0]]) if look.on else (None, None)
                yield f[y0 - by : y1 - by, x0 - bx : x1 - bx].copy(), (x0, y0), plan['rows'][k], m, top

    def lifted(stream):
        for img in stream:
            v = lift and np.clip(img[:, lift.rows][:, :, lift.cols], 0, 1) ** (1 / lk.GAMMA)
            yield img, lift and lift.step(v)

    with freelook.pool() as workers:
        work = partial(warp, frame=size, grid=grid, value=request.get('look', 0), ev=request.get('exposure', 0))
        filled = fill_np.frames(freelook.ordered(workers, work, items(), ahead), edges, n)
        done = partial(finish, strength=look.repair, encoded=encoded)
        yield from freelook.ordered(workers, done, lifted(filled), ahead)
