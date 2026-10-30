import {pair, pyramid} from './motion-flow.js'

let prev = null

// [DOC: local-motion-flow]
self.onmessage = ({data: {index, img, w, h, mask, corners, first}}) => {
  try {
    const next = pyramid(img, w, h)
    const pairs = first ? null : pair(prev, next, mask, corners)
    prev = next
    self.postMessage({index, pairs}, pairs ? [pairs.buffer] : [])
  } catch (error) {
    self.postMessage({index, error: error.message})
  }
}
