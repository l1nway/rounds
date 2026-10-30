const DB = 'rounds-stage-cache-v1'
const CAP = 400_000_000
const VERSION = 1

export const identity = file => [file.name, file.size, file.lastModified]

const hexOf = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('')
const keyOf = async parts => hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([VERSION, ...parts]))))
const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = tx.onerror = () => reject(tx.error)
})
const result = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

let opened = null
const open = () => opened ??= new Promise((resolve, reject) => {
  const req = indexedDB.open(DB, 1)
  req.onupgradeneeded = () => {req.result.createObjectStore('meta', {keyPath: 'key'}); req.result.createObjectStore('data')}
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

// [DOC: stage-cache]
const sizeOf = value => {
  const planes = Array.isArray(value) ? value : Object.values(value)
  return planes.reduce((sum, plane) => sum + (plane?.byteLength ?? sizeOf(plane)), 0)
}

const read = async key => {
  const db = await open()
  const value = await result(db.transaction('data').objectStore('data').get(key))
  if (value === undefined) return undefined
  const tx = db.transaction('meta', 'readwrite'), store = tx.objectStore('meta')
  const meta = await result(store.get(key))
  if (meta) store.put({...meta, used: Date.now()})
  await done(tx).catch(() => {})
  return value
}

const write = async (key, value, cap) => {
  const size = sizeOf(value)
  if (size > cap) return
  const db = await open()
  const metas = await result(db.transaction('meta').objectStore('meta').getAll())
  let total = metas.reduce((sum, m) => m.key === key ? sum : sum + m.size, 0) + size
  const drop = []
  for (const m of metas.sort((a, b) => a.used - b.used)) {
    if (total <= cap) break
    if (m.key !== key) {drop.push(m.key); total -= m.size}
  }
  const tx = db.transaction(['meta', 'data'], 'readwrite')
  for (const k of drop) {tx.objectStore('meta').delete(k); tx.objectStore('data').delete(k)}
  tx.objectStore('data').put(value, key)
  tx.objectStore('meta').put({key, size, used: Date.now()})
  await done(tx)
}

export const stage = async (parts, make, onHit, cap = CAP) => {
  let key = null
  try {
    key = await keyOf(parts)
    const hit = await read(key)
    if (hit !== undefined) {onHit?.(); return hit}
  } catch {key = null}
  const value = await make()
  if (key && value) await write(key, value, cap).catch(() => {})
  return value
}
