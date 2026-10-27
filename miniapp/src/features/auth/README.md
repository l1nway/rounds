# auth

The browser version's sign-in (`login.jsx`, `login.css`). Only `src/web.jsx` imports it, so none of it reaches the Mini App bundle (`miniapp/README.md`, Launch router; checked 2026-10-27 with a grep of `dist/assets`: its texts are only in `web-*.js`).

## Login

`<Login/>` is the whole browser page for now: the Telegram sign-in, then "Signed in as …" with Sign out. Upload replaces the signed-in placeholder in the next stage. The blocks use the shared entrance (`src/README.md`, Entrance; `web.jsx` calls `enter()` before the first render) with `--i` from their place in `.login`.

- `login.css` goes in through `?inline` and a `<style>` from `web.jsx`, not a CSS import: Vite links only the HTML entry's CSS (`miniapp/README.md`, Inline CSS).
- Offline: the button is disabled in the shared disabled style (opacity 0.4, as `.icon-button`) and the status line says so; nothing waits on a request that cannot finish.
- Checked 2026-10-27 in headless Edge (production build, 390 × 844, both colour schemes, Telegram and `/api/auth` answered by CDP): the start URL, PKCE challenge = SHA-256 of the verifier, the 403 "This bot is private", a wrong `state`, `?error=access_denied`, sign-in stored and kept over a reload, Sign out, no console errors. Not checked against the real Telegram (needs the deploy, `TELEGRAM_CLIENT_SECRET` and the BotFather Allowed URL).

## Telegram login

Client side of `backend/rounds/README.md`, Telegram login (OIDC, code with PKCE).

- `start` makes a 32-byte verifier and a 16-byte `state` (base64url; `btoa`, since `Uint8Array.toBase64` is newer than the build target), keeps both in `sessionStorage` (`rounds-login`) and navigates to `API/api/auth/start`, which redirects to Telegram.
- On return (`?code` or `?error` in the URL, read once at module load: `RETURNED`) `finish` takes the pending pair out of `sessionStorage`, cleans the URL with `history.replaceState` (a reload must not replay a used code), checks `state` and posts `{code, verifier, redirect}` to `/api/auth`.
- `redirect` is `location.origin + location.pathname` and must equal a BotFather Allowed URL byte for byte (`https://l1nway.github.io/rounds/`): opening `/rounds/index.html` would fail at Telegram.
- Back from Telegram through the back button the page may come from the bfcache with the button still busy: `pageshow` with `persisted` resets it.
- Blocked `sessionStorage` (strict privacy modes) loses the pending pair: the return then shows "This sign-in link has expired" instead of signing in.

## Auth header

The session (`{token, user}` from `/api/auth`) is kept in `localStorage` (`rounds-session`); `login.jsx` registers `authorize(() => 'web ' + token)` with `services/api.js` at import, so every later API call of the browser version is signed (`src/services/README.md`, Auth header). The GitHub Pages origin `l1nway.github.io` is shared by all of the owner's project pages, so the keys carry the `rounds-` prefix. Not a cookie: the API is another site (`backend/rounds/README.md`, Web session). A 401 from a later call (expired or revoked) does not clear it yet; the upload stage handles that.

## Login glow

The Telegram button's light band, ported from w2w's social tiles (`what-to-watch/apps/web/app/auth/socialSignIn.tsx`, `FLOW` / `TIMING` of `loginLogo.tsx`): a `::before` twice the button's size with a diagonal gradient, moved from `translate(0, 0)` to `(-50%, -50%)` over 6 s, `alternate`, `ease-in-out`, by WAAPI on the pseudo-element (one compositor-only transform, as the Sheen, `src/components/README.md`). w2w colours the band with the brand colours over a dark tile; here the button is `--button` and the band is `--button-text` at 35 %, so it follows the theme. Reduced motion: no animation, the band rests at the start.

## Login status

The error or offline line sits in `.login-status`, which reserves two lines (`min-height`) even when empty: the page is centred vertically, and a line that appears without a reserved slot moved the whole block up by half its height (seen in the first screenshot run, 2026-10-27). The text itself swaps with `Swap` (`src/README.md`, Swap). `.login .login-status p` outranks `.login p` (the hint colour), so the error stays `--danger`.
