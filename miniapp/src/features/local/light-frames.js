import {VideoSampleSink} from 'mediabunny'

const AHEAD = 1
const QUEUE = 2
const SLACK = 1e-3
const VERIFY = {verifyKeyPackets: true}

const signal = () => {
  let tick = Promise.withResolvers()
  return {wait: () => tick.promise, nudge: () => {tick.resolve(); tick = Promise.withResolvers()}}
}

// [DOC: light-pump]
async function* oneByOne(sink, times, grab) {
  const packets = sink._createPacketSink(), out = [], pending = [], {wait, nudge} = signal()
  let held = null, failure = null, stopped = false, done = false, decoder = null
  const answer = until => {
    let n = 0
    while (pending.length && pending[0].t < until - 1e-10) {pending.shift(); n++}
    for (let i = 0; i < n; i++) out.push(i < n - 1 ? held?.slice() ?? null : held)
    if (n) {held = null; nudge()}
  }
  const onSample = sample => {
    if (stopped) return sample.close()
    answer(sample.timestamp)
    if (pending.length && sample.timestamp < pending[0].at - SLACK) sample.close()
    else held = grab(sample)
    nudge()
  }
  const room = async () => {while (!stopped && !failure && (out.length >= AHEAD || decoder.getDecodeQueueSize() >= QUEUE)) await wait()}
  const flush = async () => {await decoder.flush(); answer(Infinity); held = null}
  const keyOf = async target => await packets.getKeyPacket(target.timestamp, VERIFY)
    ?? await packets.getFirstKeyPacket(VERIFY).then(key => key && key.timestamp <= target.timestamp ? key : null)

  const pump = async () => {
    decoder = await sink._createDecoder(onSample, error => {failure ??= error; nudge()})
    decoder.onDequeue = nudge
    let last = null, from = -Infinity, upto = -1, key = null
    for (const t of times) {
      if (stopped || failure) return
      const target = await packets.getPacket(t, VERIFY), first = target && await keyOf(target)
      if (!first) {
        if (last) await flush()
        out.push(null)
        nudge()
        last = null
        continue
      }
      if (!last || first.sequenceNumber > upto + 1 || t < from) {
        if (last) await flush()
        last = null
        upto = -1
        key = first
      }
      pending.push({t, at: target.timestamp})
      upto = Math.max(upto, target.sequenceNumber)
      from = t
      while (!last || last.sequenceNumber < upto) {
        await room()
        if (stopped || failure) return
        last = last ? await packets.getNextPacket(last, VERIFY) : key
        if (!last) throw new Error('A video packet is missing')
        decoder.decode(last)
      }
    }
    if (!stopped && !failure) await flush()
  }

  const run = pump().catch(error => {failure ??= error}).finally(() => {done = true; decoder?.close(); nudge()})
  try {
    for (let i = 0; i < times.length; i++) {
      while (!out.length && !failure && !done) await wait()
      if (failure) throw failure
      if (!out.length) return
      const rgba = out.shift()
      nudge()
      yield rgba
    }
  } finally {
    stopped = true
    nudge()
    await run
  }
}

// [DOC: light-frames]
export const lightFrames = (track, width, height) => {
  const ctx = Object.assign(document.createElement('canvas'), {width, height}).getContext('2d'), sink = new VideoSampleSink(track)
  ctx.imageSmoothingQuality = 'high'
  const grab = sample => {sample.drawWithFit(ctx, {fit: 'fill'}); sample.close(); return ctx.getImageData(0, 0, width, height).data}
  if (typeof sink._createDecoder === 'function') return times => oneByOne(sink, times, grab)
  return async function* (times) {for await (const sample of sink.samplesAtTimestamps(times)) yield sample && grab(sample)}
}
