import asyncio
import secrets
import time
from contextlib import asynccontextmanager, suppress
from functools import cache

from aiogram import Bot, Dispatcher, F
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

from .config import allowed_users, env

MAX_FILE = 2000 * 1024 * 1024
TEXTS = {
    'start': 'Send me a video, ideally as a file (attach → File) so Telegram does not compress it. '
    'An old round or a forwarded video works too. '
    'I will turn it into a round video note that follows the object you pick.',
    'private': 'This bot is private.',
    'not_video': 'Send a video file.',
    'too_big': 'The file is over 2000 MB: Telegram does not let bots download it.',
    'downloading': 'Downloading the video… {:.0%}',
    'probing': 'Looking inside the file…',
    'preparing': 'Building the preview and the timeline…',
    'ready': 'Ready. Open the editor to pick the object, the range and the options.',
    'queued': 'Waking up a GPU and loading the tracker, the first run takes about a minute…',
    'decoding': 'Reading the frames…',
    'tracking': 'Following the object… {:.0%}',
    'cuts': 'Looking for scene cuts…',
    'framing': 'Planning a smooth camera path…',
    'rendering': 'Rendering the round… {:.0%}',
    'sending': 'Sending the round…',
    'done': 'Done. Open the editor again to make another round from this video.',
    'failed': 'Something went wrong. {}.',
}
ACTION_EVERY = 4
VIDEO = F.video | F.video_note | F.document.mime_type.startswith('video/')

dp = Dispatcher()


@cache
def get_bot() -> Bot:
    return Bot(env('TELEGRAM_BOT_TOKEN'))


async def feed(update: dict, jobs, spawn) -> None:
    await dp.feed_webhook_update(get_bot(), update, jobs=jobs, spawn=spawn)


# [DOC: launch-aspect]
def editor(job: dict) -> InlineKeyboardMarkup:
    meta = job.get('meta')
    aspect = f'&a={round(meta["width"] / meta["height"], 6)}' if meta else ''
    url = f'{env("MINIAPP_URL")}?job={job["id"]}{aspect}'
    button = InlineKeyboardButton(text='Open editor', web_app=WebAppInfo(url=url))
    return InlineKeyboardMarkup(inline_keyboard=[[button]])


async def status(job: dict, text: str, markup: InlineKeyboardMarkup | None = None) -> None:
    with suppress(TelegramBadRequest):
        await get_bot().edit_message_text(
            text=text, chat_id=job['chat_id'], message_id=job['status_message_id'], reply_markup=markup
        )


# [DOC: ready-notice]
async def announce(job: dict, text: str, markup: InlineKeyboardMarkup | None = None) -> int:
    sent = await get_bot().send_message(
        job['chat_id'], text, reply_markup=markup, reply_to_message_id=job['source_message_id']
    )
    with suppress(TelegramBadRequest):
        await get_bot().delete_message(job['chat_id'], job['status_message_id'])
    return sent.message_id


# [DOC: chat-action]
@asynccontextmanager
async def acting(chat_id: int, action: str):
    async def pulse() -> None:
        while True:
            with suppress(TelegramAPIError):
                await get_bot().send_chat_action(chat_id, action)
            await asyncio.sleep(ACTION_EVERY)

    task = asyncio.create_task(pulse())
    try:
        yield
    finally:
        task.cancel()


@dp.message(~F.from_user.id.func(lambda user_id: user_id in allowed_users()))
async def private(message: Message) -> None:
    await message.answer(TEXTS['private'])


@dp.message(CommandStart())
async def start(message: Message) -> None:
    await message.answer(TEXTS['start'])


@dp.message(VIDEO)
async def video(message: Message, jobs, spawn) -> None:
    media = message.video or message.video_note or message.document
    if media.file_size and media.file_size > MAX_FILE:
        await message.reply(TEXTS['too_big'])
        return
    reply = await message.reply(TEXTS['downloading'].format(0))
    job_id = secrets.token_urlsafe(8)[:10]
    job = {
        'id': job_id, 'user_id': message.from_user.id, 'chat_id': message.chat.id,
        'source_message_id': message.message_id, 'status_message_id': reply.message_id,
        'status': 'ingesting', 'stage': None, 'progress': 0, 'error': None, 'request': None, 'queued_at': time.time(),
    }  # fmt: skip
    await jobs.put.aio(job_id, job)
    await spawn['ingest'](job_id)


@dp.message()
async def other(message: Message) -> None:
    await message.answer(TEXTS['not_video'])
