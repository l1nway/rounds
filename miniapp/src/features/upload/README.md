# upload

The browser version's upload (`upload.jsx`, `upload.css`), shown by `auth/login.jsx` once the user is signed in. Like `login.css`, `upload.css` goes in through `?inline` from `web.jsx` (`miniapp/README.md`, Inline CSS), so none of it reaches the Mini App bundle.

## Browser upload

Server side and the three requests: `backend/rounds/README.md`, Browser upload. The calls are in `services/api.js` (`startUpload`, `sendParts`).

- Drop a file on the zone or pick one. Anything that is not `video/*` or is over 2000 MB is refused before any request.
- Parts go in 3 parallel lanes, each part tried 3 times. Progress counts finished parts, so a file under one part (50 MB) jumps from 0 to 100 %.
- A failure (offline, a 401 after the session expired, a server error) keeps the job and the set of finished parts. Continue sends only the missing ones; picking another file starts over.
- Offline: the picker and Continue are disabled in the shared disabled style, and the status line says so. A drop while offline is ignored.
- After the last part the bot builds the preview and sends the editor button to the user's Telegram chat; the page says so. The editor in the browser and the render on the device come later.
- Not checked in a browser yet (2026-10-27): the build and lint pass; the server side passed an end-to-end test.
