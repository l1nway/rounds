import {AudioSample, AudioSampleSink} from 'mediabunny'

const TARGET = -16
const MAX_GAIN = 24
const CEILING = 10 ** (-1.5 / 20)
const BLOCK = 0.01
const HOP = 0.1
const SPAN = 2
const GATE = -70
const db = power => -0.691 + 10 * Math.log10(power)
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length

// [DOC: local-loudness]
const weighting = rate => {
  const shelf = (() => {
    const k = Math.tan(Math.PI * 1681.974450955533 / rate), q = 0.7071752369554196
    const vh = 10 ** (3.999843853973347 / 20), vb = vh ** 0.4996667741545416
    const a0 = 1 + k / q + k * k
    return [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
  })()
  const high = (() => {
    const k = Math.tan(Math.PI * 38.13547087602444 / rate), q = 0.5003270373238773
    const a0 = 1 + k / q + k * k
    return [1, -2, 1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
  })()
  const stages = [shelf, high].map(coefficients => ({coefficients, z1: 0, z2: 0}))
  return x => stages.reduce((v, stage) => {
    const [b0, b1, b2, a1, a2] = stage.coefficients
    const y = b0 * v + stage.z1
    stage.z1 = b1 * v - a1 * y + stage.z2
    stage.z2 = b2 * v - a2 * y
    return y
  }, x)
}

const integrated = energies => {
  const blocks = []
  for (let i = 0; i + 4 <= energies.length; i++) blocks.push(mean(energies.slice(i, i + 4)))
  const loud = blocks.filter(power => db(power) > GATE)
  if (!loud.length) return null
  const kept = loud.filter(power => db(power) > db(mean(loud)) - 10)
  return kept.length ? db(mean(kept)) : null
}

// [DOC: local-limiter]
const envelope = (peaks, gain) => {
  const need = peaks.map(peak => Math.min(gain, CEILING / Math.max(peak, 1e-9)))
  const window = (values, i, radius) => values.slice(Math.max(0, i - radius), i + radius + 1)
  const low = need.map((_, i) => Math.min(...window(need, i, 2 * SPAN)))
  return Float32Array.from(low.map((_, i) => mean(window(low, i, SPAN))))
}

const gainAt = (gain, time) => {
  const at = Math.min(Math.max(time / BLOCK - 0.5, 0), gain.length - 1), low = Math.floor(at)
  return gain[low] + (gain[Math.min(low + 1, gain.length - 1)] - gain[low]) * (at - low)
}

const createMeter = rate => {
  const hop = Math.round(HOP * rate), block = Math.round(BLOCK * rate)
  const energy = [], peaks = [], filters = []
  let frames = 0
  return {
    push(plane, c, first = 0, last = plane.length) {
      const filter = filters[c] ??= weighting(rate)
      for (let i = first, n = frames; i < last; i++, n++) {
        const y = filter(plane[i])
        energy[Math.floor(n / hop)] = (energy[Math.floor(n / hop)] ?? 0) + y * y / hop
        peaks[Math.floor(n / block)] = Math.max(peaks[Math.floor(n / block)] ?? 0, Math.abs(plane[i]))
      }
    },
    advance(count) {frames += count},
    finish() {
      const level = integrated(energy.slice(0, Math.floor(frames / hop)))
      return level === null || !peaks.length ? null : envelope(peaks, 10 ** (Math.min(TARGET - level, MAX_GAIN) / 20))
    }
  }
}

export const measure = async (input, start, end) => {
  const track = await input.getPrimaryAudioTrack()
  if (!track) return null
  let rate = 0, meter = null
  for await (const sample of new AudioSampleSink(track).samples(start, end)) {
    try {
      if (!rate) meter = createMeter(rate = sample.sampleRate)
      const first = Math.max(0, Math.round((start - sample.timestamp) * rate))
      const last = Math.min(sample.numberOfFrames, Math.round((end - sample.timestamp) * rate))
      for (let c = 0; c < sample.numberOfChannels; c++) {
        const plane = new Float32Array(sample.numberOfFrames)
        sample.copyTo(plane, {planeIndex: c, format: 'f32-planar'})
        meter.push(plane, c, first, last)
      }
      meter.advance(Math.max(0, last - first))
    } finally {sample.close()}
  }
  return meter ? meter.finish() : null
}

export const levelPlanes = (planes, rate) => {
  const meter = createMeter(rate)
  planes.forEach((plane, c) => meter.push(plane, c))
  meter.advance(planes[0].length)
  const gain = meter.finish()
  if (!gain) return
  for (let i = 0; i < planes[0].length; i++) {
    const g = gainAt(gain, i / rate)
    for (const plane of planes) plane[i] *= g
  }
}

export const apply = gain => sample => {
  const channels = sample.numberOfChannels
  const data = new Float32Array(sample.numberOfFrames * channels)
  sample.copyTo(data, {planeIndex: 0, format: 'f32'})
  for (let i = 0; i < sample.numberOfFrames; i++) {
    const g = gainAt(gain, sample.timestamp + i / sample.sampleRate)
    for (let c = 0; c < channels; c++) data[i * channels + c] *= g
  }
  return new AudioSample({data, format: 'f32', numberOfChannels: channels, sampleRate: sample.sampleRate, timestamp: sample.timestamp})
}
