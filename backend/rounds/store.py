import asyncio
import json
import sqlite3
from types import SimpleNamespace


# [DOC: free-store]
class Store:
    def __init__(self, path: str, table: str):
        self.db, self.table = sqlite3.connect(path, check_same_thread=False, isolation_level=None), table
        self.db.execute('pragma journal_mode=wal')
        self.db.execute(f'create table if not exists {table} (key text primary key, value text not null)')
        for name in ('get', 'put', 'pop', 'items'):
            setattr(self, name, SimpleNamespace(aio=getattr(self, f'_{name}')))

    def _row(self, key: str):
        return self.db.execute(f'select value from {self.table} where key = ?', (key,)).fetchone()

    async def _get(self, key: str, default=None):
        row = self._row(key)
        return json.loads(row[0]) if row else default

    async def _put(self, key: str, value, skip_if_exists: bool = False) -> bool:
        verb = 'insert or ignore' if skip_if_exists else 'insert or replace'
        cur = self.db.execute(f'{verb} into {self.table} values (?, ?)', (key, json.dumps(value)))
        return cur.rowcount > 0

    async def _pop(self, key: str, *default):
        row = self._row(key)
        if not row:
            if default:
                return default[0]
            raise KeyError(key)
        self.db.execute(f'delete from {self.table} where key = ?', (key,))
        return json.loads(row[0])

    async def _items(self):
        for key, value in self.db.execute(f'select key, value from {self.table}').fetchall():
            yield key, json.loads(value)


# [DOC: free-store]
class Disk:
    def __init__(self):
        self.commit = self.reload = SimpleNamespace(aio=lambda: asyncio.sleep(0))
