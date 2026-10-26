import {MIN_RANGE, ms} from '../../hooks/player.js'

// [DOC: options-seam]
export const OPTIONS = [
  {key: 'loudnorm', label: 'Normalize loudness', hint: 'Evens out quiet and loud parts', needs: meta => meta.has_audio},
  {key: 'interpolate', label: 'Smooth to 60 fps', hint: 'AI draws in-between frames, fixes stutter', needs: meta => meta.interpolable},
  {key: 'upscale', label: 'AI upscale', hint: 'Redraws a small video in sharp 640 px. Slow: about 4 min per 10 s', needs: meta => Math.min(meta.width, meta.height) < 640},
  {key: 'metadata', label: 'Keep original metadata', hint: 'Date, camera, GPS: recipients see where it was filmed', needs: meta => Object.keys(meta.tags ?? {}).length > 0}
]
// [DOC: codec-picker]
export const CODECS = [
  {key: 'hevc', label: 'HEVC', hint: 'More detail per MB than H.264'},
  {key: 'av1', label: 'AV1', hint: 'Experimental: check that it arrives as a round'},
  {key: 'vp9', label: 'VP9', hint: 'Experimental: check that it arrives as a round'},
  {key: 'h266', label: 'H.266', hint: 'Experimental: slow to encode, hardly plays anywhere'}
]

const codecOf = key => CODECS.some(codec => codec.key === key) ? key : CODECS[0].key

export const optionsFor = (meta, options) => Object.fromEntries(OPTIONS.map(({key, needs}) => [key, Boolean(needs(meta) && options[key])]))

// [DOC: editor-draft]
export const init = job => {
  const last = job?.request
  return {
    start: last?.start ?? 0, end: last?.end ?? ms(Math.min(job?.meta.duration ?? 0, job?.max_duration ?? 0)),
    time: last?.prompt.time ?? null, points: last?.prompt.points ?? [], box: last?.prompt.box ?? null,
    mask: last?.prompt.mask ?? null, options: {...last?.options}, codec: codecOf(last?.codec), posting: false, error: null
  }
}

export const isValid = ({start, end, time, points, box}, job) => Boolean(job) && (Boolean(box) || points.some(p => p[2] === 1))
  && end - start >= Math.min(MIN_RANGE, job.meta.duration) && end - start <= job.max_duration + 1e-6
  && time !== null && time >= start && time <= end
