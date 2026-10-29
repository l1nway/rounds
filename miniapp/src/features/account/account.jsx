import {useEffect, useReducer, useRef} from 'react'
import {merge, useOnline} from '../../hooks/state.js'
import {begin, complete, heard, save} from './session.js'

const PLANE = 'M21 4 3 11l5.5 2L19 6.5 10 14.5V20l3.2-3.6L18 20z'
const TIERS = {free: 'Free version', pro: 'Full version'}
const FAILED = 'Could not open Telegram. Try again.'
const START = {open: false, src: null, busy: false, error: null, menu: false, broken: false}

function Avatar({user, broken, onBroken}) {
  if (!user.photo || broken) return <span className='account-initial' aria-hidden='true'>{(user.name || 'U')[0]}</span>
  return <img src={user.photo} alt='' referrerPolicy='no-referrer' onError={onBroken}/>
}

// [DOC: account-widget]
export default function Account({user, onUser}) {
  const online = useOnline()
  const frame = useRef(null)
  const [{open, src, busy, error, menu, broken}, dispatch] = useReducer(merge, START)

  useEffect(() => {
    const listen = event => {
      const search = heard(event, frame.current?.contentWindow)
      if (search === null) return
      dispatch({busy: true})
      complete(search).then(next => {save(next); onUser(next.user); dispatch(START)}, failure => dispatch({busy: false, error: failure.message}))
    }
    addEventListener('message', listen)
    return () => removeEventListener('message', listen)
  }, [onUser])

  useEffect(() => {
    if (!open && !menu) return
    const escape = event => event.key === 'Escape' && dispatch({open: false, menu: false})
    addEventListener('keydown', escape)
    return () => removeEventListener('keydown', escape)
  }, [open, menu])

  const signIn = () => {
    dispatch({open: true, src: null, error: null})
    begin().then(url => dispatch({src: url}), () => dispatch({error: FAILED}))
  }

  const signOut = () => {
    save(null)
    onUser(null)
    dispatch(START)
  }

  const press = () => user ? dispatch({menu: !menu}) : open ? dispatch({open: false}) : signIn()

  return (
    <aside className='account enter' aria-label='Account'>
      <button className='account-button' type='button' disabled={!user && !online} aria-expanded={open || menu} aria-label={user ? user.name || 'Account' : 'Sign in with Telegram'} onClick={press}>
        {user ? <Avatar user={user} broken={broken} onBroken={() => dispatch({broken: true})}/> : <svg viewBox='0 0 24 24' aria-hidden='true'><path d={PLANE}/></svg>}
      </button>
      {menu && user && (
        <div className='account-panel account-menu' role='menu'>
          <strong>{user.name || 'Signed in'}</strong>
          <small>{TIERS[user.tier] ?? TIERS.free}</small>
          <button type='button' role='menuitem' onClick={signOut}>Sign out</button>
        </div>
      )}
      {open && (
        <div className='account-panel account-login' role='dialog' aria-label='Sign in with Telegram'>
          {src && <iframe ref={frame} title='Telegram sign-in' src={src} referrerPolicy='origin' data-busy={busy || undefined}/>}
          {(!src || busy) && !error && <span className='spinner' aria-hidden='true'/>}
          {error && <p role='alert'>{error}<button type='button' onClick={signIn}>Try again</button></p>}
        </div>
      )}
    </aside>
  )
}
