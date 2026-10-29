import {API, authorize, post} from '../../services/api.js'

const SESSION = 'rounds-session'
export const REDIRECT = location.origin + location.pathname
export const RETURNED = /[?&](code|error)=/.test(location.search)
export const FRAMED = window.parent !== window
const MESSAGE = 'rounds-login'
const TEXTS = {
  cancelled: 'Telegram did not sign you in. Try again.',
  stale: 'This sign-in expired. Try again.'
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

// [DOC: frame-login]
let pending = null

export const begin = async () => {
  if (!API) throw new Error('no api')
  const verifier = random(32), state = random(16)
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  pending = {verifier, state}
  return `${API}/api/auth/start?${new URLSearchParams({redirect: REDIRECT, challenge, state})}`
}

export const relay = () => parent.postMessage({type: MESSAGE, search: location.search}, location.origin)

export const heard = (event, frame) =>
  event.origin === location.origin && event.source === frame && event.data?.type === MESSAGE ? event.data.search : null

export const complete = async search => {
  const params = new URLSearchParams(search), mine = pending
  pending = null
  if (params.has('error')) throw new Error(TEXTS.cancelled)
  if (!mine || mine.state !== params.get('state')) throw new Error(TEXTS.stale)
  return post('/api/auth', {code: params.get('code'), verifier: mine.verifier, redirect: REDIRECT})
}
