# l1nway rounds bot

@~/projects/claude-rules/python.md
@~/projects/claude-rules/media.md
@~/projects/claude-rules/react.md
@~/projects/claude-rules/web.md
@~/projects/claude-rules/web-platforms.md
@~/projects/claude-rules/css.md
@~/projects/claude-rules/arch-features.md
@~/projects/claude-rules/perf.md
@~/projects/claude-rules/perf-web.md

## Project

A personal (non-commercial) Telegram bot that turns any source video (4K, 1080p, vertical or horizontal, up to 2 GB) into a Telegram video note ("round") of the highest quality Telegram accepts as is. The owner sends a file, picks the object to follow, the trim range and the options in a Mini App; a GPU job tracks the object, solves a smooth virtual camera path that keeps it inside the circle, and renders the note with FFmpeg.

Everything runs for free: the full version on Modal (Starter credits, scales to zero, cold starts are fine), the free tier for everyone else on an Oracle Cloud Always Free VM (CPU only), a Cloudflare Worker in front of both, the Mini App on GitHub Pages. No Local Bot API Server: files up to 2 GB move over MTProto with the bot token.

## Map

One repo, four parts:

- `backend/`: Python 3.12, a uv project, one Modal app (`rounds`). The package `backend/rounds/` holds the webhook bot (aiogram), the Mini App API (FastAPI, Telegram `initData` auth), MTProto file transfer (Telethon), the media pipeline (ffprobe / ffmpeg), tracking (SAM 2.1 via HF transformers), tap-to-lift outlines (SAM 2.1 image model in the GPU class `Lift`), the camera path solver (HiGHS through SciPy) and 60 fps frame interpolation (RIFE 4.25, vendored). Job state lives in a `modal.Dict`, files in a `modal.Volume`. The layout and its reasons are in `backend/rounds/README.md`.
- `miniapp/`: Preact (the React API through `preact/compat`, imported as `react`) + Vite SPA, `arch-features.md`, plain CSS. Opened from the bot's `web_app` button; shows the proxy video with a trim timeline (long press refines the step), point / box selection of the object on any frame with the tapped object's outline lifted from the frame (tap-to-lift), and the options. Deployed to GitHub Pages by `.github/workflows/pages.yml`.
- `router/`: the Cloudflare Worker, the webhook target and the API URL; it verifies the caller and sends `ALLOWED_USER_IDS` to Modal, everyone else to Oracle (`router/README.md`).
- `deploy/`: the Oracle VM setup (Caddy, systemd, FFmpeg arm64, DeepFilterNet3) for `rounds.free`, the free tier server (`deploy/README.md`).

Open bugs and questions that nobody is working on right now are in `BUGS.md` at the root. Add one there when a finding is parked, and remove it when it is closed.

Flow: video sent to the bot → webhook → `ingest` (CPU: MTProto download to the Volume, ffprobe, proxy video + filmstrip for the Mini App) → the bot sends the Mini App button → the owner submits trim + prompt + options → `render` (GPU: track → camera path → render) → `sendVideoNote`.

## Telegram limits (verified, see `backend/rounds/README.md` for sources)

