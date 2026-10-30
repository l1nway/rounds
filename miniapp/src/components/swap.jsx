import {useLayoutEffect, useRef, useState} from 'react'
import {useLeave} from '../hooks/state.js'

const RESIZE = {duration: 400, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'}

function Item({n, text, on, still, onGone, as: Tag, render}) {
  const [done] = useState(() => () => onGone(n))
  const ref = useLeave(on, done)
  return <Tag ref={ref} className='swap' data-still={still || undefined}>{render ? render(text) : text}</Tag>
}

// [DOC: swap]
export default function Swap({as: Tag = 'span', item = 'span', text, children, resize, ...rest}) {
  const [state, setState] = useState(() => ({text, n: 0, items: text ? [{n: 0, text, still: true}] : []}))
  if (text !== state.text) {
    const n = state.n + 1
    setState({text, n, items: text ? [...state.items, {n, text}] : state.items})
  }
  const [gone] = useState(() => n => setState(prev => ({...prev, items: prev.items.filter(entry => entry.n !== n)})))
  const box = useRef(null)
  const width = useRef(0)
  // [DOC: swap-resize]
  useLayoutEffect(() => {
    const el = box.current
    if (!resize || !el) return
    const running = el.getAnimations()
    const from = running.length ? el.offsetWidth : width.current
    running.forEach(animation => animation.cancel())
    const to = width.current = el.offsetWidth
    if (from && from !== to && !matchMedia('(prefers-reduced-motion: reduce)').matches) el.animate({width: [`${from}px`, `${to}px`]}, RESIZE)
  }, [resize, state.items])
  const last = state.items.at(-1)
  if (!last) return null
  return (
    <Tag ref={box} {...rest} data-swap=''>
      {state.items.map(entry => <Item key={entry.n} {...entry} as={item} render={children} on={Boolean(state.text) && entry === last} onGone={gone}/>)}
    </Tag>
  )
}
