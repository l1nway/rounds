import {call, ready} from './models.js'

const SIDE = 1024
const FPS = 30
const SEEK_WAIT = 250
// [DOC: lift-model]
const LIGHT = matchMedia('(pointer: coarse)').matches
const NAMES = LIGHT ? ['edge-sam-encoder', 'edge-sam-decoder'] : ['sam2.1-tiny-encoder', 'sam2.1-tiny-decoder']
const PAD = 'rgb(124, 116, 104)'

let ctx = null
const contextOf = () => ctx ??= Object.assign(document.createElement('canvas'), {width: SIDE, height: SIDE}).getContext('2d', {willReadFrequently: true})
const pixels = (source, [w, h]) => {
  contextOf().fillStyle = PAD
  ctx.fillRect(0, 0, SIDE, SIDE)
  ctx.drawImage(source, 0, 0, w, h)
  return ctx.getImageData(0, 0, SIDE, SIDE).data.buffer
}

const settled = video => video.seeking && new Promise(resolve => {
  const done = () => {video.removeEventListener('seeked', done); clearTimeout(timer); resolve()}
  const timer = setTimeout(done, SEEK_WAIT)
  video.addEventListener('seeked', done)
})

// [DOC: local-lift]
const frameRgba = async (job, time, frame) => {
  const live = document.querySelector('.viewer-video')
  if (live) await settled(live)
  if (live?.readyState >= 2) return pixels(live, frame)
  const [{CanvasSink}, {open}] = await Promise.all([import('mediabunny'), import('./render.js')])
  const sink = new CanvasSink(await open(job.file).getPrimaryVideoTrack(), {width: SIDE, height: SIDE, fit: 'fill'})
  for await (const found of sink.canvasesAtTimestamps([time])) if (found) return pixels(found.canvas, frame)
  throw new Error('Video frame is not ready')
}

export const segmentLocal = async (job, prompt, options) => {
  await ready('lift', NAMES, options)
  const {width, height} = job.meta
  const frame = LIGHT ? [width, height].map(side => side * SIDE / Math.max(width, height)) : [SIDE, SIDE]
  const ask = {
    group: 'lift', type: 'segment', key: `${job.name}:${job.size}:${Math.floor(prompt.time * FPS + 1e-3)}`,
    points: prompt.points, box: prompt.box, width, height, frame
  }
  const hit = await call(ask)
  if (!hit.miss) return hit
  const rgba = await frameRgba(job, prompt.time, frame)
  return call({...ask, rgba}, [rgba])
}
