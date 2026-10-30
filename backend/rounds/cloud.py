from pathlib import Path

import modal

from .config import DCE_WEIGHTS, DEEP_FILTER, DSTNET_WEIGHTS, DVD_WEIGHTS, RIFE_WEIGHTS

PROJECT = Path(__file__).parent.parent
FFMPEG = (
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/'
    'ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-9.0.tar.xz',
    '68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269',
)
RIFE = (
    'https://github.com/HolyWu/vs-rife/releases/download/model/flownet_v4.25.pkl',
    '6615790efd627772917205db291f51cd392528a157ecbb2ecaeec3bff8eb6de2',
)
# [DOC: denoise]
VOICE = (
    'https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl',
    '70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da',
)
# [DOC: repair-weights]
REPAIR = (
    (DVD_WEIGHTS, 'https://raw.githubusercontent.com/m-tassano/fastdvdnet/c8fdf6182a0340e89dd18f5df25b47337cbede6f/'
     'model.pth', '9d9d8413c33e3d9d961d07c530237befa1197610b9d60602ff42fd77975d2a17'),
    (DCE_WEIGHTS, 'https://raw.githubusercontent.com/Li-Chongyi/Zero-DCE_extension/'
     '09f202b690f82da939b8e6ec8535960ae97ad8bd/Zero-DCE%2B%2B/snapshots_Zero_DCE%2B%2B/Epoch99.pth',
     'ca8855b90df9a80fa4195a831f33d3476b1964f787eb70602797c773067f3b84'),
)  # fmt: skip
# [DOC: dstnet]
DEBLUR = (
    'https://huggingface.co/Meloo/DSTNetPlus/resolve/main/pretrained_models/DSTNetPlus_L_gopro.pth',
    '28beafbae0c2f6353d97c560d15d102b844785bab8cb16b3fb0a6f833f430f42',
)
MODELS_DIR = '/models'


def fetch(path: str, url: str, sha: str) -> tuple[str, str]:
    return f'curl -fsSL --create-dirs -o {path} {url}', f'echo "{sha}  {path}" | sha256sum -c'


def image(*groups: str, commands: tuple[str, ...] = (), base: modal.Image | None = None) -> modal.Image:
    return (
        (base or modal.Image.debian_slim(python_version='3.12'))
        .apt_install('curl', 'xz-utils', 'git')
        .run_commands(
            f'curl -fsSL -o /tmp/ffmpeg.tar.xz {FFMPEG[0]}',
            f'echo "{FFMPEG[1]}  /tmp/ffmpeg.tar.xz" | sha256sum -c',
            'tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 --wildcards "*/bin/ff*"',
            'rm /tmp/ffmpeg.tar.xz && ffmpeg -hide_banner -version | head -1',
            *commands,
        )
        .uv_sync(str(PROJECT), groups=list(groups), extra_options='--no-dev')
        .env({'HF_HOME': f'{MODELS_DIR}/hf'})
        .add_local_python_source('rounds')
    )


app = modal.App('rounds')
# [DOC: rife-weights]
weights = tuple(c for f in ((RIFE_WEIGHTS, *RIFE), *REPAIR, (DSTNET_WEIGHTS, *DEBLUR)) for c in fetch(*f))
voice = (*fetch(DEEP_FILTER, *VOICE), f'chmod +x {DEEP_FILTER} && {DEEP_FILTER} --version')
cpu_image, gpu_image = image(commands=voice), image('gpu', commands=(*weights, *voice))  # [DOC: cpu-image]
data = modal.Volume.from_name('rounds-data', create_if_missing=True)
models = modal.Volume.from_name('rounds-models', create_if_missing=True)
jobs = modal.Dict.from_name('rounds-jobs', create_if_missing=True)
state = modal.Dict.from_name('rounds-state', create_if_missing=True)
secrets = [modal.Secret.from_name('rounds')]
