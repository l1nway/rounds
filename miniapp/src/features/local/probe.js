import {VideoSampleSink} from 'mediabunny'
import {ensureHevc} from './hevc-decoder.js'
import {encoders, open} from './render.js'

const TILES = 24
const TILE_H = 96
const UNREADABLE = 'This file cannot be read as a video'

const ALIASES = {
  location: 'com.apple.quicktime.location.ISO6709',
  '©xyz': 'com.apple.quicktime.location.ISO6709',
  make: 'com.apple.quicktime.make',
  model: 'com.apple.quicktime.model',
  software: 'com.apple.quicktime.software',
  date: 'creation_time',
  '©day': 'creation_time',
  '©mak': 'com.apple.quicktime.make',
  '©mod': 'com.apple.quicktime.model',
  '©swr': 'com.apple.quicktime.software'
}

const KEPT_TAGS = new Set([
  'creation_time',
  'com.apple.quicktime.creationdate',
  'com.apple.quicktime.location.ISO6709',
  'com.apple.quicktime.location.accuracy.horizontal',
  'com.apple.quicktime.make',
  'com.apple.quicktime.model',
  'com.apple.quicktime.software',
  'com.apple.quicktime.camera.lens_model',
  'com.apple.quicktime.camera.focal_length.35mm_equivalent',
  'com.apple.quicktime.camera.lens_irisfnumber'
])

export const tagsOf = metadata => {
  if (!metadata) return {}
  const tags = {}
  const raw = metadata.raw ?? {}
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val !== 'string' && typeof val !== 'number') continue
    const text = String(val).split(';')[0].trim()
    if (!text) continue
    const target = ALIASES[key] ?? key
    if (KEPT_TAGS.has(target) && (!(key in ALIASES) || !tags[target])) tags[target] = text
  }
  if (!tags.creation_time && metadata.date) {
    const d = metadata.date instanceof Date ? metadata.date : new Date(metadata.date)
    if (!Number.isNaN(d.getTime())) tags.creation_time = d.toISOString()
  }
  return tags
}

const isInterpolable = metrics => {
  if (!metrics) return false
  const fps = metrics.bestGuessFrameRate ?? 30
  return fps < 59.99 || !metrics.frameRateIsConstant
}

// [DOC: filmstrip-mips]
const shrink = (sample, mip, width) => {
  const levels = Math.max(0, Math.floor(Math.log2(Math.min(sample.displayWidth / width, sample.displayHeight / TILE_H))))
  const w = width * 2 ** levels, h = TILE_H * 2 ** levels
  if (mip.width !== w || mip.height !== h) Object.assign(mip, {width: w, height: h})
  const ctx = mip.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.globalCompositeOperation = 'copy'
  sample.drawWithFit(ctx, {fit: 'cover'})
  for (let i = levels; i > 0; i--) ctx.drawImage(mip, 0, 0, width * 2 ** i, TILE_H * 2 ** i, 0, 0, width * 2 ** (i - 1), TILE_H * 2 ** (i - 1))
}

const sprite = async (track, duration, width) => {
  const canvas = Object.assign(document.createElement('canvas'), {width: TILES * width, height: TILE_H}), context = canvas.getContext('2d')
  const mip = document.createElement('canvas'), sink = new VideoSampleSink(track)
  const times = Array.from({length: TILES}, (_, i) => (i + 0.5) * duration / TILES)
  let tile = 0
  try {
    for await (const sample of sink.samplesAtTimestamps(times)) {
      if (sample) {shrink(sample, mip, width); sample.close(); context.drawImage(mip, 0, 0, width, TILE_H, tile * width, 0, width, TILE_H)}
      tile++
    }
  } finally {mip.width = mip.height = 0}
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob && URL.createObjectURL(blob)), 'image/jpeg', 0.7))
}

// [DOC: local-probe]
export const probe = async file => {
  const input = open(file)
  const track = await input.getPrimaryVideoTrack().catch(() => null)
  if (track) await ensureHevc(track)
  if (!track || !await track.canDecode()) throw new Error(UNREADABLE)
  const [width, height, duration, audio, off, hdr, metadata, metrics] = await Promise.all([
    track.getDisplayWidth(), track.getDisplayHeight(), input.computeDuration(), input.getPrimaryAudioTrack(), encoders(),
    track.hasHighDynamicRange().catch(() => false),
    input.getMetadataTags().catch(() => null),
    track.computeFrameRateMetrics().catch(() => null)
  ])
  const meta = {
    width, height, duration,
    has_audio: Boolean(audio && await audio.canDecode()),
    interpolable: isInterpolable(metrics),
    tags: tagsOf(metadata),
    off, hdr
  }
  const tile = Math.min(Math.round(TILE_H * width / height / 2) * 2, 4 * TILE_H)
  const filmstrip_url = await sprite(track, duration, tile).catch(() => null)
  return {meta, filmstrip_url, filmstrip: {tiles: TILES, tile_width: tile, tile_height: TILE_H}}
}
