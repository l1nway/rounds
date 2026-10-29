p='evaluate.py'; s=open(p).read()
old = "V.update({k: np.load(WORK / f'out_{k}.npy') for k in NAMES[1:]})\n"
new = old + """_r = np.hypot(*(np.mgrid[0:V['input'].shape[1], 0:V['input'].shape[2]] - (V['input'].shape[1] - 1) / 2)) / (V['input'].shape[1] / 2)
FEATHER = np.clip((0.95 - _r) / 0.05, 0, 1)[None, ..., None].astype(np.float32)  # baked mask: deblur only inside 0.90-0.95 R
for k in NAMES[1:]:
    V[k] = (V['input'] + FEATHER * (V[k].astype(np.float32) - V['input'])).round().astype(np.uint8)
"""
assert old in s
s = s.replace(old, new, 1)
open(p, 'w').write(s)
