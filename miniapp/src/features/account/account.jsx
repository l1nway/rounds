import {useEffect, useReducer, useRef} from 'react'
import {merge, useOnline} from '../../hooks/state.js'
import {begin, complete, listen, save} from './session.js'

const PLANE = 'M21 4 3 11l5.5 2L19 6.5 10 14.5V20l3.2-3.6L18 20z'
const TIERS = {free: 'Free version', pro: 'Full version'}
const POLL = 500
const START = {phase: null, error: null, menu: false, broken: false}

function Avatar({user, broken, onBroken}) {
  if (!user.photo || broken) return <span className='account-initial' aria-hidden='true'>{(user.name || 'U')[0]}</span>
  return <img src={user.photo} alt='' referrerPolicy='no-referrer' onError={onBroken}/>
}

// [DOC: account-widget]
export default function Account({user, onUser}) {
  const online = useOnline()
  const refs = useRef({popup: null, poll: null})
  const [{phase, error, menu, broken}, dispatch] = useReducer(merge, START)

  useEffect(() => () => clearInterval(refs.current.poll), [])

  useEffect(() => listen(() => refs.current.popup, search => {
    clearInterval(refs.current.poll)
    refs.current.popup?.close()
    dispatch({phase: 'busy', error: null})
    complete(search).then(next => {save(next); onUser(next.user); dispatch(START)}, failure => dispatch({phase: null, error: failure.message}))
  }), [onUser])

  useEffect(() => {
    if (!error && !menu) return
    const escape = event => event.key === 'Escape' && dispatch({error: null, menu: false})
    addEventListener('keydown', escape)
    return () => removeEventListener('keydown', escape)
  }, [error, menu])

  // [DOC: popup-login]
  const signIn = () => {
    const open = refs.current.popup
    if (open && !open.closed) return open.focus()
    try {
      const popup = refs.current.popup = begin()
      dispatch({phase: 'popup', error: null})
      clearInterval(refs.current.poll)
      refs.current.poll = setInterval(() => {
        if (!popup.closed) return
        clearInterval(refs.current.poll)
        dispatch(prev => prev.phase === 'popup' ? {phase: null} : {})
      }, POLL)
    } catch (failure) {dispatch({error: failure.message})}
  }

  const signOut = () => {
    save(null)
    onUser(null)
    dispatch(START)
  }

  const icon = phase ? <span className='spinner' aria-hidden='true'/> : <svg viewBox='0 0 24 24' aria-hidden='true'><path d={PLANE}/></svg>

  return (
    <aside className='account enter' aria-label='Account'>
      <button className='account-button' type='button' disabled={!user && !online} aria-busy={!!phase || undefined} aria-expanded={user ? menu : undefined} aria-label={user ? user.name || 'Account' : 'Sign in with Telegram'} onClick={() => user ? dispatch({menu: !menu}) : signIn()}>
        {user ? <Avatar user={user} broken={broken} onBroken={() => dispatch({broken: true})}/> : icon}
      </button>
      {menu && user && (
        <div className='account-panel account-menu' role='menu'>
          <strong>{user.name || 'Signed in'}</strong>
          <small>{TIERS[user.tier] ?? TIERS.free}</small>
          <button type='button' role='menuitem' onClick={signOut}>Sign out</button>
        </div>
      )}
      {error && !user && <p className='account-panel account-error' role='alert'>{error}<button type='button' onClick={signIn}>Try again</button></p>}
    </aside>
  )
}
