import {useLayoutEffect, useRef, useState} from 'react'
import {useLeave} from '../hooks/state.js'

const RESIZE = {duration: 400, easing: 'cubic-bezier(0.4, 0, 0.2, 1)'}

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
  const size = useRef(null)
  // [DOC: swap-resize]
  useLayoutEffect(() => {
    const el = box.current
    if (!resize || !el) return
    const fit = () => {
      const running = el.getAnimations()
      const from = running.length ? [el.offsetWidth, el.offsetHeight] : size.current
      running.forEach(animation => animation.cancel())
      const to = size.current = [el.offsetWidth, el.offsetHeight]
      if (!from || (from[0] === to[0] && from[1] === to[1]) || matchMedia('(prefers-reduced-motion: reduce)').matches) return
      el.animate({width: [`${from[0]}px`, `${to[0]}px`], height: [`${from[1]}px`, `${to[1]}px`]}, RESIZE)
    }
    fit()
    const watch = new ResizeObserver(fit)
    for (const child of el.children) watch.observe(child)
    return () => watch.disconnect()
  }, [resize, state.items])
  const last = state.items.at(-1)
  if (!last) return null
  return (
    <Tag ref={box} {...rest} data-swap=''>
      {state.items.map(entry => <Item key={entry.n} {...entry} as={item} render={children} on={Boolean(state.text) && entry === last} onGone={gone}/>)}
    </Tag>
  )
}
