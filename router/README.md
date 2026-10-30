# router

A Cloudflare Worker (`worker.js`, no dependencies, no build) in front of both backends. It is the Telegram webhook target and the Mini App's `VITE_API_URL`. Deployed by hand from the Cloudflare dashboard (paste `worker.js`), so there is no `wrangler.toml`.

## Router

Routing by who the caller is, never by anything the caller says about the target:

- `POST /telegram/webhook`: the `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` (403 otherwise). `message.from.id` or `callback_query.from.id` (the only `allowed_updates`, `bot.UPDATES`) in `ALLOWED_USER_IDS` goes to Modal, everyone else to Oracle.
- `GET /api/jobs/:id/:name` (signed proxy / filmstrip URLs): routed by which key signed it (Router files).
- Every other `/api/*`: the `Authorization` header is verified here (Router auth). A valid allowed user goes to Modal; anyone else, including an invalid or missing header and CORS preflights, goes to Oracle, which answers 401 / 403 itself. `/api/auth/*` (the OIDC sign-in, no header yet) therefore always runs on Oracle: the session it issues is valid on both, since both derive the key from the same bot token.
- `?via=oracle` on any other `/api/*` request sends an allowed user's request to Oracle instead of Modal (owner, 2026-10-28: Oracle first for what it can do). A hint can only lower the target, never raise it, so it needs no check: a non-allowed caller goes to Oracle anyway. The browser adds it to every request of a job it created on Oracle (`miniapp/src/features/local/README.md`, Local modal); a job lives on one backend, so all its requests carry it. Oracle must list the user in its own `ALLOWED_USER_IDS` while `config.PUBLIC` is false, or it answers 403.
- Anything else: 404.
- When Modal does not answer, an allowed user's request goes to Oracle (Modal fallback).

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

## Modal fallback

Owner 2026-10-29: if Modal is out of credits or does not answer, allowed users must not be blocked; they get Oracle (the free tier) automatically. `toPro` runs every request the Router section sends to Modal (allowed users without `?via=oracle`, the webhook of an allowed user, `Files.pro` signed URLs).

**Modal failed** (`tryModal`) when: `fetch` throws (network, DNS, TLS), no response headers within `WAIT` (45 s), or the answer is 400 or more **without** `x-rounds-origin` (the mark our `web` app puts on every response, `backend/rounds/README.md`, Modal fallback). An unmarked answer is Modal's platform speaking (proxy auth, a stopped app, a spend limit, 429, a crash before our code); a marked 4xx / 5xx is our own error and passes unchanged, so a real bug is never hidden behind Oracle. Modal's out-of-credit answer is not documented anywhere (backend README, Modal fallback), hence the mark instead of a status list; the Worker logs `modal refused <status> <body>` and `modal failed <error>` for each failure (Workers → Logs), read them on the first real outage and note the answer here.

**Memo**: after a failure `downUntil` = now + `DOWN_FOR` (3 min) in the isolate's global scope; meanwhile allowed users skip Modal entirely, so a hanging Modal costs one `WAIT`, not one per request. Cloudflare reuses an isolate across requests and a global keeps its value between them (developers.cloudflare.com/workers/best-practices/workers-best-practices/), but isolates are per location and get evicted, so it is a best-effort memo: a fresh isolate pays one detection. A plain number is safe in global scope (the warning there is about I/O objects and request data). Rejected: the Cache API (a lookup per request for a few seconds saved per isolate) and KV (eventually consistent, and a new binding to set up by hand). The first request after the 3 min is the probe: Modal back means normal routing again.

**Timeouts**: the timer is cleared as soon as response headers arrive, so it never cuts a long download (a proxy video) or a streamed response. `WAIT` 45 s covers a `web` cold start, the 2 GB join of `/uploaded` and the note upload to Telegram. GPU routes (`/segment`, `/track`, `/look`: a cold `Lift` plus a 120 s method timeout) get no timer: Modal's own 150 s limit answers them with a 303 (modal.com/docs/guide/webhook-timeouts), which passes through unmarked as before. Streamed requests (below) get no timer either, because the client's upload time counts before the headers.

**Replaying the body**: a request body is a stream and can be read once; `clone()` tees it (Fetch spec, "clone a body"), which keeps the unread branch in memory anyway. So `buffered` reads bodies with a `Content-Length` up to `BUFFER` (16 MB, the 128 MB isolate limit, developers.cloudflare.com/workers/platform/limits/) into an `ArrayBuffer` that both attempts reuse: JSON calls, masks, client notes (`encode.NOTE_BYTES`, 10 MB). The webhook is text already. Bigger bodies, or bodies without `Content-Length`, are streamed to Modal once and cannot fall back: the 50 MB parts of a browser upload (`PUT /api/jobs/:id/parts/:k`).

