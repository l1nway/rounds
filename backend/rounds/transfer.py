from collections.abc import Callable
from contextlib import asynccontextmanager

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import DocumentAttributeVideo

from .config import OUT_SIZE, env


# [DOC: mtproto-sessions]
@asynccontextmanager
async def client(state, name: str):
    key = f'session:{name}'
    session = StringSession(await state.get.aio(key) or '')
    tg = TelegramClient(session, int(env('TELEGRAM_API_ID')), env('TELEGRAM_API_HASH'), receive_updates=False)
    await tg.start(bot_token=env('TELEGRAM_BOT_TOKEN'))
    await state.put.aio(key, session.save())
    try:
        yield tg
    finally:
        await tg.disconnect()


async def download(tg: TelegramClient, message_id: int, path: str, progress: Callable[[float], None]) -> str:
    message = await tg.get_messages(None, ids=message_id)
    if not message or not message.file:
        raise ValueError('The source message has no file')
    return await tg.download_media(message, file=path, progress_callback=lambda done, total: progress(done / total))


async def send_note(tg: TelegramClient, chat_id: int, reply_to: int, path: str, duration: float) -> None:
    await tg.get_messages(None, ids=reply_to)
    attribute = DocumentAttributeVideo(duration, OUT_SIZE, OUT_SIZE, round_message=True)
    await tg.send_file(chat_id, path, video_note=True, attributes=[attribute], reply_to=reply_to)
