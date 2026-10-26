# l1nway rounds bot

@~/projects/claude-rules/python.md
@~/projects/claude-rules/react.md
@~/projects/claude-rules/web.md
@~/projects/claude-rules/web-platforms.md
@~/projects/claude-rules/css.md
@~/projects/claude-rules/arch-features.md
@~/projects/claude-rules/perf.md
@~/projects/claude-rules/perf-web.md

## Project

A personal (non-commercial) Telegram bot that turns any source video (4K, 1080p, vertical or horizontal, up to 2 GB) into a Telegram video note ("round") of the highest quality Telegram accepts as is. The owner sends a file, picks the object to follow, the trim range and the options in a Mini App; a GPU job tracks the object, solves a smooth virtual camera path that keeps it inside the circle, and renders the note with FFmpeg.

Everything runs for free: the backend on Modal (Starter credits, scales to zero, cold starts are fine), the Mini App on GitHub Pages. No VPS and no Local Bot API Server: files up to 2 GB move over MTProto with the bot token.

## Map

One repo, two parts:

- `backend/`: Python 3.12, a uv project, one Modal app (`rounds`). The package `backend/rounds/` holds the webhook bot (aiogram), the Mini App API (FastAPI, Telegram `initData` auth), MTProto file transfer (Telethon), the media pipeline (ffprobe / ffmpeg), tracking (SAM 2.1 via HF transformers), tap-to-lift outlines (SAM 2.1 image model in the GPU class `Lift`), the camera path solver (HiGHS through SciPy) and 60 fps frame interpolation (RIFE 4.25, vendored). Job state lives in a `modal.Dict`, files in a `modal.Volume`. The layout and its reasons are in `backend/rounds/README.md`.
- `miniapp/`: Preact (the React API through `preact/compat`, imported as `react`) + Vite SPA, `arch-features.md`, plain CSS. Opened from the bot's `web_app` button; shows the proxy video with a trim timeline (long press refines the step), point / box selection of the object on any frame with the tapped object's outline lifted from the frame (tap-to-lift), and the options. Deployed to GitHub Pages by `.github/workflows/pages.yml`.

Flow: video sent to the bot → webhook → `ingest` (CPU: MTProto download to the Volume, ffprobe, proxy video + filmstrip for the Mini App) → the bot sends the Mini App button → the owner submits trim + prompt + options → `render` (GPU: track → camera path → render) → `sendVideoNote`.

## Telegram limits (verified, see `backend/rounds/README.md` for sources)

- Video note: square H.264 MP4, `length` ≤ 640 (TDLib rejects more with 400), "up to 1 minute". No re-encoding by the Bot API or TDLib: what we upload is what people see. A file of 13.2 MB arrived as a regular video, so the encoder caps every note at 10 MB (`backend/rounds/README.md`, Note size).
- Cloud Bot API: download 20 MB, upload 50 MB. MTProto (bots included): up to 2000 MB.
- Mini App data goes back through our API with `initData` validated by HMAC; `sendData` is not used (keyboard-button launches only).

## Owner decisions

- Free hosting only (Modal Starter + GitHub Pages). Bot restricted to `ALLOWED_USER_IDS`.
- Output 640×640 by default. A 1080×1080 note (size not recorded) arrived as a regular video; since a 13.2 MB 640 note failed the same way, 720 / 1080 and HEVC are back as experimental switches under the 10 MB cap (2026-10-26) for the owner to test; a "smart" size pick may follow (`backend/rounds/README.md`, High resolution). The duration ceiling is settled by the Telegram experiment (`backend/rounds/README.md`, Telegram experiment).
- Object at the frame edge: honest pixels first, an unnoticeable fill where the circle leaves the frame; an AI outpainting model may come later.
- Frame rate: the note keeps the source rate up to 60. "Smooth to 60 fps" (RIFE interpolation, off by default) is offered for anything below 60 (59.94 included), with dropped frames or with frozen duplicate frames, and always targets 60. It must never fail on broken phone files (`backend/rounds/README.md`, Broken sources, Output rate).
- Loudness normalization is an option, off by default. Leave room for more audio filters and for video stabilization (shaky handheld sources) as later options.
- Tap-to-lift (2026-10-26): the owner accepts about $8 a month of the Starter credits for the warm GPU `Lift` class, as long as it looks iOS-grade; the look was approved on the iPhone (`miniapp/src/features/viewer/README.md`, Lift look).
- Optional note metadata (date, location, camera) is a switch, off by default; when on, the note's camera name also says "Round from Telegram" (`backend/rounds/README.md`, Note metadata).
- UI copy (bot messages and Mini App) is English.
- The Mini App targets only Telegram for iOS 18+ and Telegram Desktop on Windows (WebView2): no legacy support (`miniapp/README.md`, Build target).
- Overrides react.md (Target React 19.2+): the Mini App runs on Preact 10 through `preact/compat` for a 5× smaller bundle (`miniapp/README.md`, Preact). `useEffectEvent` does not exist there: a handler read by an effect is a ref updated in a layout effect.

## Commands

- Backend (from `backend/`): `uv sync`; `uv run ruff check`; `uv run modal serve -m rounds.app` (dev); `uv run modal deploy -m rounds.app`; secrets: `uv run --with python-dotenv modal secret create rounds --from-dotenv ../.env --force` (the Modal CLI needs `python-dotenv` for `--from-dotenv`; `--with` keeps it out of the project); webhook after a deploy: `uv run modal run -m rounds.app::setup` (it looks up the deployed `web`, so the URL is the permanent one even though `modal run` also starts a `-dev` copy).
- Mini App (from `miniapp/`): `npm install`; `npm run mock` (test video + filmstrip into `public/mock/`, needs ffmpeg) then `npm run dev` without `VITE_API_URL` (mock API, scenarios via `?job=ready|ingest|done|failed|rendering|missing|reject`); `npm run lint`; `npm run build`; `npm run perf`.

## Env

`.env` at the root (never committed), pushed to the Modal secret `rounds`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_USER_IDS`, `MINIAPP_URL`, `HF_TOKEN` (optional, gated SAM 3 checkpoints). The Mini App gets the public API URL at build time (`VITE_API_URL`, a GitHub Actions variable, not a secret).
