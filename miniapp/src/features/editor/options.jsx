import {memo, useRef} from 'react'
import Swap from '../../components/swap.jsx'
import {clamp} from '../../hooks/player.js'
import {CODECS, OPTIONS} from './draft.js'
import './options.css'

const TRAVEL = 13
const FIRST_OPTION = 3
const SLOP = 4

// [DOC: switch]
function Switch({name, label, hint, checked, disabled, order, onSet}) {
  const gesture = useRef(null)

  const down = event => {
    const input = event.currentTarget.control
    const own = event.target === input && !input.matches(':disabled') && event.isPrimary && event.button < 1
    gesture.current = own ? {id: event.pointerId, x0: event.clientX, from: input.checked ? TRAVEL : 0, x: 0} : null
    if (own) input.dataset.press = ''
  }

  const move = event => {
    const g = gesture.current
    if (!g || g.done) return
    const dx = event.clientX - g.x0
    if (!g.moved && Math.abs(dx) < SLOP) return
    const input = event.currentTarget.control
    if (!g.moved) {g.moved = true; event.currentTarget.setPointerCapture(g.id); input.dataset.drag = ''}
    g.x = clamp(g.from + dx, 0, TRAVEL)
    input.style.setProperty('--x', `${g.x}px`)
  }

  const end = event => {
    const g = gesture.current
    if (!g || g.done) return
    const input = event.currentTarget.control
    delete input.dataset.press
    delete input.dataset.drag
    input.style.removeProperty('--x')
    g.done = true
    if (!g.moved || event.type !== 'pointerup') gesture.current = null
    else onSet(name, g.x > TRAVEL / 2)
  }

  const click = event => {
    if (!gesture.current?.moved || !event.detail) return
    event.preventDefault()
    gesture.current = null
  }

  return (
    <label className='options-row enter' style={{'--i': order}} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onClickCapture={click}>
      <span className='options-text'>{label}<small>{hint}</small></span>
      <input type='checkbox' role='switch' name={name} checked={checked} disabled={disabled} onChange={event => onSet(name, event.target.checked)}/>
    </label>
  )
}

function Codec({codec, disabled, order, onSet}) {
  const index = CODECS.findIndex(({key}) => key === codec)
  return (
    <div className='options-codec enter' role='radiogroup' aria-label='Codec' style={{'--i': order}}>
      <span className='options-text'>Codec<Swap as='small' text={CODECS[index].hint}/></span>
      <span className='options-segments' style={{'--n': index}}>
        {CODECS.map(({key, label}) => <label key={key}><input type='radio' name='codec' value={key} checked={codec === key} disabled={disabled} onChange={() => onSet(key)}/>{label}</label>)}
      </span>
    </div>
  )
}

// [DOC: late-rows]
export default memo(function Options({meta, options, codec, readOnly, dispatch}) {
  const rows = meta ? OPTIONS.filter(({needs}) => needs(meta)) : []
  const set = (name, value) => dispatch(prev => ({options: {...prev.options, [name]: value}}))
  return (
    <>
      {rows.map(({key, label, hint}, i) => <Switch key={key} name={key} label={label} hint={hint} checked={Boolean(options[key])} disabled={readOnly} order={`calc(${i} + ${FIRST_OPTION} * var(--early, 0))`} onSet={set}/>)}
      <Codec codec={codec} disabled={!meta || readOnly} order={`calc(${FIRST_OPTION} + ${rows.length} * var(--early, 0))`} onSet={value => dispatch({codec: value})}/>
    </>
  )
})
