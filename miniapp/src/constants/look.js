// [DOC: look-mirror]
export const LOOK = {
  HONEST: 0.4, GRID: 256, RADIUS: 8, EPS: 0.3, SPREAD: 16, FLOOR: 2 ** -10, CLIP: [0.93, 0.985],
  PIVOT: Math.log2(0.18), LIFT: 0.75, DARK: [Math.log2(0.0005), Math.log2(0.008)],
  KNEE: Math.log2(0.3), WHITE: 0, TARGET: Math.log2(0.8), SOFT: 0.5, DETAIL: 0.2, SHOULDER: 0.9, TAU: 0.3,
  GAMMA: 2.4, HDR_PEAK: 1000, SDR_WHITE: 203, PQ: [2610 / 16384, 2523 / 4096 * 128, 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32],
  MOBIUS: 0.3, PROXY_PEAK: 10
}

// [DOC: stage-events]
export const STAGE_EVENTS = {ask: 'look-ask', paint: 'look-paint'}

export const split = value => [Math.min(value / LOOK.HONEST, 1), Math.max(value - LOOK.HONEST, 0) / (1 - LOOK.HONEST)]
