import asyncio
import hmac
import time
from functools import partial
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, model_validator

from . import auth, bot, files
from .config import MAX_DURATION, env

# [DOC: look-cors]
CORS = {'allow_methods': ['GET', 'POST'], 'allow_headers': ['Authorization', 'Content-Type', 'Range']}
PUBLIC = ('id', 'status', 'stage', 'progress', 'error', 'meta', 'filmstrip', 'request')
MASK = r'^data:image/png;base64,[A-Za-z0-9+/]+=*$'
MASK_CHARS = 90_000
# [DOC: tiers]
PRO_OPTIONS, PRO_LEVELS = ('interpolate', 'upscale'), ('look', 'exposure', 'stabilize')
PRO_ONLY = 'This needs the full version of the bot'


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


# [DOC: track-preview]
class Span(BaseModel):
    start: float = Field(ge=0)
    end: float
    prompt: Prompt

    @model_validator(mode='after')
    def check(self):
        if not 0 < self.end - self.start <= MAX_DURATION + 1e-3:
            raise ValueError(f'The range must be up to {MAX_DURATION} s')
        if self.prompt.time is not None and not self.start <= self.prompt.time <= self.end:
            raise ValueError('The selection must be inside the range')
        return self


class RenderRequest(Span):
    options: dict[str, bool] = {}
    codec: Literal['av1', 'hevc', 'vp9'] = 'av1'  # [DOC: codecs]
    denoise: float = Field(0, ge=0, le=1)  # [DOC: denoise]
    stabilize: float = Field(0, ge=0, le=1)  # [DOC: stabilization]
    look: float = Field(0, ge=0, le=1)  # [DOC: look]
    exposure: float = Field(0, ge=-2, le=2)


# [DOC: look-preview]
class LookRequest(BaseModel):
    time: float = Field(ge=0)
    look: float = Field(ge=0, le=1)
    exposure: float = Field(0, ge=-2, le=2)


# [DOC: telegram-login]
class Login(BaseModel):
    code: str = Field(max_length=512)
    verifier: str = Field(min_length=43, max_length=128)
    redirect: str = Field(max_length=512)


# [DOC: tiers]
def free_render(body: RenderRequest) -> bool:
    return not any(body.options.get(k) for k in PRO_OPTIONS) and not any(getattr(body, k) for k in PRO_LEVELS)


def create(jobs, volume, spawn, tier: str = 'pro') -> FastAPI:
    origin = '{0.scheme}://{0.netloc}'.format(urlsplit(env('MINIAPP_URL')))
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=bot.session)  # [DOC: bot-session]
    api.add_middleware(CORSMiddleware, allow_origins=[origin], **CORS)

    async def own_job(job_id: str, authorization: str) -> dict:
        user_id = auth.user_of(authorization)  # [DOC: auth-header]
        job = await jobs.get.aio(job_id)
        if not job or job['user_id'] != user_id:
            raise HTTPException(404, 'Job not found')
        return job

    # [DOC: tiers]
    def pro(call: str) -> None:
        if call not in spawn:
            raise HTTPException(403, PRO_ONLY)

    # [DOC: lift]
    async def lift(call: str, job_id: str, job: dict, at: float, *args, failure: str):
        pro(call)
        if not job.get('proxy') or at > job['meta']['duration'] + 1e-3:
            raise HTTPException(409, 'The video is not ready yet')
        try:
            return await spawn[call](job_id, at, *args, (job['proxy']['width'], job['proxy']['height']))
        except Exception as error:
            print(f'{call} {job_id} failed: {error!r}')
            raise HTTPException(502, failure) from error

    @api.post('/telegram/webhook')
    async def webhook(request: Request, token: str = Header('', alias='X-Telegram-Bot-Api-Secret-Token')):
        if not hmac.compare_digest(token, env('TELEGRAM_WEBHOOK_SECRET')):
            raise HTTPException(403)
        await bot.feed(await request.json(), jobs, spawn, volume)
        return {}

    # [DOC: telegram-login]
    @api.get('/api/auth/start')
    async def login_start(redirect: str, challenge: str, state: str):
        if not redirect.startswith(f'{origin}/'):
            raise HTTPException(400, 'Unknown page')
        return RedirectResponse(auth.login_url(redirect, challenge, state))

    @api.post('/api/auth')
    async def login(body: Login):
        return await auth.login(body.code, body.verifier, body.redirect)

    @api.get('/api/jobs/{job_id}')
    async def get_job(job_id: str, request: Request, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        url = partial(files.signed_url, tier, request, job_id)
        urls = {f'{n.split(".")[0]}_url': job.get('proxy') and url(n) for n in files.FILES}
        return {**{k: job.get(k) for k in PUBLIC}, **urls, 'max_duration': MAX_DURATION, 'tier': tier}

    @api.post('/api/jobs/{job_id}/render', status_code=202)
    async def render(job_id: str, body: RenderRequest, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        if job['status'] not in ('ready', 'done', 'failed'):
            raise HTTPException(409, 'The video is busy, wait for it to finish')
        if body.end > job['meta']['duration'] + 1e-3:
            raise HTTPException(422, 'The range is outside the video')
        if tier == 'pro' and body.prompt.time is None and job['meta']['width'] != job['meta']['height']:
            raise HTTPException(422, 'Select the object')
        if tier == 'free' and not free_render(body):
            raise HTTPException(403, PRO_ONLY)
        reply = await bot.get_bot().send_message(
            job['chat_id'], bot.TEXTS[f'queued_{tier}'], reply_to_message_id=job['source_message_id']
        )
        update = {
            'status': 'rendering', 'stage': 'queued', 'progress': 0, 'error': None, 'request': body.model_dump(),
            'status_message_id': reply.message_id, 'queued_at': time.time(), 'held': None,
        }  # fmt: skip
        await jobs.put.aio(job_id, {**job, **update})
        await spawn['render'](job_id)
        return {'status': 'rendering'}

    @api.post('/api/jobs/{job_id}/warm', status_code=202)
    async def warm(job_id: str, authorization: str = Header('')):
        await own_job(job_id, authorization)
        await asyncio.gather(*(spawn[k]() for k in ('warm', 'warm_render') if k in spawn))  # [DOC: render-warm]
        return {}

    # [DOC: lift]
    @api.post('/api/jobs/{job_id}/segment')
    async def segment(job_id: str, body: Prompt, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        if body.time is None:
            raise HTTPException(422, 'Select the object')
        failure = 'The outline is not available, the point still works'
        return await lift('segment', job_id, job, body.time, body.points, body.box, failure=failure)

    # [DOC: track-preview]
    @api.post('/api/jobs/{job_id}/track')
    async def follow(job_id: str, body: Span, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        if body.prompt.time is None:
            raise HTTPException(422, 'Select the object')
        if body.end > job['meta']['duration'] + 1e-3:
            raise HTTPException(422, 'The range is outside the video')
        pro('prepare')
        await spawn['prepare'](job_id, body.model_dump())  # [DOC: track-cache]
        args = body.prompt.model_dump(), body.start, body.end
        return await lift('follow', job_id, job, body.prompt.time, *args, failure='The object cannot be followed here')

    # [DOC: look-preview]
    @api.post('/api/jobs/{job_id}/look')
    async def look(job_id: str, body: LookRequest, authorization: str = Header('')):
        job = await own_job(job_id, authorization)
        args = job.get('source'), job.get('meta'), body.look, body.exposure
        return await lift('look', job_id, job, body.time, *args, failure='The preview is not available')

    files.mount(api, jobs, volume, spawn, own_job, tier)
    return api
