import {solve, sampler} from './src/features/local/camera.js'

// Suppose track found an object on IMG_5452:
// meta: width = 720, height = 1280
// Suppose object was detected at normalized coordinates:
// cx = 360, cy = 640, r = 100
const n = 142
const found = {
  present: new Uint8Array(n).fill(1),
  cx: new Float64Array(n).fill(360),
  cy: new Float64Array(n).fill(640),
  r: new Float64Array(n).fill(100),
  area: new Float64Array(n).fill(30000)
}

const path = solve(found, 720, 1280, [], 30, false)
const at = sampler(path, [])
console.log('Path[0]:', path[0])
console.log('at(0):', at(0))

