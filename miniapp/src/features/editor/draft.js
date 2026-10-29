import {LOOK} from '../../constants/look.js'
import {MIN_RANGE, ms} from '../../hooks/player.js'

// [DOC: options-seam]
export const OPTIONS = [
  {key: 'zoom', label: 'Zoom in on the object', hint: 'Off: only crops to a square that follows it', needs: meta => Math.min(meta.width, meta.height) > 640},
  {key: 'loudnorm', need: 'free', local: true, label: 'Even out loudness', hint: 'Quiet parts louder, loud ones softer', needs: meta => meta.has_audio},
  {key: 'interpolate', need: 'pro', label: 'Smooth to 60 fps', hint: 'AI draws in-between frames, fixes stutter', needs: meta => meta.interpolable},
  {key: 'upscale', need: 'pro', label: 'AI upscale', hint: 'Redraws a small video in sharp 640 px. Slow: about 4 min per 10 s', needs: meta => Math.min(meta.width, meta.height) < 640},
  {key: 'metadata', need: 'free', local: true, label: 'Keep original metadata', hint: 'Date, camera, GPS: recipients see where it was filmed', needs: meta => Object.keys(meta.tags ?? {}).length > 0}
]
// [DOC: level-rows]
export const LEVELS = [
  // [DOC: hdr-slider]
  {key: 'look', need: 'pro', local: LOOK.HONEST, label: 'HDR', min: 0, max: 1, steps: 100, zones: [
    {to: 0, hint: 'Off'}, {to: LOOK.HONEST, hint: 'Recovers highlights and shadows'}, {to: 1, hint: 'AI cleans noise, lifts the dark. Slower'}
  ]},
  // [DOC: exposure-slider]
  {key: 'exposure', need: 'pro', local: true, label: 'Exposure', min: -2, max: 2, steps: 40, unit: 'EV', zones: [
    {to: -0.05, hint: 'Darker, colours kept'}, {to: 0, hint: 'Off'}, {to: 2, hint: 'Brighter, highlights protected'}
  ]},
  // [DOC: stabilize-slider]
  {key: 'stabilize', need: 'pro', label: 'Stabilize', min: 0, max: 1, steps: 100, zones: [
    {to: 0, hint: 'Off'}, {to: 1, hint: 'Steadies shaky hands, fills the edges'}
  ]},
  // [DOC: deblur-slider]
  {key: 'deblur', need: 'pro', label: 'Deblur', min: 0, max: 4, steps: 4, zones: [
    {to: 0, hint: 'Off'}, {to: 1, hint: 'Classic: detail from sharp neighbors'}, {to: 2, hint: 'AI: undoes motion blur. Slower'},
    {to: 3, hint: 'Mix: AI on a half-classic pass'}, {to: 4, hint: 'Both: classic, then AI. Strongest'}
  ]},
  // [DOC: noise-slider]
  {key: 'denoise', need: 'free', local: true, label: 'Reduce noise', min: 0, max: 1, steps: 100, needs: meta => meta.has_audio, zones: [
    {to: 0, hint: 'Off'}, {to: 1, hint: 'AI keeps voices, cuts the rest, music too'}
  ]}
]
// [DOC: codec-picker]
export const CODECS = [
  {key: 'av1', label: 'AV1', hint: 'Most detail per MB'},
  {key: 'hevc', label: 'HEVC', hint: 'Hardware playback on every iPhone'},
  {key: 'vp9', label: 'VP9', hint: 'A little less detail per MB'}
]

const codecOf = (key, off = []) => {
  const open = CODECS.filter(codec => !off.includes(codec.key))
  return open.some(codec => codec.key === key) ? key : (open[0] ?? CODECS[0]).key
}

// [DOC: tiers]
const RANK = {local: 0, free: 1, pro: 2}
export const locked = (tier, {need, local}, device) => !(device && local) && RANK[tier] < RANK[need] && need
export const capOf = (tier, level) => locked(tier, level) && level.local < 1 ? level.local : level.max
export const optionsFor = ({meta, tier, local}, options) => Object.fromEntries(OPTIONS.map(item => [item.key, Boolean(item.needs(meta) && !locked(tier, item, local) && options[item.key])]))
export const shows = (meta, {needs}) => !needs || needs(meta)
export const levelsFor = ({meta, tier, local}, draft) => Object.fromEntries(LEVELS.map(level => [level.key, shows(meta, level) && !locked(tier, level, local) ? Math.min(draft[level.key], capOf(tier, level)) : 0]))

// [DOC: editor-draft]
export const init = job => {
  const last = job?.request
  return {
    start: last?.start ?? 0, end: last?.end ?? ms(Math.min(job?.meta.duration ?? 0, job?.max_duration ?? 0)),
    time: last?.prompt.time ?? null, points: last?.prompt.points ?? [], box: last?.prompt.box ?? null,
    mask: last?.prompt.mask ?? null, options: {...last?.options}, codec: codecOf(last?.codec, job?.meta.off),
    ...Object.fromEntries(LEVELS.map(({key}) => [key, last?.[key] ?? 0])), posting: false, error: null
  }
}

// [DOC: square-source]
const optional = (job, options) => job.tier !== 'pro' || (job.meta.width === job.meta.height && !optionsFor(job, options).zoom)
const selected = ({start, end, time, points, box}) => (Boolean(box) || points.some(p => p[2] === 1)) && time !== null && time >= start && time <= end

export const isValid = (draft, job) => Boolean(job) && (draft.time === null ? optional(job, draft.options) : selected(draft))
  && draft.end - draft.start >= Math.min(MIN_RANGE, job.meta.duration) && draft.end - draft.start <= job.max_duration + 1e-6
export const rowCount = meta => [...OPTIONS, ...LEVELS].filter(item => shows(meta, item)).length
