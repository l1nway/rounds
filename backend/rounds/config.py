import os

OUT_SIZE = 640
FPS = 30
MAX_FPS = 60
MAX_DURATION = 60
DATA_DIR = '/data'
JOBS_DIR = f'{DATA_DIR}/jobs'
RIFE_WEIGHTS = '/opt/rife/flownet_v4.25.pkl'
DVD_WEIGHTS, DCE_WEIGHTS = '/opt/repair/fastdvdnet.pth', '/opt/repair/zerodce.pth'
SEEDVR_CODE = '/opt/seedvr'
DEEP_FILTER = '/usr/local/bin/deep-filter'
SAM_MODEL = 'facebook/sam2.1-hiera-large'


def env(name: str, default: str = '') -> str:
    return os.environ.get(name, default).strip()


def allowed_users() -> set[int]:
    return {int(x) for x in env('ALLOWED_USER_IDS').replace(' ', '').split(',') if x}
