import {useEffect, useLayoutEffect, useReducer, useRef} from 'react'
import Swap from '../../components/swap.jsx'
import {merge, useOnline} from '../../hooks/state.js'
import {API, authorize, post} from '../../services/api.js'
import Upload from '../upload/upload.jsx'

const SESSION = 'rounds-session'
const PENDING = 'rounds-login'
const REDIRECT = location.origin + location.pathname
const RETURNED = /[?&](code|error)=/.test(location.search)
const PLANE = 'M21 4 3 11l5.5 2L19 6.5 10 14.5V20l3.2-3.6L18 20z'
// [DOC: login-glow]
const FLOW = [{transform: 'translate(0, 0)'}, {transform: 'translate(-50%, -50%)'}]
const TIMING = {duration: 6000, easing: 'ease-in-out', iterations: Infinity, direction: 'alternate', pseudoElement: '::before'}
const TEXTS = {
  intro: 'Turn any video into a Telegram round. Sign in with Telegram to continue.',
  offline: 'You are offline. Signing in needs the connection.',
  cancelled: 'Telegram did not sign you in. Try again.',
  stale: 'This sign-in link has expired. Try again.',
  failed: 'Could not open Telegram. Try again.'
}

const read = (store, key) => {try {return JSON.parse(store.getItem(key))} catch {return null}}
const write = (store, key, value) => {
  try {if (value) store.setItem(key, JSON.stringify(value)); else store.removeItem(key)} catch {/* storage blocked */}
}
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const random = size => base64url(crypto.getRandomValues(new Uint8Array(size)))

const session = () => read(localStorage, SESSION)

// [DOC: auth-header]
authorize(() => `web ${session()?.token}`)

// [DOC: telegram-login]
const start = async () => {
  const verifier = random(32), state = random(16)
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  write(sessionStorage, PENDING, {verifier, state})
  location.assign(`${API}/api/auth/start?${new URLSearchParams({redirect: REDIRECT, challenge, state})}`)
}

const finish = async () => {
  const params = new URLSearchParams(location.search), pending = read(sessionStorage, PENDING)
  write(sessionStorage, PENDING, null)
  history.replaceState(null, '', REDIRECT)
  if (params.has('error')) throw new Error(TEXTS.cancelled)
  if (pending?.state !== params.get('state')) throw new Error(TEXTS.stale)
  return post('/api/auth', {code: params.get('code'), verifier: pending.verifier, redirect: REDIRECT})
}

function TelegramButton({busy, disabled, onClick}) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const glow = ref.current.animate(FLOW, TIMING)
    return () => glow.cancel()
  }, [])
  return (
    <button ref={ref} className='login-telegram enter' type='button' disabled={busy || disabled} aria-busy={busy || undefined} onClick={onClick}>
      {busy ? <span className='spinner'/> : <svg viewBox='0 0 24 24' aria-hidden='true'><path d={PLANE}/></svg>}
      Continue with Telegram
    </button>
  )
}

// [DOC: login]
export default function Login() {
  const online = useOnline()
  const [{user, busy, error}, dispatch] = useReducer(merge, null, () => ({user: session()?.user, busy: RETURNED, error: null}))

  useEffect(() => {
    if (!RETURNED) return
    finish().then(next => {write(localStorage, SESSION, next); dispatch({user: next.user, busy: false})}, failure => dispatch({busy: false, error: failure.message}))
  }, [])

  // back from telegram via bfcache
  useEffect(() => {
    const reset = event => event.persisted && dispatch({busy: false})
    addEventListener('pageshow', reset)
    return () => removeEventListener('pageshow', reset)
  }, [])

  const signIn = () => {
    dispatch({busy: true, error: null})
    start().catch(() => dispatch({busy: false, error: TEXTS.failed}))
  }

  const signOut = () => {
    write(localStorage, SESSION, null)
    dispatch({user: null})
  }

  if (user) return (
    <main className='login'>
      <div className='login-mark enter' aria-hidden='true'/>
      <h1 className='enter'>{user.name ? `Signed in as ${user.name}` : 'Signed in'}</h1>
      <Upload/>
      <button className='login-out enter' type='button' onClick={signOut}>Sign out</button>
    </main>
  )

  return (
    <main className='login'>
      <div className='login-mark enter' aria-hidden='true'/>
      <h1 className='enter'>Round editor</h1>
      <p className='enter'>{TEXTS.intro}</p>
      <TelegramButton busy={busy} disabled={!online} onClick={signIn}/>
      <div className='login-status' role='alert'><Swap as='p' text={error || (online ? '' : TEXTS.offline)}/></div>
    </main>
  )
}
