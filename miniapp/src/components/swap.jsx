import {useState} from 'react'
import {useLeave} from '../hooks/state.js'

function Item({n, text, on, still, onGone, as: Tag, render}) {
  const [done] = useState(() => () => onGone(n))
  const ref = useLeave(on, done)
  return <Tag ref={ref} className='swap' data-still={still || undefined}>{render ? render(text) : text}</Tag>
}

// [DOC: swap]
export default function Swap({as: Tag = 'span', item = 'span', text, children, ...rest}) {
  const [state, setState] = useState(() => ({text, n: 0, items: text ? [{n: 0, text, still: true}] : []}))
  if (text !== state.text) {
    const n = state.n + 1
    setState({text, n, items: text ? [...state.items, {n, text}] : state.items})
  }
  const [gone] = useState(() => n => setState(prev => ({...prev, items: prev.items.filter(entry => entry.n !== n)})))
  const last = state.items.at(-1)
  if (!last) return null
  return (
    <Tag {...rest} data-swap=''>
      {state.items.map(entry => <Item key={entry.n} {...entry} as={item} render={children} on={Boolean(state.text) && entry === last} onGone={gone}/>)}
    </Tag>
  )
}
