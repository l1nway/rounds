import {createRoot} from 'react-dom/client'
import account from './features/account/account.css?inline'
import {FRAMED, RETURNED, relay} from './features/account/session.js'
import web from './features/web/web.css?inline'
import WebApp from './features/web/web-app.jsx'
import {reloadOnStaleChunk} from './services/stale.js'
import {enter} from './services/telegram.js'

reloadOnStaleChunk()

// [DOC: no-seo]
const TITLE = 'Round maker: turn any video into a Telegram round'
const DESCRIPTION = 'Make a Telegram video note from any video in your browser: pick the object, trim, and the round is encoded on your device. Sign in with Telegram to send it to your chat.'

// [DOC: inline-css]
if (import.meta.env.DEV) await import('./index.css')

// [DOC: frame-login]
if (FRAMED && RETURNED) relay()
else {
  document.title = TITLE
  document.head.append(Object.assign(document.createElement('meta'), {name: 'description', content: DESCRIPTION}))
  document.head.append(Object.assign(document.createElement('style'), {textContent: account + web}))
  enter()
  createRoot(document.getElementById('root')).render(<WebApp/>)
}
