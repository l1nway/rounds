import {LOOK} from '../../constants/look.js'
import {MIN_RANGE, ms} from '../../hooks/player.js'

// [DOC: options-seam]
export const OPTIONS = [
  {key: 'zoom', label: 'Zoom in on the object', hint: 'Off: only crops to a square that follows it', needs: meta => Math.min(meta.width, meta.height) > 640},
  {key: 'loudnorm', label: 'Even out loudness', hint: 'Quiet parts louder, loud ones softer', needs: meta => meta.has_audio},
  {key: 'interpolate', label: 'Smooth to 60 fps', hint: 'AI draws in-between frames, fixes stutter', needs: meta => meta.interpolable},
  {key: 'upscale', label: 'AI upscale', hint: 'Redraws a small video in sharp 640 px. Slow: about 4 min per 10 s', needs: meta => Math.min(meta.width, meta.height) < 640},
  {key: 'metadata', label: 'Keep original metadata', hint: 'Date, camera, GPS: recipients see where it was filmed', needs: meta => Object.keys(meta.tags ?? {}).length > 0}
]
// [DOC: level-rows]
export const LEVELS = [
  // [DOC: hdr-slider]
  {key: 'look', label: 'HDR', min: 0, max: 1, steps: 100, zones: [
    {to: 0, hint: 'Off'}, {to: LOOK.HONEST, hint: 'Recovers highlights and shadows'}, {to: 1, hint: 'AI cleans noise, lifts the dark. Slower'}
  ]},
  // [DOC: exposure-slider]
  {key: 'exposure', label: 'Exposure', min: -2, max: 2, steps: 40, unit: 'EV', zones: [
    {to: -0.05, hint: 'Darker, colours kept'}, {to: 0, hint: 'Off'}, {to: 2, hint: 'Brighter, highlights protected'}
  ]},
  // [DOC: noise-slider]
  {key: 'denoise', label: 'Reduce noise', min: 0, max: 1, steps: 100, needs: meta => meta.has_audio, zones: [
    {to: 0, hint: 'Off'}, {to: 1, hint: 'AI keeps voices, cuts the rest, music too'}
  ]}
]
// [DOC: codec-picker]
export const CODECS = [
  {key: 'av1', label: 'AV1', hint: 'Most detail per MB'},
  {key: 'hevc', label: 'HEVC', hint: 'Hardware playback on every iPhone'},
  {key: 'vp9', label: 'VP9', hint: 'A little less detail per MB'}
]

const codecOf = key => CODECS.some(codec => codec.key === key) ? key : CODECS[0].key

export const optionsFor = (meta, options) => Object.fromEntries(OPTIONS.map(({key, needs}) => [key, Boolean(needs(meta) && options[key])]))
export const shows = (meta, {needs}) => !needs || needs(meta)
export const levelsFor = (meta, draft) => Object.fromEntries(LEVELS.map(level => [level.key, shows(meta, level) ? draft[level.key] : 0]))

// [DOC: editor-draft]
export const init = job => {
  const last = job?.request
  return {
    start: last?.start ?? 0, end: last?.end ?? ms(Math.min(job?.meta.duration ?? 0, job?.max_duration ?? 0)),
    time: last?.prompt.time ?? null, points: last?.prompt.points ?? [], box: last?.prompt.box ?? null,
    mask: last?.prompt.mask ?? null, options: {...last?.options}, codec: codecOf(last?.codec),
    ...Object.fromEntries(LEVELS.map(({key}) => [key, last?.[key] ?? 0])), posting: false, error: null
  }
}

// [DOC: square-source]
const optional = ({meta}, options) => meta.width === meta.height && !optionsFor(meta, options).zoom
const selected = ({start, end, time, points, box}) => (Boolean(box) || points.some(p => p[2] === 1)) && time !== null && time >= start && time <= end

export const isValid = (draft, job) => Boolean(job) && (draft.time === null ? optional(job, draft.options) : selected(draft))
  && draft.end - draft.start >= Math.min(MIN_RANGE, job.meta.duration) && draft.end - draft.start <= job.max_duration + 1e-6
