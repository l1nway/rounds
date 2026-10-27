import asyncio
import contextlib
import time
from collections.abc import Callable
from contextlib import asynccontextmanager

from telethon import TelegramClient, utils
from telethon.sessions import StringSession

from .config import env

LEASE = 60
WAIT = 1
# [DOC: mtproto-lanes]
PART, LANES = 512 * 1024, 4
KEYS = 3  # [DOC: mtproto-keys]


# [DOC: dict-lease]
@asynccontextmanager
async def held(state, name: str):
    lease = f'lease:{name}'
    while not await state.put.aio(lease, time.time(), skip_if_exists=True):
        if time.time() - (await state.get.aio(lease) or 0) > LEASE:
            with contextlib.suppress(KeyError):
                await state.pop.aio(lease)
        await asyncio.sleep(WAIT)

    async def hold() -> None:
        while True:
            await asyncio.sleep(LEASE / 4)
            await state.put.aio(lease, time.time())

    holding = asyncio.create_task(hold())
    try:
        yield
    finally:
        holding.cancel()
        with contextlib.suppress(KeyError):
            await state.pop.aio(lease)


# [DOC: mtproto-sessions]
@asynccontextmanager
async def client(state, name: str):
    key = f'session:{name}'
    async with held(state, name):
        session = StringSession(await state.get.aio(key) or '')
        tg = TelegramClient(session, int(env('TELEGRAM_API_ID')), env('TELEGRAM_API_HASH'), receive_updates=False)
        await tg.start(bot_token=env('TELEGRAM_BOT_TOKEN'))
        await state.put.aio(key, session.save())
        try:
            yield tg
        finally:
            await tg.disconnect()


# [DOC: mtproto-keys]
@asynccontextmanager
async def clients(state, name: str):
    async with contextlib.AsyncExitStack() as stack:
        yield [await stack.enter_async_context(client(state, f'{name}{i or ""}')) for i in range(KEYS)]


def lanes(parts: int, count: int) -> list[range]:
    step = max(1, -(-parts // count))
    return [range(i, min(i + step, parts)) for i in range(0, parts, step)]


# [DOC: mtproto-lanes]
async def download(tgs: list[TelegramClient], message_id: int, path: str, progress: Callable[[float], None]) -> str:
    messages = await asyncio.gather(*(tg.get_messages(None, ids=message_id) for tg in tgs))
    if not all(m and m.document for m in messages):
        raise ValueError('The source message has no file')
    doc, path, done = messages[0].document, path + utils.get_extension(messages[0].document), 0

    async def lane(k: int, parts: range) -> None:
        nonlocal done
        at, tg, own = parts.start * PART, tgs[k % len(tgs)], messages[k % len(tgs)].document
        async for chunk in tg.iter_download(own, offset=at, limit=len(parts), request_size=PART):
            out.seek(at)
            out.write(chunk)
            at, done = at + len(chunk), done + len(chunk)
            progress(done / doc.size)

    with open(path, 'wb') as out:
        await asyncio.gather(*(lane(k, r) for k, r in enumerate(lanes(-(-doc.size // PART), LANES * len(tgs)))))
    return path