**Where the retry goes**:

| Request | Modal failed | Notes |
|---|---|---|
| webhook (allowed user) | the same update to Oracle | the bot answers with the free tier (`TEXTS['fallback']`); the update is deduped per backend (backend README, Webhook dedupe) |
| `/api/*` without a job (`POST /api/uploads`, `POST /api/notes`) | Oracle | the answer carries `X-Rounds-Via: oracle` |
| `/api/jobs/:id…` (buffered) | Oracle; its 404 means the job lives on Modal → 503 `pro_unavailable` | Oracle owns the job if it was made during a fallback |
| `/api/jobs/:id…` with Modal up and answering a marked 404 | Oracle; 200 → its answer with `X-Rounds-Via: oracle`; 404 → the 404 | a job made on Oracle during a fallback and opened later from the bot's editor button, which carries no `via` |
| streamed body (upload part) | 503 `pro_unavailable`, Oracle untouched | the client restarts on Oracle (contract below) |
| `Files.pro` signed URL | 503 `pro_unavailable` | Oracle cannot have a pro file |

**Contract for the clients** (`miniapp/src/features/local/server.js`):

- `X-Rounds-Via: oracle` on an answer means Oracle served it as a fallback. On `POST /api/uploads` (and a job read) the job lives on Oracle: add `?via=oracle` to every later request of that job (parts, `uploaded`, `GET`, `render`), as for a job created on Oracle on purpose. The header is listed in `Access-Control-Expose-Headers`.
- `503` with `{"code": "pro_unavailable", "detail": "The full version is unavailable right now, try again in a few minutes"}`, headers `Retry-After: 180`, `X-Rounds-Via: none` and CORS (`Access-Control-Allow-Origin` echoes the request's `Origin`; the body is a fixed text, nothing private): the full version cannot serve this request now and the router could not move it. For an upload or a job on Modal, the client may start again on Oracle with `?via=oracle` when the render options are free-tier ones, or show `detail`.
- Requests should carry `Content-Length` (browsers set it for string, Blob and ArrayBuffer bodies); without it a body counts as streamed.

**Security**: unchanged. Only callers the Worker verified as allowed reach `toPro`; the fallback calls `forward(..., pro=false)`, which deletes `Modal-Key` / `Modal-Secret`, so the proxy token never leaves for Oracle; Oracle checks initData, the session and the webhook secret itself and serves the free tier only. A non-allowed caller can neither trigger the Modal attempt nor see the memo.

**Webhook double processing**: Telegram resends an update when the webhook does not answer 2xx. The Worker returns Oracle's answer after a fallback (2xx), so Telegram does not resend; only an Oracle failure too ends in a 503 and a resend, which the backend dedupe absorbs on each backend. The one remaining double: Modal processes an update after the Worker gave up on it (>45 s) and Oracle processes it as well (backend README, Webhook dedupe).

Checked in Node 24 (2026-10-29, scratch test with a mocked `fetch`, `WAIT` and `DOWN_FOR` shortened): success passes with the mark stripped; a marked 500 passes without fallback; an unmarked 503 and 402 go to Oracle with the same body and no proxy key; the memo skips Modal and expires; a timeout and a connection error go to Oracle; a GPU route waits past `WAIT`; a Modal job while Modal is down → 503 `pro_unavailable` with CORS; an Oracle job without `via` → Modal 404 → Oracle 200; a job on neither → 404; a streamed part → 503 and Oracle untouched, at once while the memo is set; the webhook of an allowed user falls back, of another user goes to Oracle only; a pro file → 503, a free file → Oracle; `?via=oracle` and other users never touch Modal; Modal's 303 passes. Not checked on Cloudflare: `AbortController` with a reason, `Response.json`, the global memo across real isolates, and Modal's real out-of-credit answer.

## Limits

Free plan (developers.cloudflare.com/workers/platform/limits/, read 2026-10-27): 100 000 requests a day, 10 ms CPU per request (HMACs are well under it; waiting on `fetch` does not count), 100 MB request body. The last one is why browser uploads go in 50 MB parts (`backend/rounds/README.md`, Browser upload). Also (read 2026-10-29): 128 MB memory per isolate (why `BUFFER` is 16 MB), 50 subrequests per request (a fallback uses two), 6 connections waiting for headers at once, and no time limit on a subrequest while the client stays connected (so the 45 s `WAIT` is ours, not Cloudflare's).
