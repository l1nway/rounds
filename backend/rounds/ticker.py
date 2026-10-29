import asyncio
import os
from contextlib import asynccontextmanager, suppress

from aiogram.exceptions import TelegramAPIError, TelegramRetryAfter

from . import bot

TICK = 1.0
TYPING_TICKS = 4
SHIMMER = (1, 2, 3, 2, 1, 0)
ACTIVE: dict[str, 'Ticker'] = {}


# [DOC: typing-status]
class Ticker:
    def __init__(self, job: dict):
        self.job, self.text, self.typed, self.sent, self.beat = job, '', 0, '', 0

    def say(self, text: str) -> None:
        self.typed = min(self.typed, len(os.path.commonprefix([self.text, text])))
        self.text = text

    def frame(self) -> str:
        base = self.text.removesuffix('…')
        if self.typed < len(self.text):
            self.typed = min(len(self.text), self.typed + max(3, -(-len(self.text) // TYPING_TICKS)))
            return self.text[: self.typed].removesuffix('…') + ('…' if self.typed == len(self.text) else '')
        if self.text == base:
            return self.text
        self.beat += 1
        return base + '.' * SHIMMER[self.beat % len(SHIMMER)] or base

    async def run(self) -> None:
        while True:
            await asyncio.sleep(TICK)
            frame = self.frame() if self.text else ''
            if frame and frame != self.sent:
                self.sent = frame
                try:
                    await bot.status(self.job, frame)
                except TelegramRetryAfter as error:
                    await asyncio.sleep(error.retry_after)
                except TelegramAPIError:
                    pass


@asynccontextmanager
async def typing(job: dict):
    ticker = ACTIVE[job['id']] = Ticker(job)
    task = asyncio.create_task(ticker.run())
    try:
        yield
    finally:
        task.cancel()
        ACTIVE.pop(job['id'], None)
        with suppress(asyncio.CancelledError):
            await task


async def say(job: dict, text: str) -> None:
    if ticker := ACTIVE.get(job['id']):
        ticker.say(text)
    else:
        await bot.status(job, text)
