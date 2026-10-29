import {AudioSample, AudioSampleSink} from 'mediabunny'

export const SAMPLE_RATE = 48_000
const MIN_DB = 6
const MAX_DB = 100

// [DOC: local-denoise]
export const attenOf = strength => MIN_DB * (MAX_DB / MIN_DB) ** strength

export const decode = async (input, start, end) => {
  const track = await input.getPrimaryAudioTrack()
  if (!track) return null
  let rate = 0, count = 0, raw = null
  for await (const sample of new AudioSampleSink(track).samples(start, end)) {
    try {
      if (!rate) {
        rate = sample.sampleRate
        count = Math.min(sample.numberOfChannels, 2)
        raw = Array.from({length: count}, () => new Float32Array(Math.max(1, Math.round((end - start) * rate))))
      }
      const offset = Math.round((sample.timestamp - start) * rate)
      const first = Math.max(0, -offset)
      const last = Math.min(sample.numberOfFrames, raw[0].length - offset)
      if (last <= first) continue
      const plane = new Float32Array(sample.numberOfFrames)
      for (let c = 0; c < count; c++) {
        sample.copyTo(plane, {planeIndex: c, format: 'f32-planar'})
        raw[c].set(plane.subarray(first, last), offset + first)
      }
    } finally {sample.close()}
  }
  if (!raw) return null
  if (rate === SAMPLE_RATE) return raw
  const total = Math.max(1, Math.round((end - start) * SAMPLE_RATE)), scale = rate / SAMPLE_RATE
  return raw.map(src => {
    const out = new Float32Array(total), max = src.length - 1
    for (let i = 0; i < total; i++) {
      const pos = i * scale, low = Math.min(Math.floor(pos), max), next = Math.min(low + 1, max)
      out[i] = src[low] + (src[next] - src[low]) * (pos - low)
    }
    return out
  })
}

export const denoise = async (input, start, end, strength) => {
  const channels = await decode(input, start, end)
  if (!channels) return null
  const worker = new Worker(new URL('./denoise-worker.js', import.meta.url), {type: 'module'})
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({data}) => data.error ? reject(new Error(data.error)) : resolve(data.channels)
      worker.onerror = event => reject(new Error(event.message || 'Noise reduction worker failed'))
      worker.postMessage({channels, atten: attenOf(strength)}, channels.map(c => c.buffer))
    })
  } finally {worker.terminate()}
}

export const replace = channels => {
  const count = channels.length, total = channels[0].length
  return sample => {
    const from = Math.min(Math.max(Math.round(sample.timestamp * SAMPLE_RATE), 0), total)
    const to = Math.min(Math.max(Math.round((sample.timestamp + sample.duration) * SAMPLE_RATE), from), total)
    const frames = to - from
    if (!frames) return null
    const data = count === 1 ? channels[0].slice(from, to) : new Float32Array(frames * count)
    if (count > 1) for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) data[i * count + c] = channels[c][from + i]
    return new AudioSample({data, format: 'f32', numberOfChannels: count, sampleRate: SAMPLE_RATE, timestamp: from / SAMPLE_RATE})
  }
}