- Video note: square MP4, `length` ≤ 640 (TDLib rejects more with 400), "up to 1 minute". H.264, HEVC, AV1 and VP9 stay rounds and play on iOS (owner's tests); H.266 does not (no VVC decoder in Telegram iOS or Desktop, `backend/rounds/README.md`, Codecs). No re-encoding by the Bot API or TDLib: what we upload is what people see. Size, not codec, decides round or regular video: 13.2 MB and AV1 / VP9 notes of about 11.6 MB arrived as regular videos, the same codecs under 10 MB as rounds; the encoder fills and never exceeds 10 000 000 B (`backend/rounds/README.md`, Note size).
- Cloud Bot API: download 20 MB, upload 50 MB. MTProto (bots included): up to 2000 MB.
- Mini App data goes back through our API with `initData` validated by HMAC; `sendData` is not used (keyboard-button launches only).

## Owner decisions

- Free hosting only (Modal Starter, Oracle Always Free, Cloudflare Workers free, GitHub Pages).
- What "pro" means (2026-10-30): a convention, not a paid tier. It marks options we cannot run for everyone right now, mostly because Modal credits are limited. Whatever runs on Oracle or on the user's device (WebGPU, or the device CPU) is offered to everyone; only what needs Modal is pro, and where Modal is not available to the user (free tier) such an option is closed with a badge (`backend/rounds/README.md`, Tiers; `miniapp/src/features/editor/README.md`, Tiers).
- Routing priority (2026-10-30), for every stage that can run in several places: (1) WebGPU on the device, the main power; (2) Oracle CPU, auxiliary; (3) the device CPU, auxiliary; (4) Modal, the lowest. Modal is used only when the stage cannot run locally or on Oracle, or when it is clearly faster, about 2–3x counting its cold start: a difference of about a minute does not justify Modal, 3–5 minutes or more does (`miniapp/src/features/local/README.md`, Local plan). Stabilization fill at the frame edge follows it: the cheap fill (`fill.py`) runs locally or on Oracle, ProPainter (the "elite" fill) only when Modal is available (`backend/rounds/README.md`, Edge fill).
- Zero-DCE++ (2026-10-30): CC BY-NC 4.0 with an "academic research only" statement, and licences are followed strictly, so its weights are never shipped to the browser. The AI part of the HDR slider stays on the server (the honest part and exposure run locally); the Zero-DCE++ curve also runs on Oracle on the CPU, in several processes; FastDVDnet stays Modal-only (`backend/rounds/README.md`, Repair).
- `opencv-python-headless` is approved for the Oracle VM (2026-10-30); it moves from the `gpu` group to the main dependencies when the code needs it.
- Public bot (2026-10-27): `ALLOWED_USER_IDS` get the full version on Modal; everyone else the free tier on Oracle with no limits for now (centre or selection-centred crop, zoom by box, loudness, DeepFilterNet3, metadata, codec, HDR and exposure without the FastDVDnet denoise). Modal must stay unreachable for anyone else even with forged URLs: proxy auth plus the router's own HMAC check plus Modal's own `ALLOWED_USER_IDS` check (`backend/rounds/README.md`, Tiers). A free CPU tracker comes later (candidates listed there).
- Output 640×640, the ceiling: 720 and 1080 notes (H.264 and HEVC, under the size cap) arrive as regular videos (owner's tests, 2026-10-26); do not retry without a Telegram change (`backend/rounds/README.md`, High resolution). The duration ceiling is settled by the Telegram experiment (`backend/rounds/README.md`, Telegram experiment).
- Object at the frame edge: honest pixels first, an unnoticeable fill where the circle leaves the frame; an AI outpainting model may come later.
- Frame rate: the note keeps the source rate up to 60. "Smooth to 60 fps" (RIFE interpolation, off by default) is offered for anything below 60 (59.94 included), with dropped frames or with frozen duplicate frames, and always targets 60. It must never fail on broken phone files (`backend/rounds/README.md`, Broken sources, Output rate).
- Codec: AV1 by default, HEVC and VP9 to pick in the Mini App; H.264 dropped (old format) and H.266 dropped (nothing plays it), owner 2026-10-26. Every note spends its size budget in two passes (`backend/rounds/README.md`, Codecs, Note size).
- Zoom on the object is an option, off by default: without it the note is only the square crop that follows the object (`backend/rounds/README.md`, Zoom option). A square source needs no selection unless zoom is on (Square source).
- Loudness levelling is an option, off by default: quiet parts louder, loud parts softer, the note at Apple's −16 LKFS, true peak −1 dBFS (`backend/rounds/README.md`, Loudness). Noise reduction is one slider, off by default: DeepFilterNet3 of growing strength (afftdn rejected by ear: "in a can") (`deep-filter` binary in the GPU image; it removes music too) (`backend/rounds/README.md`, Denoise). Leave room for more audio filters and for video stabilization (shaky handheld sources) as later options.
- Tap-to-lift (2026-10-26): the owner accepts about $8 a month of the Starter credits for the warm GPU `Lift` class, as long as it looks iOS-grade; the look was approved on the iPhone (`miniapp/src/features/viewer/README.md`, Lift look).
- HDR look (2026-10-26): one slider, off by default; its first part recovers only what the source holds (local tone mapping, clipped-channel rebuild; HDR sources use their real headroom), the rest adds AI repair for old dark noisy videos (FastDVDnet denoise + Zero-DCE++ low-light curve, approved new GPU weights). Plus a smart exposure slider (highlights compressed, never clipped). Nothing generative that invents content. Preview is hybrid: the honest part and exposure live in WebGL on the phone, the AI part as an exact frame from the warm `Lift` GPU (`backend/rounds/README.md`, Look).
- Optional note metadata (date, location, camera) is a switch, off by default; when on, the note's camera name also says "Round from Telegram" (`backend/rounds/README.md`, Note metadata).
- UI copy (bot messages and Mini App) is English.
- The Mini App targets Telegram for iOS 18+ and Telegram Desktop on Windows (WebView2); the browser version targets current Safari, Chrome, Edge (Android included) and Firefox: no legacy support (`miniapp/README.md`, Build target).
- Browser version (2026-10-27): the same URL as the Mini App, `https://l1nway.github.io/rounds/`; a Mini App launch loads no browser code beyond the launch router and the browser never loads `telegram-web-app.js` (`miniapp/README.md`, Launch router). Sign-in with Telegram (OIDC) identifies the user; the tier follows `ALLOWED_USER_IDS`, which are also the future admins (admin panel postponed). Upload by drag and drop; the result is the round in the bot's chat or a download of the finished round only. Local render on the device is automatic wherever the browser encodes the picked codec, in hardware or software (2026-10-29; AV1 stays the default, no automatic switch to HEVC), and only for notes that surely fit under the size cap in one pass: WebCodecs has no two-pass mode, and a second encode costs too much time; the rest renders on the server, whichever of the device and Oracle is faster. Mediabunny is approved for it (2026-10-27). When Telegram refuses the round because the user restricts voice and video messages, a Retry button appears and the round is kept for a short while to retry after the user allows the bot.
- Overrides react.md (Target React 19.2+): the Mini App runs on Preact 10 through `preact/compat` for a 5× smaller bundle (`miniapp/README.md`, Preact). `useEffectEvent` does not exist there: a handler read by an effect is a ref updated in a layout effect.

## Commands

- Backend (from `backend/`): `uv sync`; `uv run ruff check`; `uv run modal serve -m rounds.app` (dev); `uv run modal deploy -m rounds.app` (on Windows with `PYTHONIOENCODING=utf-8`, else the Modal CLI crashes printing ✓: `'charmap' codec can't encode`); secrets: `uv run --with python-dotenv modal secret create rounds --from-dotenv ../.env --force` (the Modal CLI needs `python-dotenv` for `--from-dotenv`; `--with` keeps it out of the project); webhook after a deploy: `uv run modal run -m rounds.app::setup` (points Telegram at `ROUTER_URL`, the Worker; Modal's `web` has proxy auth, so Telegram cannot reach it directly).
- Free tier on Oracle: `deploy/setup.sh <host>` once, then `git pull`, `uv sync --project backend --no-dev`, `sudo systemctl restart rounds-free` (`deploy/README.md`). Router: paste `router/worker.js` in the Cloudflare dashboard (`router/README.md`).
- Mini App (from `miniapp/`): `npm install`; `npm run lint`; `npm run build`; `npm run perf` (mock build). Local testing needs the gitignored `miniapp/dev/` folder (owner's PC only; mock API, Telegram shim, Dev panel to load a video from disk): `npm run mock` (test video, needs ffmpeg) then `npm run dev` without `VITE_API_URL`, scenarios via `?job=` (`miniapp/dev/README.md`). No mock code goes into `src/` (`miniapp/README.md`, Dev plugin).

## Env

`.env` at the root (never committed), pushed to the Modal secret `rounds`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_USER_IDS`, `MINIAPP_URL`, `HF_TOKEN` (optional, gated SAM 3 checkpoints), `TELEGRAM_CLIENT_SECRET` (BotFather → Bot Settings → Login Widget, the OIDC client secret of the browser sign-in; the client id is the bot id, taken from the token). `ROUTER_URL`: the Worker's URL, the webhook target. The Mini App gets the public API URL at build time (`VITE_API_URL`, a GitHub Actions variable, not a secret): the Worker's URL too. The Oracle VM reads a copy of the same `.env`; the Worker has its own variables (`router/README.md`, Router secrets).
