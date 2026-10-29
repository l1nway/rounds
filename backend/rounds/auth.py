import asyncio
import base64
import hashlib
import hmac
import json
import time
from urllib.error import URLError
from urllib.parse import parse_qsl, urlencode
from urllib.request import Request, urlopen

from fastapi import HTTPException

from . import config
from .config import env

OAUTH = 'https://oauth.telegram.org'
SCOPE = 'openid profile telegram:bot_access'
INIT_DATA_TTL, SESSION_TTL = 24 * 3600, 30 * 24 * 3600
TOKEN_TIMEOUT = 15
FAILED = 'Telegram did not confirm the sign-in, try again'


def secret(label: bytes) -> bytes:
    return hmac.new(label, env('TELEGRAM_BOT_TOKEN').encode(), hashlib.sha256).digest()


# [DOC: telegram-login]
def bot_id() -> str:
    return env('TELEGRAM_BOT_TOKEN').split(':')[0]


def allowed(user_id) -> int:
    if not config.admits(user_id):  # [DOC: tiers]
        raise HTTPException(403, 'This bot is private')
    return user_id


# [DOC: init-data]
def from_init_data(init_data: str) -> int:
    fields = dict(parse_qsl(init_data, keep_blank_values=True))
    check = '\n'.join(f'{k}={v}' for k, v in sorted(fields.items()) if k != 'hash')
    digest = hmac.new(secret(b'WebAppData'), check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(digest, fields.get('hash', '')):
        raise HTTPException(401, 'Open the editor from the bot')
    if time.time() - int(fields.get('auth_date', 0)) > INIT_DATA_TTL:
        raise HTTPException(401, 'The session expired, reopen the editor')
    return allowed(json.loads(fields.get('user', '{}')).get('id'))


# [DOC: web-session]
def mac(payload: str) -> str:
    return hmac.new(secret(b'Session'), payload.encode(), hashlib.sha256).hexdigest()


def session(user_id: int) -> str:
    payload = f'{user_id}.{int(time.time()) + SESSION_TTL}'
    return f'{payload}.{mac(payload)}'


def from_session(token: str) -> int:
    payload, _, sig = token.rpartition('.')
    user_id, _, exp = payload.partition('.')
    if not hmac.compare_digest(mac(payload), sig) or not exp.isdigit() or int(exp) < time.time():
        raise HTTPException(401, 'Sign in again')
    return allowed(int(user_id))


# [DOC: auth-header]
def user_of(authorization: str) -> int:
    kind, _, value = authorization.partition(' ')
    return from_session(value) if kind == 'web' else from_init_data(value)


# [DOC: telegram-login]
def login_url(redirect: str, challenge: str, state: str) -> str:
    query = {
        'response_type': 'code', 'client_id': bot_id(), 'scope': SCOPE, 'redirect_uri': redirect, 'state': state,
        'code_challenge': challenge, 'code_challenge_method': 'S256',
    }  # fmt: skip
    return f'{OAUTH}/auth?{urlencode(query)}'


def exchange(code: str, verifier: str, redirect: str) -> dict:
    form = {'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect, 'client_id': bot_id(),
            'code_verifier': verifier}  # fmt: skip
    basic = base64.b64encode(f'{bot_id()}:{env("TELEGRAM_CLIENT_SECRET")}'.encode()).decode()
    headers = {'Authorization': f'Basic {basic}', 'Content-Type': 'application/x-www-form-urlencoded'}
    try:
        with urlopen(Request(f'{OAUTH}/token', urlencode(form).encode(), headers), timeout=TOKEN_TIMEOUT) as answer:
            return json.load(answer)
    except (URLError, ValueError) as error:
        return {'error': repr(error)}


def claims(grant: dict) -> dict:
    token = grant.get('id_token')
    if not token:
        print('telegram login: no id_token, got', {k: v for k, v in grant.items() if k != 'access_token'}, flush=True)
        raise HTTPException(401, FAILED)
    part = token.split('.')[1]
    payload = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
    audience = [str(a) for a in (payload.get('aud') if isinstance(payload.get('aud'), list) else [payload.get('aud')])]
    if payload.get('iss') != OAUTH or bot_id() not in audience or payload.get('exp', 0) < time.time():
        raise HTTPException(401, FAILED)
    return payload


async def login(code: str, verifier: str, redirect: str) -> dict:
    user = claims(await asyncio.to_thread(exchange, code, verifier, redirect))
    user_id = allowed(int(user.get('id', 0)))
    name = user.get('name') or user.get('preferred_username')
    tier = 'pro' if user_id in config.allowed_users() else 'free'  # [DOC: tiers]
    profile = {'id': user_id, 'name': name, 'photo': user.get('picture'), 'tier': tier}
    return {'token': session(user_id), 'user': profile}
