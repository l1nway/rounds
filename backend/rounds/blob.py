import subprocess

import numpy as np

DEPTH = 65535
RAW = ['-f', 'rawvideo', '-pix_fmt', 'rgb48le']
LOSSLESS = ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'gbrp10le', '-f', 'matroska']


def clone(path: str, url: str, sha: str) -> str:
    return f'git clone -q {url} {path} && git -C {path} checkout -q {sha}'


def ffmpeg(args: list, data: bytes) -> bytes:
    return subprocess.run(['ffmpeg', '-v', 'error', *args], input=data, capture_output=True, check=True).stdout


def pack(frames: np.ndarray) -> bytes:
    n, h, w, _ = frames.shape
    return ffmpeg([*RAW, '-s', f'{w}x{h}', '-i', '-', *LOSSLESS, '-'], frames.astype('<u2').tobytes())


def unpack(blob: bytes, size: int) -> np.ndarray:
    return np.frombuffer(ffmpeg(['-i', '-', *RAW, '-'], blob), '<u2').reshape(-1, size, size, 3)
