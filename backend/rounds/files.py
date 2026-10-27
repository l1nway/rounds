import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import secrets
import shutil
import time
from pathlib import Path

from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import auth, bot
from .config import JOBS_DIR, MAX_DURATION, OUT_SIZE
from .encode import NOTE_BYTES
from .source import run

URL_TTL = 6 * 3600
RELOADS, RELOAD_WAIT = 4, 0.3
FILES = {'proxy.mp4': 'video/mp4', 'filmstrip.jpg': 'image/jpeg'}
# [DOC: browser-upload]
CHUNK_BYTES = 50 << 20
MAX_PARTS = -(-bot.MAX_FILE // CHUNK_BYTES)
EXTENSIONS = ('.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp')
NOTE_PROBE = ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-of', 'json',
              '-show_entries', 'stream=width,height:format=duration']  # fmt: skip
STARTING = 'Uploading the video from the browser…'
NO_CHAT = 'Start the bot in Telegram first, then try again'


class Upload(BaseModel):
    name: str = Field(max_length=255)
    size: int = Field(gt=0, le=bot.MAX_FILE)


# [DOC: signed-urls]
def signature(tier: str, job_id: str, name: str, exp: int) -> str:
    key = auth.secret(f'Files.{tier}'.encode())
    return hmac.new(key, f'{job_id}:{name}:{exp}'.encode(), hashlib.sha256).hexdigest()


def signed_url(tier: str, request: Request, job_id: str, name: str) -> str:
    base = request.headers.get('x-rounds-base') or str(request.base_url).rstrip('/').replace('http://', 'https://')
    exp = int(time.time()) + URL_TTL
    return f'{base}/api/jobs/{job_id}/{name}?exp={exp}&sig={signature(tier, job_id, name, exp)}'


async def receive(request: Request, path: Path, limit: int) -> int:
    got = 0
    with open(path, 'wb') as out:
        async for piece in request.stream():
            got += len(piece)
            if got > limit:
                raise HTTPException(413, 'The part is too big')
            out.write(piece)
    return got


# [DOC: client-note]
def checked(path: Path) -> float:
    found = json.loads(run([*NOTE_PROBE, str(path)]))
    side, duration = found['streams'][0], float(found['format']['duration'])
    if side['width'] != side['height'] or side['width'] > OUT_SIZE or not 0 < duration <= MAX_DURATION + 1:
        raise HTTPException(422, 'This is not a round')
    return duration


async def opened(user_id: int, text: str) -> int:
    try:
        return (await bot.get_bot().send_message(user_id, text)).message_id
    except TelegramAPIError as error:
        raise HTTPException(409, NO_CHAT) from error


def mount(api: FastAPI, jobs, volume, spawn, own_job, tier: str) -> None:
    async def new_job(authorization: str, text: str, **extra) -> dict:
        user_id = auth.user_of(authorization)
        job_id = secrets.token_urlsafe(8)[:10]
        job = {'id': job_id, 'user_id': user_id, 'chat_id': user_id, 'source_message_id': None,
               'status_message_id': await opened(user_id, text), 'stage': None, 'progress': 0, 'error': None,
               'request': None, 'queued_at': time.time(), **extra}  # fmt: skip
        os.makedirs(f'{JOBS_DIR}/{job_id}', exist_ok=True)
        await jobs.put.aio(job_id, job)
        return job

    # [DOC: browser-upload]
    @api.post('/api/uploads')
    async def upload(body: Upload, authorization: str = Header('')):
        ext = Path(body.name).suffix.lower()
        source = f'source{ext if ext in EXTENSIONS else ".mp4"}'
        job = await new_job(authorization, STARTING, name=body.name, status='uploading', upload=True, size=body.size,
                            source=source)  # fmt: skip
        return {'id': job['id'], 'chunk': CHUNK_BYTES}

    @api.put('/api/jobs/{job_id}/parts/{k}')
    async def part(job_id: str, k: int, request: Request, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        if job['status'] != 'uploading' or not 0 <= k < MAX_PARTS:
            raise HTTPException(409, 'The upload is over')
        await receive(request, Path(JOBS_DIR, job_id, f'part{k:04d}'), CHUNK_BYTES)
        await volume.commit.aio()
        return {}

    @api.post('/api/jobs/{job_id}/uploaded', status_code=202)
    async def uploaded(job_id: str, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        if job['status'] != 'uploading':
            raise HTTPException(409, 'The upload is over')
        with contextlib.suppress(RuntimeError):
            await volume.reload.aio()
        folder = Path(JOBS_DIR, job_id)
        parts = sorted(folder.glob('part*'))
        if sum(p.stat().st_size for p in parts) != job['size']:
            raise HTTPException(409, 'Some parts of the video are missing, upload it again')
        await asyncio.to_thread(join, parts, folder / job['source'])
        await volume.commit.aio()
        await jobs.put.aio(job_id, {**job, 'status': 'ingesting', 'queued_at': time.time()})
        await spawn['ingest'](job_id)
        return {'status': 'ingesting'}

    # [DOC: client-note]
    async def deliver(job: dict, path: Path) -> dict:
        duration = await asyncio.to_thread(checked, path)
        await volume.commit.aio()
        held = await bot.deliver(job, str(path), duration)
        job = {**job, 'status': 'done', 'stage': None, 'progress': 1, 'held': held}
        if held or job.get('meta'):
            job['status_message_id'] = await bot.finish(job)
        else:
            with contextlib.suppress(TelegramBadRequest):
                await bot.get_bot().delete_message(job['chat_id'], job['status_message_id'])
        await jobs.put.aio(job['id'], job)
        return {'status': 'done', 'held': bool(held)}

    @api.post('/api/notes')
    async def note(request: Request, name: str = 'round', authorization: str = Header('')):
        job = await new_job(authorization, bot.TEXTS['sending'], name=name[:255], status='sending')
        path = Path(JOBS_DIR, job['id'], 'note.mp4')
        await receive(request, path, NOTE_BYTES)
        return await deliver(job, path)

    @api.post('/api/jobs/{job_id}/note')
    async def job_note(job_id: str, request: Request, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        if job['status'] not in ('ready', 'done', 'failed'):
            raise HTTPException(409, 'The video is busy, wait for it to finish')
        path = Path(JOBS_DIR, job_id, 'note.mp4')
        await receive(request, path, NOTE_BYTES)
        return await deliver(job, path)

    @api.get('/api/jobs/{job_id}/{name}')
    async def file(job_id: str, name: str, exp: int, sig: str):
        if name not in FILES or exp < time.time() or not hmac.compare_digest(sig, signature(tier, job_id, name, exp)):
            raise HTTPException(403)
        path = f'{JOBS_DIR}/{job_id}/{name}'
        for _ in range(RELOADS):
            if os.path.exists(path):
                break
            with contextlib.suppress(RuntimeError):
                await volume.reload.aio()
            await asyncio.sleep(RELOAD_WAIT)
        if not os.path.exists(path):
            raise HTTPException(404)
        return FileResponse(path, media_type=FILES[name], headers={'Cache-Control': 'private, max-age=21600'})


def join(parts: list[Path], out: Path) -> None:
    with open(out, 'wb') as whole:
        for p in parts:
            with open(p, 'rb') as piece:
                shutil.copyfileobj(piece, whole, 1 << 22)
            p.unlink()
