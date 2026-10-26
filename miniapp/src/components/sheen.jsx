import {useLayoutEffect, useRef} from 'react'
import './sheen.css'

const SWEEP = [{transform: 'none'}, {transform: 'translateX(-66.667%)'}]
const TIMING = {duration: 3600, iterations: Infinity, pseudoElement: '::before'}

// [DOC: sheen]
export default function Sheen({on}) {
  const refs = useRef({el: null, run: null})

  useLayoutEffect(() => {
    const run = refs.current.el.animate(SWEEP, TIMING)
    refs.current.run = run
    return () => run.cancel()
  }, [])

  useLayoutEffect(() => {
    const {run} = refs.current
    if (on) run.play()
    else run.pause()
  }, [on])

  return <span ref={el => {refs.current.el = el}} className='sheen' data-on={on || undefined} aria-hidden='true'/>
}
