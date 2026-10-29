import {DeepFilter} from '@lofcz/deepfilternet-web'

const DELAY = 3

const same = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// [DOC: local-denoise]
const cleanOne = async (input, atten, wasm) => {
  const df = await DeepFilter.create({attenuationLimit: atten, wasmUrl: {module_or_path: wasm}})
  try {
    const step = df.frameLength, len = input.length, frames = Math.ceil(len / step)
    const out = new Float32Array(len), zero = new Float32Array(step), tail = new Float32Array(step)
    for (let f = 0; f < frames + DELAY; f++) {
      const start = f * step
      let frame = zero
      if (start + step <= len) frame = input.subarray(start, start + step)
      else if (start < len) {
        tail.fill(0)
        tail.set(input.subarray(start))
        frame = tail
      }
      const clean = df.process(frame)
      if (f >= DELAY) {
        const at = (f - DELAY) * step
        out.set(at + step <= len ? clean : clean.subarray(0, len - at), at)
      }
    }
    return out
  } finally {df.destroy()}
}

export const cleanChannels = async (channels, atten, wasm) => {
  const first = await cleanOne(channels[0], atten, wasm)
  if (channels.length === 1) return [first]
  const second = same(channels[0], channels[1]) ? first.slice() : await cleanOne(channels[1], atten, wasm)
  return [first, second]
}

if (typeof self !== 'undefined') {
  self.onmessage = async ({data: {channels, atten, wasm}}) => {
    try {
      const result = await cleanChannels(channels, atten, wasm)
      self.postMessage({channels: result}, result.map(c => c.buffer))
    } catch (error) {
      self.postMessage({error: error?.message || 'Noise reduction failed'})
    }
  }
}
