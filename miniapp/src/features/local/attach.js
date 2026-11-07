// [DOC: local-attach]
const LABELS = {
  lift: ['Downloading selection model…', 'Preparing selection…', 'Selecting object…'],
  follow: ['Downloading tracking model…', 'Preparing tracking…', 'Tracking object…']
}
const NO_LOCAL = 'This step needs the server on this device'

const tracker = () => import('./track-local.js')

// [DOC: local-attach]
export const attachLocal = (source, {tier, confirm, server}) => {
  const local = (load, kind, route) => async (want, report) => {
    const [loading, preparing, busy] = LABELS[kind]
    const remote = server && (() => {report({label: busy}); return server(route, want)})
    const models = await import('./models.js')
    // [DOC: crash-route]
    if (models.localOff()) {if (remote) return remote(); throw new Error(NO_LOCAL)}
    // [DOC: speed-gate]
    if (kind === 'follow' && remote && tier === 'pro' && !models.fast()) return remote()
    const [run, {awake}] = await Promise.all([load(), import('./awake.js')])
    try {
      return await awake(() => run(source, want, {
        confirm: confirm(kind),
        onReady: () => report({label: preparing, share: 0}),
        onPrepare: share => report({label: preparing, share}),
        onLoaded: () => report({label: busy, share: kind === 'follow' ? 0 : undefined}),
        onProgress: info => report(info ? {label: loading, share: info.share} : {label: preparing, share: 0}),
        onTrack: share => report({label: busy, share})
      }))
    } catch (error) {
      if (remote && tier === 'pro') return remote()
      throw error
    }
  }
  const lift = local(() => import('./lift-local.js').then(module => module.segmentLocal), 'lift', 'segment')
  const follow = Object.assign(local(() => tracker().then(module => module.followLocal), 'follow', 'track'), {stop: () => tracker().then(module => module.stopFollow()), label: LABELS.follow[1]})
  return {lift, follow}
}
