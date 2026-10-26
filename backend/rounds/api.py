import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import time
from typing import Literal
from urllib.parse import parse_qsl, urlsplit

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator

from . import bot
from .config import JOBS_DIR, MAX_DURATION, allowed_users, env

INIT_DATA_TTL = 24 * 3600
URL_TTL = 6 * 3600
RELOADS, RELOAD_WAIT = 4, 0.3
FILES = {'proxy.mp4': 'video/mp4', 'filmstrip.jpg': 'image/jpeg'}
CORS = {'allow_methods': ['GET', 'POST'], 'allow_headers': ['Authorization', 'Content-Type']}
PUBLIC = ('id', 'status', 'stage', 'progress', 'error', 'meta', 'filmstrip', 'request')
MASK = r'^data:image/png;base64,[A-Za-z0-9+/]+=*$'
MASK_CHARS = 90_000


class Prompt(BaseModel):
    time: float | None = None
    points: list[tuple[float, float, int]] = []
    box: tuple[float, float, float, float] | None = None
    mask: str | None = Field(None, max_length=MASK_CHARS, pattern=MASK)

    # [DOC: square-source]
    @model_validator(mode='after')
    def check(self):
        coords = [v for x, y, _ in self.points for v in (x, y)] + list(self.box or ())
        if self.time is None and not coords and not self.mask:
            return self
        if self.time is None or self.time < 0 or not coords or any(not 0 <= v <= 1 for v in coords):
            raise ValueError('Select the object')
        return self


class RenderRequest(BaseModel):
    start: float = Field(ge=0)
    end: float
    prompt: Prompt
    options: dict[str, bool] = {}
    codec: Literal['hevc', 'av1', 'vp9', 'h266'] = 'hevc'  # [DOC: codecs]

    @model_validator(mode='after')
    def check(self):
        if not 0 < self.end - self.start <= MAX_DURATION + 1e-3:
            raise ValueError(f'The range must be up to {MAX_DURATION} s')
        if self.prompt.time is not None and not self.start <= self.prompt.time <= self.end:
            raise ValueError('The selection must be inside the range')
        return self


def secret(label: bytes) -> bytes:
    return hmac.new(label, env('TELEGRAM_BOT_TOKEN').encode(), hashlib.sha256).digest()


# [DOC: init-data]
def user_from_init_data(init_data: str) -> int:
    fields = dict(parse_qsl(init_data, keep_blank_values=True))
    check = '\n'.join(f'{k}={v}' for k, v in sorted(fields.items()) if k != 'hash')
    digest = hmac.new(secret(b'WebAppData'), check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(digest, fields.get('hash', '')):
        raise HTTPException(401, 'Open the editor from the bot')
    if time.time() - int(fields.get('auth_date', 0)) > INIT_DATA_TTL:
        raise HTTPException(401, 'The session expired, reopen the editor')
    user_id = json.loads(fields.get('user', '{}')).get('id')
    if user_id not in allowed_users():
        raise HTTPException(403, 'This bot is private')
    return user_id


# [DOC: signed-urls]
def signature(job_id: str, name: str, exp: int) -> str:
    return hmac.new(secret(b'Files'), f'{job_id}:{name}:{exp}'.encode(), hashlib.sha256).hexdigest()


def signed_url(base: str, job_id: str, name: str) -> str:
    exp = int(time.time()) + URL_TTL
    return f'{base}/api/jobs/{job_id}/{name}?exp={exp}&sig={signature(job_id, name, exp)}'


def create(jobs, volume, spawn) -> FastAPI:
    origin = '{0.scheme}://{0.netloc}'.format(urlsplit(env('MINIAPP_URL')))
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    api.add_middleware(CORSMiddleware, allow_origins=[origin], **CORS)

    async def own_job(job_id: str, authorization: str) -> dict:
        user_id = user_from_init_data(authorization.removeprefix('tma '))
        job = await jobs.get.aio(job_id)
        if not job or job['user_id'] != user_id:
            raise HTTPException(404, 'Job not found')
        return job

    @api.post('/telegram/webhook')
    async def webhook(request: Request, token: str = Header('', alias='X-Telegram-Bot-Api-Secret-Token')):
        if not hmac.compare_digest(token, env('TELEGRAM_WEBHOOK_SECRET')):
            raise HTTPException(403)
        await bot.feed(await request.json(), jobs, spawn)
        return {}

    @api.get('/api/jobs/{job_id}')
    async def get_job(job_id: str, request: Request, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        base = str(request.base_url).rstrip('/').replace('http://', 'https://')
        urls = {f'{name.split(".")[0]}_url': job.get('proxy') and signed_url(base, job_id, name) for name in FILES}
        return {**{k: job.get(k) for k in PUBLIC}, **urls, 'max_duration': MAX_DURATION}

    @api.post('/api/jobs/{job_id}/render', status_code=202)
    async def render(job_id: str, body: RenderRequest, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        if job['status'] not in ('ready', 'done', 'failed'):
            raise HTTPException(409, 'The video is busy, wait for it to finish')
        if body.end > job['meta']['duration'] + 1e-3:
            raise HTTPException(422, 'The range is outside the video')
        if body.prompt.time is None and job['meta']['width'] != job['meta']['height']:
            raise HTTPException(422, 'Select the object')
        reply = await bot.get_bot().send_message(
            job['chat_id'], bot.TEXTS['queued'], reply_to_message_id=job['source_message_id']
        )
        update = {
            'status': 'rendering', 'stage': 'queued', 'progress': 0, 'error': None, 'request': body.model_dump(),
            'status_message_id': reply.message_id, 'queued_at': time.time(),
        }  # fmt: skip
        await jobs.put.aio(job_id, {**job, **update})
        await spawn['render'](job_id)
        return {'status': 'rendering'}

    @api.post('/api/jobs/{job_id}/warm', status_code=202)
    async def warm(job_id: str, authorization: str = Header('')):
        await own_job(job_id, authorization)
        await spawn['warm']()
        return {}

    # [DOC: lift]
    @api.post('/api/jobs/{job_id}/segment')
    async def segment(job_id: str, body: Prompt, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        if body.time is None:
            raise HTTPException(422, 'Select the object')
        if not job.get('proxy') or body.time > job['meta']['duration'] + 1e-3:
            raise HTTPException(409, 'The video is not ready yet')
        size = job['proxy']['width'], job['proxy']['height']
        try:
            return await spawn['segment'](job_id, body.time, body.points, body.box, size)
        except Exception as error:
            print(f'segment {job_id} failed: {error!r}')
            raise HTTPException(502, 'The outline is not available, the point still works') from error

    @api.get('/api/jobs/{job_id}/{name}')
    async def file(job_id: str, name: str, exp: int, sig: str):
        if name not in FILES or exp < time.time() or not hmac.compare_digest(sig, signature(job_id, name, exp)):
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

    return api
