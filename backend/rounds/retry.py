import time

import modal

from . import bot
from .pipeline import ACTIVE, Interrupted, fail, save, waited

ATTEMPTS, QUEUE_LIMIT, MAX_AGE = 3, 900, 2 * 3600


# [DOC: stuck-jobs]
async def start(spawn: dict, state, kind: str, job_id: str, attempt: int = 1, since: float | None = None) -> None:
    call = await spawn[kind](job_id)
    entry = {'id': call.object_id, 'kind': kind, 'attempt': attempt, 'since': since or time.time()}
    await state.put.aio(f'call:{job_id}', entry)


async def alive(call) -> bool:
    try:
        await call.get.aio(timeout=0)
    except TimeoutError:
        return True
    except Exception as error:
        print(f'{call.object_id} ended: {error!r}', flush=True)
    return False


async def stuck(jobs, job_id: str, call) -> bool:
    if not await alive(call):
        return True
    job = await jobs.get.aio(job_id)
    queued = job and job['status'] in ACTIVE and job.get('stage') == 'queued' and waited(job) > QUEUE_LIMIT
    if queued:
        await call.cancel.aio()
    return bool(queued)


# [DOC: stuck-jobs]
async def watch(jobs, state, start) -> None:
    calls = [(k, v) async for k, v in state.items.aio() if isinstance(k, str) and k.startswith('call:')]
    for key, entry in calls:
        job_id, kind, attempt = key.removeprefix('call:'), entry['kind'], entry['attempt'] + 1
        if not await stuck(jobs, job_id, modal.FunctionCall.from_id(entry['id'])):
            continue
        job = await jobs.get.aio(job_id)
        since = entry.get('since', 0)
        old = time.time() - since > MAX_AGE  # [DOC: stuck-age]
        if not job or job['status'] not in ACTIVE or attempt > ATTEMPTS or old:
            await state.pop.aio(key, None)
            if job and job['status'] in ACTIVE:
                reason = 'The server was away too long' if old else f'The server stopped {ATTEMPTS} times in a row'
                await fail(jobs, job, Interrupted(f'{reason}, try again later'))
            continue
        print(f'[{job_id}] retry {kind} attempt={attempt}', flush=True)
        reset = {'stage': 'queued', 'progress': 0} if kind == 'render' else {}
        job = await save(jobs, job, queued_at=time.time(), **reset)
        await bot.status(job, bot.TEXTS['retrying'].format(attempt, ATTEMPTS))
        await start(kind, job_id, attempt, since)
