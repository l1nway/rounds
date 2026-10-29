import {existsSync} from 'node:fs'
import {defineConfig} from 'vite'

// [DOC: dev-plugin]
const DEV = new URL('dev/plugin.js', import.meta.url)
const dev = existsSync(DEV) && (await import(DEV.href)).default()

// [DOC: build-target]
const TARGET = ['safari18', 'chrome130', 'firefox131']

// [DOC: launch-router]
const WEB = 'src/web.jsx'
const TELEGRAM = /<script src='https:\/\/telegram\.org\/[^']+'><\/script>\s*/
const MAIN = /<script type=["']module["'](?: crossorigin)? src=["'](?!\/@vite\/)([^"']+)["']><\/script>\s*/
const launch = {
  name: 'launch-router',
  transformIndexHtml: {order: 'post', handler: (html, {bundle}) => {
    const [main, src] = html.match(MAIN)
    const web = bundle && Object.values(bundle).find(chunk => chunk.isEntry && chunk.facadeModuleId?.endsWith(WEB))
    const deps = chunk => chunk.imports.flatMap(name => [name, ...deps(bundle[name])])
    const preload = [...new Set(web ? deps(web) : [])].filter(name => !html.includes(name)).map(name => `./${name}`)
    const miniapp = `<link rel="modulepreload" crossorigin href="${src}">${html.match(TELEGRAM)[0].trim()}${main.trim()}`
    return html.replace(TELEGRAM, '').replace(MAIN, '')
      .replace('__WEB__', () => JSON.stringify({entry: web ? `./${web.fileName}` : `/${WEB}`, preload}))
      .replace('__MINIAPP__', () => `\`${miniapp.replaceAll('</script>', '<\\/script>')}\``)
  }}
}

// [DOC: inline-css]
const inlineCss = {
  name: 'inline-css',
  apply: 'build',
  enforce: 'post',
  generateBundle(_, bundle) {
    const page = bundle['index.html']
    for (const name of Object.keys(bundle).filter(key => key.endsWith('.css'))) {
      const link = new RegExp(`<link rel="stylesheet"[^>]*href="\\./${name.replaceAll('.', '\\.')}"[^>]*>`)
      if (!link.test(page.source)) continue
      page.source = page.source.replace(link, () => `<style>${bundle[name].source}</style>`)
      // keep the file: dynamic-import preload maps still reference it (deleting it made them 404)
    }
  }
}

// [DOC: relative-base]
export default defineConfig({
  base: './',
  plugins: [launch, inlineCss, dev],
  // [DOC: preact]
  resolve: {alias: {'react-dom/client': 'preact/compat/client', 'react-dom': 'preact/compat', react: 'preact/compat'}},
  oxc: {jsx: {runtime: 'automatic', importSource: 'preact'}},
  build: {target: TARGET, modulePreload: {polyfill: false}, rolldownOptions: {input: ['index.html', WEB]}}
})
