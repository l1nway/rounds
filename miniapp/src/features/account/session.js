import {API, authorize, post} from '../../services/api.js'

const SESSION = 'rounds-session'
export const REDIRECT = location.origin + location.pathname
export const RETURNED = /[?&](code|error)=/.test(location.search)
const MESSAGE = 'rounds-login'
const WINDOW = 'rounds-telegram-login'
const SIZE = {width: 550, height: 650}
const TEXTS = {
  cancelled: 'Telegram did not sign you in. Try again.',
  stale: 'This sign-in expired. Try again.',
  blocked: 'Your browser blocked the Telegram window. Allow pop-ups for this site and try again.',
  failed: 'Could not open Telegram. Try again.',
  done: 'Signed in. You can close this window.'
}

const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const random = size => base64url(crypto.getRandomValues(new Uint8Array(size)))

export const session = () => {try {return JSON.parse(localStorage.getItem(SESSION))} catch {return null}}
export const save = next => {
  try {if (next) localStorage.setItem(SESSION, JSON.stringify(next)); else localStorage.removeItem(SESSION)} catch {/* storage blocked */}
}

export const tierOf = user => user ? user.tier ?? 'free' : 'local'

// [DOC: auth-header]
authorize(() => `web ${session()?.token}`)

// [DOC: popup-login]
let pending = null

const features = () => {
  const left = Math.max(0, (screen.width - SIZE.width) / 2) + (screen.availLeft | 0)
  const top = Math.max(0, (screen.height - SIZE.height) / 2) + (screen.availTop | 0)
  return `popup,width=${SIZE.width},height=${SIZE.height},left=${left},top=${top}`
}

const url = async () => {
  const verifier = random(32), state = random(16)
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  pending = {verifier, state}
  return `${API}/api/auth/start?${new URLSearchParams({redirect: REDIRECT, challenge, state})}`
}

export const begin = () => {
  if (!API) throw new Error(TEXTS.failed)
  const popup = open('about:blank', WINDOW, features())
  if (!popup) throw new Error(TEXTS.blocked)
  url().then(next => popup.location.replace(next), () => popup.close())
  return popup
}

export const relay = () => {
  const data = {type: MESSAGE, search: location.search}
  if (opener) opener.postMessage(data, location.origin)
  else new BroadcastChannel(MESSAGE).postMessage(data)
  document.body.textContent = TEXTS.done
  close()
}

export const listen = (popup, onSearch) => {
  const channel = new BroadcastChannel(MESSAGE)
  const hear = event => {
    if (event.data?.type !== MESSAGE) return
    if (event.target === window && (event.origin !== location.origin || event.source !== popup())) return
    onSearch(event.data.search)
  }
  addEventListener('message', hear)
  channel.onmessage = hear
  return () => {
    removeEventListener('message', hear)
    channel.close()
  }
}

export const complete = async search => {
  const params = new URLSearchParams(search), mine = pending
  pending = null
  if (params.has('error')) throw new Error(TEXTS.cancelled)
  if (!mine || mine.state !== params.get('state')) throw new Error(TEXTS.stale)
  return post('/api/auth', {code: params.get('code'), verifier: mine.verifier, redirect: REDIRECT})
}
