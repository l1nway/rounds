import json
import math
import subprocess
from pathlib import Path

from .config import DEEP_FILTER
from .media import LENIENT

# [DOC: loudness]
LOUDNORM = 'loudnorm=I=-16:TP=-1:LRA=7'
MEASURED = ('I', 'TP', 'LRA', 'thresh')
GAPLESS = 'aresample=48000:async=1:first_pts=0'
# [DOC: denoise]
VOICE_DB = (6.0, 100.0)
HEADROOM = 2


def ffmpeg(inputs: list[str], af: str, *out: str, **kw) -> subprocess.CompletedProcess:
    cmd = ['ffmpeg', '-v', 'info', '-y', '-nostdin', '-hide_banner', *inputs, '-map', '0:a:0', '-af', af, *out]
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def cleaned(tmp: str) -> Path:
    return Path(tmp, 'clean', 'voice.wav')


def voice(inputs: list[str], k: float, tmp: str) -> list[str]:
    out = cleaned(tmp)
    wav = Path(tmp, out.name)
    ffmpeg(inputs, f'{GAPLESS},volume={1 / HEADROOM}', '-ac', '2', '-c:a', 'pcm_f32le', str(wav))
    atten = VOICE_DB[0] * (VOICE_DB[1] / VOICE_DB[0]) ** k
    cmd = [DEEP_FILTER, '-D', '-a', f'{atten:.1f}', '-o', str(out.parent), str(wav)]
    subprocess.run(cmd, check=True, capture_output=True)
    return ['-i', str(out)]


def level(inputs: list[str], pre: str) -> str:
    err = ffmpeg(inputs, f'{pre},{LOUDNORM}:print_format=json', '-f', 'null', '-', text=True).stderr
    m = json.loads(err[err.rindex('{') : err.rindex('}') + 1])
    if not all(math.isfinite(float(m[k])) for k in ('target_offset', *(f'input_{k.lower()}' for k in MEASURED))):
        return pre
    measured = ':'.join(f'measured_{k}={m[f"input_{k.lower()}"]}' for k in MEASURED)
    return f'{pre},{LOUDNORM}:{measured}:offset={m["target_offset"]}:linear=false,aresample=48000'


# [DOC: audio-chain]
def chain(src, meta: dict, start: float, dur: float, options: dict, tmp: str) -> tuple[list[str], str]:
    if not meta['has_audio']:
        return [], ''
    inputs, pre = [*LENIENT, '-ss', f'{start:.3f}', '-t', f'{dur:.3f}', '-i', str(src)], GAPLESS
    if (strength := options.get('denoise', 0)) > 0:
        done = cleaned(tmp)  # [DOC: render-cache]
        inputs = ['-i', str(done)] if done.exists() else voice(inputs, strength, tmp)
        pre = f'{GAPLESS},volume={HEADROOM},apad=whole_dur={dur:.3f}'
    return inputs, level(inputs, pre) if options.get('loudnorm') else pre
