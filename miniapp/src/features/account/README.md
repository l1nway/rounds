# account

The browser version's sign-in: a round button fixed at the top-left (`account.jsx`, `account.css`), the session and the Telegram login steps (`session.js`). Only `src/web.jsx` and `features/web/` import it, so none of it reaches the Mini App bundle (`miniapp/README.md`, Launch router). `account.css` goes in through `?inline` and a `<style>` from `web.jsx` (`miniapp/README.md`, Inline CSS).

## Account widget

Signed out: a Telegram-blue round button. A click opens a small panel under it with the sign-in in an `<iframe>` (no redirect of the page, the owner's request 2026-10-28); the button then toggles it. Signed in: the button shows the user's picture (`user.photo`, the `picture` claim of the id token, a direct Telegram URL; `referrerPolicy='no-referrer'`; a failed image falls back to the first letter of the name) and opens a small menu with the name, the tier line ("Free version" / "Full version") and Sign out. Escape closes either panel. Offline: the sign-in button is disabled in the shared disabled style (the OIDC page needs the network); the menu works.

The tier comes with the login reply (`user.tier`, `backend/rounds/README.md`, Telegram login) and is kept in the session. A session stored before 2026-10-28 has no tier and reads as `free`: an allowed user signs in once more to get `pro`.

## Frame login

`begin()` makes the PKCE verifier and `state` and keeps them **in memory** (a module variable), then returns the `GET /api/auth/start` URL the iframe loads; the API redirects it to `oauth.telegram.org/auth`. Telegram sends the iframe back to the page's own URL with `?code&state` (the same URL as the BotFather Allowed URL, `REDIRECT`). That load runs `web.jsx` inside the frame: `FRAMED && RETURNED` makes it only `postMessage` its `location.search` to the parent (target origin = our origin) and render nothing. The parent accepts the message only from the iframe's own window and our origin (`heard`), checks `state` against its memory, and posts `{code, verifier, redirect}` to `/api/auth`. The code never leaves the page, and no storage is needed between the two documents (the first version kept the pair in `sessionStorage`).

- Without `VITE_API_URL` (a local `npm run dev`) `begin()` refuses and the panel shows "Could not open Telegram": a relative `/api/auth/start` hit Vite's SPA fallback, and the iframe showed a squeezed copy of the page itself (owner, 2026-10-28, Firefox). A real sign-in from `localhost` also needs `http://localhost:5173/` in the BotFather Allowed URLs and in the API's CORS origin (`backend/rounds/api.py`, only the `MINIAPP_URL` origin); neither is set up.
- A reload of the page in the middle of a sign-in drops the pair: the frame's answer is then "This sign-in expired".
- `redirect` is `location.origin + location.pathname` and must equal a BotFather Allowed URL byte for byte (`https://l1nway.github.io/rounds/`).
- **Not verified:** that `oauth.telegram.org` allows being framed. Its answer to a bad request carried no `X-Frame-Options` and no CSP (2026-10-28), but the real login page was not fetched (that needs the bot's client id) and the Telegram docs say nothing about framing for the OIDC flow. If it refuses (`frame-ancestors`), the panel stays blank and the sign-in must go back to a full-page redirect (the previous `start` / `finish` pair is in git history, `features/auth/login.jsx` before this change). Also unchecked: whether the page opens `tg://` links or popups from inside a frame.

## Auth header

`session.js` registers `authorize(() => 'web ' + token)` with `services/api.js` at import, so every API call of the browser version is signed (`src/services/README.md`, Auth header). The session `{token, user}` is kept in `localStorage` (`rounds-session`): the GitHub Pages origin `l1nway.github.io` is shared by all of the owner's project pages, so the key carries the `rounds-` prefix. Not a cookie: the API is another site (`backend/rounds/README.md`, Web session). A 401 from a later call (expired or revoked) does not clear the session yet.
