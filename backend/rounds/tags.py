# [DOC: note-metadata]
import contextlib
import os
import struct

import numpy as np

CREATED = 'creation_time'
MOVIE = ('com.apple.quicktime.creationdate', 'com.apple.quicktime.location.ISO6709',
         'com.apple.quicktime.location.accuracy.horizontal', 'com.apple.quicktime.make', 'com.apple.quicktime.model',
         'com.apple.quicktime.software')  # fmt: skip
CAMERA = ('com.apple.quicktime.camera.lens_model', 'com.apple.quicktime.camera.focal_length.35mm_equivalent',
          'com.apple.quicktime.camera.lens_irisfnumber')  # fmt: skip
ALIASES = {'location': 'com.apple.quicktime.location.ISO6709'}
CONTAINERS = {b'moov', b'trak', b'mdia', b'minf', b'stbl'}
OFFSETS = {b'stco': '>u4', b'co64': '>u8'}
HDLR = b'\0' * 8 + b'mdta' + b'\0' * 14
UTF8 = 1


def box(kind: bytes, body: bytes) -> bytes:
    return struct.pack('>I4s', len(body) + 8, kind) + body


def boxes(buf: bytes, start: int = 0):
    while start + 8 <= len(buf):
        size, kind = struct.unpack_from('>I4s', buf, start)
        head = 8
        if size == 1:
            size, head = struct.unpack_from('>Q', buf, start + 8)[0], 16
        size = size or len(buf) - start
        if size < head or start + size > len(buf):
            return
        yield kind, buf[start + head : start + size]
        start += size


def moov(f) -> tuple[int, int, bytes]:
    end, pos = f.seek(0, 2), 0
    while pos + 8 <= end:
        f.seek(pos)
        size, kind = struct.unpack('>I4s', f.read(8))
        head = 8
        if size == 1:
            size, head = struct.unpack('>Q', f.read(8))[0], 16
        size = size or end - pos
        if size < head:
            break
        if kind == b'moov':
            return pos, size, f.read(size - head)
        pos += size
    raise ValueError('no moov box')


def handler(trak: bytes) -> bytes:
    return dict(boxes(dict(boxes(trak)).get(b'mdia', b''))).get(b'hdlr', b'')[8:12]


# quicktime meta has no version
def mdta(meta: bytes) -> dict[str, str]:
    parts = dict(boxes(meta, 0 if meta[4:8] == b'hdlr' else 4))
    names = [key.decode('utf-8', 'replace') for _, key in boxes(parts.get(b'keys', b''), 8)]
    out = {}
    for index, item in boxes(parts.get(b'ilst', b'')):
        i = int.from_bytes(index) - 1
        for kind, data in boxes(item):
            if kind == b'data' and int.from_bytes(data[:4]) == UTF8 and 0 <= i < len(names):
                out[names[i]] = data[8:].decode('utf-8', 'replace')
    return out


def read(path, found: dict) -> dict[str, str]:
    tags = {ALIASES[k]: found[k] for k in ALIASES if k in found}
    tags.update({k: found[k] for k in (CREATED, *MOVIE) if k in found})
    with contextlib.suppress(Exception), open(path, 'rb') as f:
        trak = next((b for k, b in boxes(moov(f)[2]) if k == b'trak' and handler(b) == b'vide'), b'')
        tags.update({k: v for k, v in mdta(dict(boxes(trak)).get(b'meta', b'')).items() if k in CAMERA})
    clean = {k: str(v).split(';')[0].strip() for k, v in tags.items()}  # ffmpeg joins repeats
    return {k: v for k, v in clean.items() if v}


def kept(meta: dict, options: dict) -> dict[str, str]:
    return (meta.get('tags') or {}) if options.get('metadata') else {}


def created(tags: dict) -> list[str]:
    return ['-metadata', f'{CREATED}={tags[CREATED]}'] if CREATED in tags else []


def meta_box(tags: dict) -> bytes:
    if not tags:
        return b''
    keys = struct.pack('>II', 0, len(tags)) + b''.join(box(b'mdta', k.encode()) for k in tags)
    data = (box(b'data', struct.pack('>II', UTF8, 0) + v.encode()) for v in tags.values())
    items = (box(i.to_bytes(4), d) for i, d in enumerate(data, 1))
    return box(b'meta', box(b'hdlr', HDLR) + box(b'keys', keys) + box(b'ilst', b''.join(items)))


def rebuild(kind: bytes, body: bytes, add, shift) -> bytes:
    if kind in OFFSETS:
        offsets = np.frombuffer(body, OFFSETS[kind], int.from_bytes(body[4:8]), 8)
        return box(kind, body[:8] + shift(offsets).astype(OFFSETS[kind]).tobytes())
    if kind not in CONTAINERS:
        return box(kind, body)
    return box(kind, b''.join(rebuild(k, b, add, shift) for k, b in boxes(body)) + add(kind, body))


def write(path, tags: dict) -> None:
    movie, camera = (meta_box({k: v for k, v in tags.items() if k in keys}) for keys in (MOVIE, CAMERA))
    if not movie + camera:
        return
    with open(path, 'rb') as f:
        pos, size, body = moov(f)
        f.seek(0)
        data = memoryview(f.read())

    def build(shift) -> bytes:
        pending = {b'moov': movie, b'vide': camera}

        def add(kind: bytes, body: bytes) -> bytes:
            return pending.pop(kind if kind == b'moov' else handler(body) if kind == b'trak' else b'', b'')

        return rebuild(b'moov', body, add, shift)

    delta = len(build(lambda o: o)) - size
    new = build(lambda o: np.where(o > pos, o.astype(np.int64) + delta, o))
    with open(f'{path}.tmp', 'wb') as out:
        out.write(data[:pos])
        out.write(new)
        out.write(data[pos + size :])
    os.replace(f'{path}.tmp', path)
