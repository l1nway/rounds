import os

OUT_SIZE = 640
FPS = 30
MAX_DURATION = 60
DATA_DIR = '/data'
JOBS_DIR = f'{DATA_DIR}/jobs'


def env(name: str, default: str = '') -> str:
    return os.environ.get(name, default).strip()


def allowed_users() -> set[int]:
    return {int(x) for x in env('ALLOWED_USER_IDS').replace(' ', '').split(',') if x}
