import {useLayoutEffect, useRef} from 'react'
import {usePresence} from '../hooks/state.js'
import './sheen.css'

const SWEEP = [{transform: 'none'}, {transform: 'translateX(-66.667%)'}]
const TIMING = {duration: 3600, iterations: Infinity, pseudoElement: '::before'}

// [DOC: sheen]
export default function Sheen({on}) {
  const [mounted, ref] = usePresence(on)
  const run = useRef(null)

  useLayoutEffect(() => {
    if (!mounted) return
    const animation = ref.current.animate(SWEEP, TIMING)
    run.current = animation
    return () => animation.cancel()
  }, [mounted, ref])

  useLayoutEffect(() => {
    if (on) run.current?.play()
    else run.current?.pause()
  }, [on])

  return mounted && <span ref={ref} className='sheen' aria-hidden='true'/>
}
