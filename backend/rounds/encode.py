import contextlib
import os
import queue
import subprocess
import threading

from . import media, tags
from .config import OUT_SIZE

# [DOC: codecs]
CODECS = {
    'hevc': ['-c:v', 'libx265', '-preset', 'slow', '-profile:v', 'main', '-tag:v', 'hvc1',
             '-x265-params', 'log-level=error:slow-firstpass=0'],
    'av1': ['-c:v', 'libsvtav1', '-preset', '6'],
    'vp9': ['-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-tile-columns', '1',
            '-auto-alt-ref', '1', '-lag-in-frames', '25'],
    'h266': ['-c:v', 'libvvenc', '-preset', 'faster', '-pix_fmt', 'yuv420p10le'],
}  # fmt: skip
FFMPEG = ['ffmpeg', '-v', 'error', '-y', '-nostdin']
QUIET = {**os.environ, 'SVT_LOG': '1'}
AUDIO_RATE = 128_000
AAC = ['-c:a', 'aac', '-b:a', str(AUDIO_RATE), '-ar', '48000', '-ac', '2']
# [DOC: note-size]
NOTE_BYTES = 10_000_000
HEADROOM = 0.97
MAX_RATE = 14_000_000
SHRINK = 0.95
FIT_TRIES = 3
DEPTH = 4
RAW, LOG = 'frames.yuv', 'pass'


def target(dur: float, has_audio: bool, scale: float = 1.0) -> int:
    room = NOTE_BYTES * 8 * HEADROOM - (AUDIO_RATE * dur if has_audio else 0)
    return int(min(MAX_RATE, room / dur) * scale)


def raw(rate: float, src: str) -> list[str]:
    return ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', f'{OUT_SIZE}x{OUT_SIZE}', '-framerate', str(rate), '-i', src]


def video(codec: str, bits: int, n: int, tmp: str) -> list[str]:
    return ['-map', '0:v', '-vf', f'{media.BT709},setsar=1', '-pix_fmt', 'yuv420p', *CODECS[codec], '-g', '60',
            '-b:v', str(bits), '-pass', str(n), '-passlogfile', f'{tmp}/{LOG}']  # fmt: skip


# [DOC: two-pass]
def first_pass(tmp: str, codec: str, rate: float, dur: float, has_audio: bool) -> subprocess.Popen:
    cmd = [*FFMPEG, *raw(rate, 'pipe:0'), *video(codec, target(dur, has_audio), 1, tmp), '-an', '-f', 'null', '-']
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, env=QUIET)


def writer(tmp: str, proc: subprocess.Popen) -> tuple[queue.Queue, threading.Thread]:
    q = queue.Queue(DEPTH)

    def run():
        with open(f'{tmp}/{RAW}', 'wb') as file:
            ok = True
            while (b := q.get()) is not None:
                file.write(b)
                if ok:
                    try:
                        proc.stdin.write(b)
                    except OSError:
                        ok = False
        with contextlib.suppress(OSError):
            proc.stdin.close()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return q, t


def run(cmd: list[str], n: int, progress) -> None:
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, env=QUIET)
    for line in proc.stdout:
        if progress and line.startswith('frame='):
            progress(min(int(line[6:]) / n, 1.0))
    if proc.wait():
        raise RuntimeError(f'encoder failed (ffmpeg exit {proc.returncode})')


# [DOC: note-size]
def second_pass(tmp: str, src, meta: dict, start: float, dur: float, n: int, rate: float, out, options: dict,
                codec: str, progress=None) -> float:  # fmt: skip
    has_audio, scale = meta['has_audio'], 1.0
    # [DOC: render-options]
    audio = ['-map', '1:a:0', '-af', media.audio_filter(src, start, dur, options), *AAC] if has_audio else []
    end = [*tags.created(tags.kept(meta, options)), '-t', f'{dur:.3f}', '-movflags', '+faststart',
           '-progress', 'pipe:1', '-nostats', str(out)]  # fmt: skip
    for _ in range(FIT_TRIES):
        bits = target(dur, has_audio, scale)
        run([*FFMPEG, *raw(rate, f'{tmp}/{RAW}'), *media.audio_input(src, meta, start, dur),
             *video(codec, bits, 2, tmp), *audio, *end], n, progress)  # fmt: skip
        size = os.path.getsize(out)
        if size <= NOTE_BYTES:
            return scale
        scale *= SHRINK * NOTE_BYTES / size
    raise RuntimeError(f'note still over {NOTE_BYTES} bytes after {FIT_TRIES} tries')
