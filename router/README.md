# router

A Cloudflare Worker (`worker.js`, no dependencies, no build) in front of both backends. It is the Telegram webhook target and the Mini App's `VITE_API_URL`. Deployed by hand from the Cloudflare dashboard (paste `worker.js`), so there is no `wrangler.toml`.

## Router

Routing by who the caller is, never by anything the caller says about the target:

- `POST /telegram/webhook`: the `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` (403 otherwise). `message.from.id` or `callback_query.from.id` (the only `allowed_updates`, `bot.UPDATES`) in `ALLOWED_USER_IDS` goes to Modal, everyone else to Oracle.
- `GET /api/jobs/:id/:name` (signed proxy / filmstrip URLs): routed by which key signed it (Router files).
- Every other `/api/*`: the `Authorization` header is verified here (Router auth). A valid allowed user goes to Modal; anyone else, including an invalid or missing header and CORS preflights, goes to Oracle, which answers 401 / 403 itself. `/api/auth/*` (the OIDC sign-in, no header yet) therefore always runs on Oracle: the session it issues is valid on both, since both derive the key from the same bot token.
- Anything else: 404.

The Worker sets `x-rounds-base` to its own origin, and the backends build signed URLs on it (`backend/rounds/README.md`, Signed urls), so `<video src>` also goes through the Worker. Client copies of `x-rounds-base`, `Modal-Key` and `Modal-Secret` are dropped. `redirect: 'manual'` passes the `/api/auth/start` redirect to the browser instead of following it.

Why the Worker checks the HMAC itself: Modal's web endpoint has `requires_proxy_auth=True` (`backend/rounds/README.md`, Tiers), so only a request carrying the proxy token reaches Modal, and the Worker attaches it only after it has proved the caller is allowed. A forged URL, a forged `?api=` or a copied job id from a non-allowed user never reaches Modal, and Modal still checks `ALLOWED_USER_IDS` itself on every call (defence in depth). Checked 2026-10-27 in Node against signatures made by the Python code (initData, web session, a tampered session, both file tiers, a file signature replayed on another job id, webhook routing for message and callback_query, a missing secret); not yet checked on Cloudflare itself.

## Router secrets

Worker variables (Settings → Variables and Secrets), all as secrets except the URLs:

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_USER_IDS`: the same values as the root `.env`.
- `MODAL_KEY`, `MODAL_SECRET`: a Modal proxy auth token (Modal dashboard → Settings → Proxy Auth Tokens).
- `MODAL_URL`: the deployed `web` URL (`https://l1nway--rounds-web.modal.run`); `ORACLE_URL`: `https://<oracle host>` (`deploy/README.md`).

Every secret is read with `.trim()`: a value pasted into the dashboard often carries a trailing newline, which breaks the HMAC or the header.

## Router auth

Ports of `backend/rounds/auth.py` (change both together): initData (key HMAC(`WebAppData`, token), sorted `key=value` lines without `hash`, `auth_date` within 24 h) and the web session `user.exp.mac` (key HMAC(`Session`, token)). Pairs are sorted by key only, like Python's `sorted(fields.items())` (keys are unique). Comparisons use `crypto.subtle.timingSafeEqual` (a Workers extension, not in browsers or Node) after a byte-length check, which it requires.

## Router files

A signed URL carries no user, so the Worker recomputes the signature with both labels (`Files.pro`, `Files.free`, `backend/rounds/README.md`, Signed urls) and sends it to the backend whose key matches; no match or an expired `exp` is a 403 without touching either backend. The two labels exist only so that the Worker can tell the tiers apart.

## Limits

Free plan (developers.cloudflare.com/workers/platform/limits/, read 2026-10-27): 100 000 requests a day, 10 ms CPU per request (HMACs are well under it; waiting on `fetch` does not count), 100 MB request body. The last one is why browser uploads go in 50 MB parts (`backend/rounds/README.md`, Browser upload).
