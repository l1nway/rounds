import assert from 'node:assert/strict'
import {grid, changes, sceneCuts} from '../miniapp/src/features/local/track-local.js'
import {solve, sampler} from '../miniapp/src/features/local/camera.js'

console.log('Testing track-local.js grid...')
const g1 = grid(2.0, 0.0, 10.0)
assert.equal(g1.rate, 10)
assert.equal(g1.index, 20)
assert.equal(g1.n, 101)
assert.equal(g1.t0, 0.0)

const g2 = grid(15.5, 5.0, 45.0)
// duration = 40s -> 40 * 10 = 400 > 360, 40 * 6 = 240 <= 360 -> rate = 6
assert.equal(g2.rate, 6)
console.log('Grid tests passed!')

console.log('Testing changes and sceneCuts...')
const hists = []
for (let i = 0; i < 50; i++) {
  const h = new Float32Array(512)
  if (i < 20) h[10] = 1.0
  else if (i < 35) h[200] = 1.0 // big change at frame 20
  else h[400] = 1.0 // big change at frame 35
  hists.push(h)
}
const d = changes(hists)
assert.equal(d[0], 0)
assert.equal(d[1], 0)
assert.equal(d[20], 1.0) // complete change
assert.equal(d[35], 1.0)
const cuts = sceneCuts(d)
console.log('Detected cuts:', cuts)
assert.deepEqual(cuts, [20, 35])
console.log('Scene cuts passed!')

console.log('Testing solve and sampler integration...')
const n = 60
const present = new Uint8Array(n).fill(1)
const cx = new Float64Array(n).fill(320)
const cy = new Float64Array(n).fill(240)
const r = new Float64Array(n).fill(50)
const area = new Float64Array(n).fill(2500)
const path = solve({present, cx, cy, r, area}, 640, 480, cuts)
assert.equal(path.length, n)
const at = sampler(path, cuts)
const f10 = at(10)
assert.equal(f10.length, 3)
console.log('Sample at frame 10:', f10)
console.log('All logic tests passed successfully!')
