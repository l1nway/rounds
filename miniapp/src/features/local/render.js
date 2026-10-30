import {BlobSource, BufferTarget, Conversion, Input, MATROSKA, MP4, Mp4OutputFormat, Output, QTFF, Quality, WEBM, canEncodeAudio, canEncodeVideo} from 'mediabunny'
import './hevc-decoder.js'
import {SAMPLE_RATE, denoise, replace} from './denoise.js'
import {apply, levelPlanes, measure} from './loudness.js'
import {grade} from './look.js'

const OUT = 640
const TRACKING = 'Following the object…'
const STEADYING = 'Steadying the video…'
const FORMATS = [MP4, QTFF, WEBM, MATROSKA]
const NOTE_BYTES = 10_000_000
const HEADROOM = 0.92
const SHRINK = 0.95
const TRIES = 3
const AUDIO_RATE = 128_000
const MAX_RATE = 14_000_000
const ZOOM_MARGIN = 1.6
const ZOOM_FLOOR = 0.25
const CODEC_NAMES = ['av1', 'hevc', 'vp9']
const AUDIO_CODECS = ['aac', 'opus']
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length

export const open = file => new Input({source: new BlobSource(file), formats: FORMATS})

// [DOC: local-frame]
export const frameOf = ({width: w, height: h}, {points, box, crop}, zoom) => {
  const picked = points.filter(point => point[2] === 1)
  let cx = w / 2, cy = h / 2, span = 0
  if (box) {
    cx = (box[0] + box[2]) / 2 * w
    cy = (box[1] + box[3]) / 2 * h
    span = Math.max((box[2] - box[0]) * w, (box[3] - box[1]) * h)
  } else if (picked.length) {
    cx = mean(picked.map(point => point[0])) * w
    cy = mean(picked.map(point => point[1])) * h
  }
  let side = Math.min(w, h)
  const fit = crop ? 1 : zoom && ZOOM_MARGIN  // [DOC: crop-mode]
  if (fit && span) side = Math.min(side, Math.max(span * fit, side * ZOOM_FLOOR))
  side = Math.trunc(side) >> 1 << 1
  const at = (center, size) => Math.trunc(Math.min(Math.max(center - side / 2, 0), size - side))
  return {left: at(cx, w), top: at(cy, h), width: side, height: side}
}

// [DOC: local-encoders]
export const encoders = async () => {
  const checks = await Promise.all(CODEC_NAMES.map(codec =>
    canEncodeVideo(codec, {width: OUT, height: OUT, bitrate: 2_000_000}).catch(() => false)))
  return CODEC_NAMES.filter((_, i) => !checks[i])
}

const audioCodec = async () => {
  for (const codec of AUDIO_CODECS) if (await canEncodeAudio(codec).catch(() => false)) return codec
  return null
}

const MARK = 'Round from Telegram'
const MARKED = ['com.apple.quicktime.model', 'com.apple.quicktime.software']

// [DOC: square-source]
export const follows = (meta, request) => {
  const square = meta.width === meta.height
  return request.prompt?.time !== null && !request.prompt?.crop && (!square || Boolean(request.options?.zoom))
}

// [DOC: local-metadata]
const keepTags = tags => {
  const raw = {...tags}
  const key = MARKED.find(k => k in raw) ?? MARKED[MARKED.length - 1]
  raw[key] = raw[key] ? `${raw[key]} (${MARK})` : MARK
  return {raw}
}

// [DOC: local-size]
const videoRate = (seconds, share, sound) =>
  Math.min(MAX_RATE, Math.max(100_000, Math.floor(NOTE_BYTES * 8 * share / seconds - (sound ? AUDIO_RATE : 0))))

export const encode = async (input, {crop, at, steady, start, end, codec, sound, audio, look, ev, rate, tags, onProgress}) => {
  const output = new Output({format: new Mp4OutputFormat({fastStart: 'in-memory', metadataFormat: 'mdta'}), target: new BufferTarget()})
  const fixed = () => [crop.left + crop.width / 2, crop.top + crop.height / 2, crop.width]
  const conversion = await Conversion.init({
    input, output, trim: {start, end}, tags: tags ? () => tags : () => ({}), showWarnings: false,
    video: {
      process: steady ? steady() : grade(look, ev, OUT, at ?? fixed), processedWidth: OUT, processedHeight: OUT,
      codec, forceTranscode: true, keyFrameInterval: 2,
      quality: new Quality({bitrate: rate, bitrateMode: 'constant'})
    },
    audio: sound ? {codec: sound, bitrate: AUDIO_RATE, forceTranscode: true, ...audio} : {discard: true}
  })
  if (!conversion.isValid) throw new Error('This browser cannot encode the round')
  conversion.onProgress = onProgress
  await conversion.execute()
  return new Blob([output.target.buffer], {type: 'video/mp4'})
}

// [DOC: local-track]
export const renderNote = async (file, meta, request, onProgress) => {
  const {start, end, codec, prompt, options, denoise: noise, look, exposure: ev} = request
  const input = open(file)
  const sound = meta.has_audio ? await audioCodec() : null
  const follow = follows(meta, request), shaky = request.stabilize > 0, text = follow ? TRACKING : STEADYING
  let at = null, steady = null
  if (follow || shaky) {
    onProgress(0, text)
    const done = [follow ? 0 : 1, shaky ? 0 : 1], report = i => p => {done[i] = p; onProgress(0.2 * (done[0] + done[1]), text)}
    const [{trackLocal}, {solve, sampler}, stab] = await Promise.all([import('./track-local.js'), import('./camera.js'), shaky && import('./stabilize.js')])
    const flow = shaky && stab.motionOf(file, input, meta, start, end, report(1))
    if (flow) flow.catch(() => {})
    const {found, cuts} = follow ? await trackLocal(file, meta, request, report(0)) : {}
    // [DOC: local-stabilization]
    const moving = shaky && await stab.pathOf({flow: await flow, found, cuts, meta, request, crop: prompt.crop && frameOf(meta, prompt, Boolean(options.zoom))})
    if (moving) steady = () => stab.stabilizer(moving, look, ev, OUT)
    else if (follow) at = sampler(await solve(found, meta.width, meta.height, cuts, 30, Boolean(options.zoom)), cuts)
  }
  const crop = at ? null : frameOf(meta, prompt, Boolean(options.zoom))
  const clean = sound && noise ? await denoise(input, start, end, noise, file) : null
  if (clean && options.loudnorm) levelPlanes(clean, SAMPLE_RATE)
  const gain = sound && !clean && options.loudnorm ? await measure(input, start, end) : null
  const audio = clean ? {processedSampleRate: SAMPLE_RATE, processedNumberOfChannels: clean.length, process: replace(clean)}
    : gain ? {sampleFormat: 'f32', process: apply(gain)} : null
  const tags = options.metadata ? keepTags(meta.tags) : null
  let share = HEADROOM
  const encodeBase = follow || shaky ? 0.4 : 0, encodeScale = 1 - encodeBase
  for (let t = 1; ; t++) {
    const blob = await encode(input, {crop, at, steady, start, end, codec, sound, audio, look, ev, rate: videoRate(end - start, share, sound), tags, onProgress: p => onProgress(encodeBase + encodeScale * (t - 1 + p) / TRIES)})
    if (blob.size <= NOTE_BYTES) return {blob, silent: meta.has_audio && !sound}
    if (t >= TRIES) throw new Error('The round came out too big, try a shorter range')
    share *= SHRINK * NOTE_BYTES / blob.size
  }
}
