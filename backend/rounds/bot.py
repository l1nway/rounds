import asyncio
import secrets
import time
from contextlib import asynccontextmanager, suppress
from functools import cache
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import CommandStart
from aiogram.types import CallbackQuery, FSInputFile, InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

from . import config
from .config import JOBS_DIR, OUT_SIZE, env

MAX_FILE = 2000 * 1024 * 1024
WARM_FILE = 100 * 1024 * 1024
TEXTS = {
    'start': 'Send me a video, ideally as a file (attach → File) so Telegram does not compress it. '
    'An old round or a forwarded video works too. '
    'I will turn it into a round video note that follows the object you pick.',
    'private': 'This bot is private.',
    'not_video': 'Send a video file.',
    'too_big': 'The file is over 2000 MB: Telegram does not let bots download it.',
    'starting': 'Got it. Waking up the server…',
    'fallback': 'Got it. The full version is unavailable right now, so this video goes through the free one. '
    'Videos already sent to the full version wait for it to come back.',
    'connecting': 'Connecting to Telegram…',
    'downloading': 'Downloading the video… {:.0%}',
    'probing': 'Looking inside the file…',
    'preparing': 'Building the preview and the timeline…',
    'ready': 'Ready. Open the editor to pick the object, the range and the options.',
    'loading': 'GPU is awake, loading the models…',
    'queued_pro': 'Waking up the GPU server, the first run takes about a minute…',
    'queued_free': 'In the queue, the round renders in a minute or two…',
    'decoding': 'Reading the frames…',
    'tracking': 'Following the object… {:.0%}',
    'cuts': 'Looking for scene cuts…',
    'framing': 'Planning a smooth camera path…',
    'rendering': 'Rendering the round… {:.0%}',
    'reusing': 'Reusing the prepared frames… {:.0%}',
    'sending': 'Sending the round…',
    'retrying': 'The server stopped, starting again (attempt {} of {})…',
    'done': 'Done. Open the editor again to make another round from this video.',
    'held': 'Telegram refused the round: your privacy settings block video messages from this bot. '
    'Open Settings → Privacy and Security → Voice Messages, add this bot to the exceptions '
    'and tap Resend within 10 minutes.',
    'still_held': 'Still blocked. Settings → Privacy and Security → Voice Messages → add this bot to the exceptions.',
    'expired': 'This round is no longer kept. Open the editor to render it again.',
    'failed': 'Something went wrong. {}.',
}
ACTION_EVERY, UPLOAD_TIMEOUT, NOTE_NAME = 4, 600, 'round'
HOLD, FORBIDDEN, RESEND = 600, 'VOICE_MESSAGES_FORBIDDEN', 'resend:'  # [DOC: restricted-notes]
UPDATES = ['message', 'callback_query']
VIDEO = F.video | F.video_note | F.document.mime_type.startswith('video/')

dp = Dispatcher()


@cache
def get_bot() -> Bot:
    return Bot(env('TELEGRAM_BOT_TOKEN'))


# [DOC: bot-session]
@asynccontextmanager
async def session(_=None):
    try:
        yield
    finally:
        await get_bot().session.close()


async def feed(update: dict, jobs, spawn, volume) -> None:
    await dp.feed_webhook_update(get_bot(), update, jobs=jobs, spawn=spawn, volume=volume)


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


# [DOC: note-send]
async def send_note(job: dict, path: str, duration: float) -> None:
    note = FSInputFile(path, filename=Path(job.get('name') or NOTE_NAME).with_suffix('.mp4').name)
    sent = {'duration': round(duration), 'length': OUT_SIZE, 'reply_to_message_id': job['source_message_id']}
    async with acting(job['chat_id'], 'upload_video_note'):
        await get_bot().send_video_note(job['chat_id'], note, request_timeout=UPLOAD_TIMEOUT, **sent)


# [DOC: restricted-notes]
async def deliver(job: dict, path: str, duration: float) -> dict | None:
    try:
        await send_note(job, path, duration)
    except TelegramAPIError as error:
        if FORBIDDEN not in error.message and not await restricted(job['chat_id']):
            raise
        return {'at': time.time(), 'duration': duration}
    return None


async def restricted(chat_id: int) -> bool:
    with suppress(TelegramAPIError):
        return bool((await get_bot().get_chat(chat_id)).has_restricted_voice_and_video_messages)
    return False


async def finish(job: dict) -> int:
    if not job.get('held'):
        await status(job, TEXTS['done'], editor(job))
        return job['status_message_id']
    button = InlineKeyboardButton(text='Resend', callback_data=RESEND + job['id'])
    return await announce(job, TEXTS['held'], InlineKeyboardMarkup(inline_keyboard=[[button]]))


@dp.message(~F.from_user.id.func(config.admits))  # [DOC: tiers]
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
    fallback = config.PUBLIC and message.from_user.id in config.allowed_users()  # [DOC: modal-fallback]
    reply = await message.reply(TEXTS['fallback' if fallback else 'starting'])
    job_id = secrets.token_urlsafe(8)[:10]
    job = {
        'id': job_id, 'user_id': message.from_user.id, 'chat_id': message.chat.id,
        'source_message_id': message.message_id, 'status_message_id': reply.message_id,
        'name': getattr(media, 'file_name', None),
        'status': 'ingesting', 'stage': None, 'progress': 0, 'error': None, 'request': None, 'queued_at': time.time(),
    }  # fmt: skip
    await jobs.put.aio(job_id, job)
    await spawn['ingest'](job_id)
    # [DOC: warm-start]
    if (media.file_size or MAX_FILE) <= WARM_FILE:
        await spawn['warm']()


# [DOC: restricted-notes]
@dp.callback_query(F.data.startswith(RESEND))
async def resend(query: CallbackQuery, jobs, volume) -> None:
    job = await jobs.get.aio(query.data.removeprefix(RESEND))
    if not job or job['user_id'] != query.from_user.id:
        await query.answer()
        return
    if not job.get('held') or time.time() - job['held']['at'] > HOLD:
        await query.answer(TEXTS['expired'], show_alert=True)
        return
    with suppress(RuntimeError):
        await volume.reload.aio()
    if await deliver(job, f'{JOBS_DIR}/{job["id"]}/note.mp4', job['held']['duration']):
        await query.answer(TEXTS['still_held'], show_alert=True)
        return
    await query.answer()
    job = {**job, 'held': None}
    await jobs.put.aio(job['id'], job)
    await finish(job)


@dp.message()
async def other(message: Message) -> None:
    await message.answer(TEXTS['not_video'])
