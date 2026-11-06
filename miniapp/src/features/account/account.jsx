import {useEffect, useReducer, useRef, useState} from 'react'
import Swap from '../../components/swap.jsx'
import {merge, useOnline, usePresence} from '../../hooks/state.js'
import {begin, complete, link, listen, save} from './session.js'

const PLANE = 'M21 4 3 11l5.5 2L19 6.5 10 14.5V20l3.2-3.6L18 20z'
const TIERS = {free: 'Free version', pro: 'Full version'}
const POLL = 500
const START = {phase: null, alert: null, menu: false, shown: null, broken: null, boot: true}
const GLYPHS = {
  plane: () => <svg viewBox='0 0 24 24' aria-hidden='true'><path d={PLANE}/></svg>,
  spin: () => <span className='spinner' aria-hidden='true'/>
}

const useLast = value => {
  const [last, setLast] = useState(value)
  if (value != null && value !== last) setLast(value)
  return value ?? last
}

function Disc({holder, still}) {
  const [quiet] = useState(still)
  return <span ref={holder} className='account-disc' data-still={quiet || undefined}/>
}

// [DOC: account-panel]
function Panel({on, as: Tag = 'div', children, ...rest}) {
  const [mounted, ref] = usePresence(on)
  if (!mounted) return null
  return <div className='account-holder'><Tag ref={ref} className='account-panel' {...rest}>{children}</Tag></div>
}

// [DOC: account-widget]
export default function Account({user, onUser}) {
  const online = useOnline()
  const refs = useRef({popup: null, poll: null})
  const [{phase, alert, menu, shown, broken, boot}, dispatch] = useReducer(merge, START)
  const photo = user?.photo && broken !== user.photo ? user.photo : null
  const [disc, discRef] = usePresence(!photo || shown !== photo)
  const [face, faceRef] = usePresence(Boolean(photo))
  const last = {user: useLast(user), alert: useLast(alert), photo: useLast(photo)}

  useEffect(() => {
    const own = refs.current
    dispatch({boot: false})
    return () => clearInterval(own.poll)
  }, [])

  useEffect(() => listen(() => refs.current.popup, search => {
    clearInterval(refs.current.poll)
    refs.current.popup?.close()
    dispatch({phase: 'busy', alert: null})
    complete(search).then(next => {save(next); onUser(next.user); dispatch({phase: null})}, failure => dispatch({phase: null, alert: {text: failure.message}}))
  }), [onUser])

  useEffect(() => {
    if (!alert && !menu) return
    const escape = event => event.key === 'Escape' && dispatch({alert: null, menu: false})
    addEventListener('keydown', escape)
    return () => removeEventListener('keydown', escape)
  }, [alert, menu])

  // [DOC: tab-login]
  useEffect(() => {
    if (phase !== 'popup') return
    const back = () => document.visibilityState === 'visible' && !refs.current.popup && dispatch(prev => prev.phase === 'popup' ? {phase: null} : {})
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [phase])

  // [DOC: popup-login]
  const signIn = () => {
    const open = refs.current.popup
    if (open && !open.closed) return open.focus()
    try {
      const popup = refs.current.popup = begin()
      dispatch({phase: 'popup', alert: null})
      clearInterval(refs.current.poll)
      refs.current.poll = setInterval(() => {
        if (!popup.closed) return
        clearInterval(refs.current.poll)
        dispatch(prev => prev.phase === 'popup' ? {phase: null} : {})
      }, POLL)
    } catch (failure) {dispatch({alert: {text: failure.message, link: link()}})}
  }

  const followLink = () => {
    refs.current.popup = null
    dispatch({phase: 'popup', alert: null})
  }

  const signOut = () => {
    save(null)
    onUser(null)
    dispatch({phase: null, alert: null, menu: false})
  }

  const glyph = phase ? 'spin' : !user ? 'plane' : photo ? null : (user.name || 'U')[0]
  const reveal = event => event.currentTarget.decode().catch(() => {}).then(() => dispatch({shown: last.photo}))

  return (
    <aside className='account enter' aria-label='Account'>
      <button className='account-button' type='button' disabled={!user && !online} data-user={user ? '' : undefined} aria-busy={!!phase || undefined} aria-expanded={user ? menu : undefined} aria-label={user ? user.name || 'Account' : 'Sign in with Telegram'} onClick={() => user ? dispatch({menu: !menu}) : signIn()}>
        {disc && <Disc holder={discRef} still={boot}/>}
        {face && <img ref={faceRef} className='account-photo' src={last.photo} alt='' referrerPolicy='no-referrer' data-shown={shown === last.photo || undefined} onLoad={reveal} onError={() => dispatch({broken: last.photo})}/>}
        <Swap className='account-glyph' text={glyph}>{value => GLYPHS[value]?.() ?? value}</Swap>
      </button>
      <Panel on={Boolean(menu && user)} role='menu'>
        <strong>{last.user?.name || 'Signed in'}</strong>
        <small>{TIERS[last.user?.tier] ?? TIERS.free}</small>
        <button type='button' role='menuitem' onClick={signOut}>Sign out</button>
      </Panel>
      <Panel on={Boolean(alert && !user)} as='p' role='alert' data-error=''>
        <span>{last.alert?.text}</span>
        {last.alert?.link
          ? <a href={last.alert.link.url} target={last.alert.link.name} rel='opener' onClick={followLink}>Open Telegram</a>
          : <button type='button' onClick={signIn}>Try again</button>}
      </Panel>
    </aside>
  )
}
