import json
import sqlite3
import time

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field, ValidationError

from . import auth
from .config import DATA_DIR

# [DOC: telemetry]
DB = f'{DATA_DIR}/telemetry.db'
KEEP = 90 * 24 * 3600
BODY = 48 << 10
EVENTS, KIND = 60, 32
RATE, MINUTE = 60, 60
JSON = (',', ':')
ID = r'^[0-9a-f]{16,32}$'
SCHEMA = (
    'create table if not exists events (at real not null, install text not null, session text not null, '
    'build text not null, t real not null, kind text not null, data text not null)',
    'create index if not exists events_at on events (at)',
    'create index if not exists events_install on events (install, t)',
)


class Event(BaseModel):
    t: float
    kind: str = Field(max_length=KIND, pattern=r'^[a-z][a-z0-9.-]*$')
    data: dict = {}


class Batch(BaseModel):
    auth: str = Field(max_length=4096)
    install: str = Field(pattern=ID)
    session: str = Field(pattern=ID)
    build: str = Field(max_length=40)
    events: list[Event] = Field(max_length=EVENTS)


class Telemetry:
    def __init__(self, path: str = DB):
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute('pragma journal_mode=wal')
        for statement in SCHEMA:
            self.db.execute(statement)
        self.counts: dict[int, tuple[int, int]] = {}

    # [DOC: telemetry-privacy]
    def admit(self, user_id: int) -> None:
        minute = int(time.time() // MINUTE)
        at, count = self.counts.get(user_id, (minute, 0))
        count = count + 1 if at == minute else 1
        if len(self.counts) > 10_000:
            self.counts = {k: v for k, v in self.counts.items() if v[0] == minute}
        self.counts[user_id] = (minute, count)
        if count > RATE:
            raise HTTPException(429, 'Too many reports')

    def write(self, batch: Batch) -> None:
        now, head = time.time(), (batch.install, batch.session, batch.build)
        rows = [(now, *head, e.t, e.kind, json.dumps(e.data, separators=JSON)) for e in batch.events]
        self.db.executemany('insert into events values (?, ?, ?, ?, ?, ?, ?)', rows)

    def sweep(self) -> None:
        self.db.execute('delete from events where at < ?', (time.time() - KEEP,))


def mount(api: FastAPI, telemetry: Telemetry) -> None:
    @api.post('/api/telemetry', status_code=204)
    async def report(request: Request):
        body = await request.body()
        if len(body) > BODY:
            raise HTTPException(413, 'Report too large')
        try:
            batch = Batch.model_validate_json(body)
        except ValidationError as error:
            raise HTTPException(422, 'Bad report') from error
        telemetry.admit(auth.user_of(batch.auth))
        telemetry.write(batch)
        return Response(status_code=204)
