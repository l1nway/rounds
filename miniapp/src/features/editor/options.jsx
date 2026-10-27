import {memo, useRef} from 'react'
import Slider from '../../components/slider.jsx'
import Swap from '../../components/swap.jsx'
import {haptic} from '../../services/telegram.js'
import {CODECS, LEVELS, OPTIONS, locked as proOnly, shows} from './draft.js'
import './options.css'

const FIRST_OPTION = 3
const HOLD = 200
const REACH = 0.4
// [DOC: slider-lock]
const PREVIEWED = new Set(['look', 'exposure'])

// [DOC: switch-gesture]
const flipAt = ({start, on, flipped, box: {width: w, height: h}}) =>
  flipped ? w / 2 : !on && start > w - h ? start + REACH * w : on && start < h ? start - REACH * w : w / 2

// [DOC: tiers]
const Label = ({label, pro}) => pro ? <span className='options-label'>{label}<span className='options-pro'>PRO</span></span> : label

// [DOC: switch]
function Switch({name, label, hint, checked, disabled, pro, order, onSet}) {
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
      <span className='options-text'><Label label={label} pro={pro}/><small>{hint}</small></span>
      <span className='options-switch'>
        <input type='checkbox' role='switch' name={name} checked={checked && !pro} disabled={disabled || pro} onChange={event => set(event.target.checked)}/>
      </span>
    </label>
  )
}

const zone = (zones, value) => zones.findIndex(({to}) => value <= to)
const signed = (value, unit) => `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} ${unit}`

// [DOC: level-rows]
function Level({name, level: {label, min, max, steps, unit, zones}, value, disabled, pro, locked, order, onSet, onDrag}) {
  const {hint} = zones[zone(zones, value)]
  const shown = unit && value ? signed(value, unit) : ''
  const set = next => {
    if (zone(zones, next) !== zone(zones, value)) haptic.tick()
    onSet(name, next)
  }
  return (
    <div className='options-row options-level enter' style={{'--i': order}}>
      <span>
        <span className='options-text'><span><Label label={label} pro={pro}/>{shown && <output>{shown}</output>}</span><Swap as='small' text={hint}/></span>
        <Slider value={value} min={min} max={max} step={(max - min) / steps} origin={Math.max(min, 0)} reset={min < 0} disabled={disabled || pro} locked={locked}
          aria-label={label} aria-valuetext={shown ? `${shown}, ${hint}` : hint} aria-busy={locked || undefined} onChange={set} onDrag={onDrag}/>
      </span>
    </div>
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
export default memo(function Options({meta, tier, options, codec, stabilize, denoise, look, exposure, locked, readOnly, dispatch}) {
  const rows = meta ? OPTIONS.filter(({needs}) => needs(meta)) : []
  const levels = meta ? LEVELS.filter(level => shows(meta, level)) : []
  const values = {stabilize, denoise, look, exposure}
  const late = rows.length + levels.length
  const order = i => `calc(${i} + ${FIRST_OPTION} * var(--early, 0))`
  const set = (name, value) => dispatch(prev => ({options: {...prev.options, [name]: value}}))
  const setLevel = (name, value) => dispatch({[name]: value})
  const drag = active => dispatch({adjusting: active})
  return (
    <>
      {rows.map((row, i) => <Switch key={row.key} name={row.key} label={row.label} hint={row.hint} checked={Boolean(options[row.key])} disabled={readOnly}
        pro={proOnly(tier, row)} order={order(i)} onSet={set}/>)}
      {levels.map((level, i) => <Level key={level.key} name={level.key} level={level} value={values[level.key]} disabled={readOnly} pro={proOnly(tier, level)}
        locked={locked && PREVIEWED.has(level.key)} order={order(rows.length + i)} onSet={setLevel} onDrag={drag}/>)}
      <Codec codec={codec} disabled={!meta || readOnly} order={`calc(${FIRST_OPTION} + ${late} * var(--early, 0))`} onSet={value => dispatch({codec: value})}/>
    </>
  )
})
