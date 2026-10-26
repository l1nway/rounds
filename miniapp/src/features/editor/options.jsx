import {memo, useRef} from 'react'
import Swap from '../../components/swap.jsx'
import {haptic} from '../../services/telegram.js'
import {CODECS, NOISE, OPTIONS} from './draft.js'
import './options.css'

const FIRST_OPTION = 3
const HOLD = 200
const REACH = 0.4

// [DOC: switch-gesture]
const flipAt = ({start, on, flipped, box: {width: w, height: h}}) =>
  flipped ? w / 2 : !on && start > w - h ? start + REACH * w : on && start < h ? start - REACH * w : w / 2

// [DOC: switch]
function Switch({name, label, hint, checked, disabled, order, onSet}) {
  const gesture = useRef(null)
  const set = (value, felt) => {if (!felt) haptic.tap('light'); onSet(name, value)}

  const down = event => {
    clearTimeout(gesture.current?.timer)
    const row = event.currentTarget, input = row.control
    const own = event.target === input && !input.matches(':disabled') && event.isPrimary && event.button < 1
    const g = own ? {id: event.pointerId, x: event.clientX, on: input.checked} : null
    gesture.current = g
    if (!own) return
    const track = () => {g.box = input.getBoundingClientRect(); g.start = g.x - g.box.left; g.tracking = true; row.setPointerCapture(g.id)}
    if (event.pointerType === 'mouse') track()
    else g.timer = setTimeout(() => {track(); input.dataset.press = ''}, HOLD)
  }

  const move = event => {
    const g = gesture.current
    if (g?.id !== event.pointerId || g.done) return
    g.x = event.clientX
    if (!g.tracking || (g.x - g.box.left < flipAt(g)) !== g.on) return
    const input = event.currentTarget.control
    g.on = !g.on
    g.flipped = true
    input.toggleAttribute('data-flip', g.on !== input.checked)
    haptic.tap('light')
  }

  const end = event => {
    const g = gesture.current
    if (g?.id !== event.pointerId || g.done) return
    const input = event.currentTarget.control
    clearTimeout(g.timer)
    delete input.dataset.press
    delete input.dataset.flip
    g.done = true
    const value = g.flipped ? g.on : !input.checked
    if (event.type === 'pointercancel' && !g.tracking) gesture.current = null
    else if (value !== input.checked) set(value, g.flipped)
  }

  const click = event => {
    if (!gesture.current?.done || !event.detail) return
    event.preventDefault()
    gesture.current = null
  }

  return (
    <label className='options-row enter' style={{'--i': order}} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onClickCapture={click}>
      <span className='options-text'>{label}<small>{hint}</small></span>
      <span className='options-switch'>
        <input type='checkbox' role='switch' name={name} checked={checked} disabled={disabled} onChange={event => set(event.target.checked)}/>
      </span>
    </label>
  )
}

const zone = value => NOISE.findIndex(({to}) => value <= to)

// [DOC: noise-slider]
function Noise({value, disabled, order, onSet}) {
  const {hint} = NOISE[zone(value)]
  const input = event => {
    const next = event.target.valueAsNumber / 100
    if (zone(next) !== zone(value)) haptic.tick()
    onSet(next)
  }
  return (
    <label className='options-row options-level enter' style={{'--i': order}}>
      <span>
        <span className='options-text'>Reduce noise<Swap as='small' text={hint}/></span>
        <input type='range' name='denoise' min='0' max='100' step='1' value={Math.round(value * 100)} aria-valuetext={hint} disabled={disabled} style={{'--p': value}} onInput={input}/>
      </span>
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
export default memo(function Options({meta, options, codec, denoise, readOnly, dispatch}) {
  const rows = meta ? OPTIONS.filter(({needs}) => needs(meta)) : []
  const late = rows.length + Number(Boolean(meta?.has_audio))
  const set = (name, value) => dispatch(prev => ({options: {...prev.options, [name]: value}}))
  return (
    <>
      {rows.map(({key, label, hint}, i) => <Switch key={key} name={key} label={label} hint={hint} checked={Boolean(options[key])} disabled={readOnly} order={`calc(${i} + ${FIRST_OPTION} * var(--early, 0))`} onSet={set}/>)}
      {meta?.has_audio && <Noise value={denoise} disabled={readOnly} order={`calc(${rows.length} + ${FIRST_OPTION} * var(--early, 0))`} onSet={value => dispatch({denoise: value})}/>}
      <Codec codec={codec} disabled={!meta || readOnly} order={`calc(${FIRST_OPTION} + ${late} * var(--early, 0))`} onSet={value => dispatch({codec: value})}/>
    </>
  )
})
