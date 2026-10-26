import {existsSync} from 'node:fs'
import {defineConfig} from 'vite'

// [DOC: dev-plugin]
const DEV = new URL('dev/plugin.js', import.meta.url)
const dev = existsSync(DEV) && (await import(DEV.href)).default()

// [DOC: build-target]
const TARGET = ['safari18', 'chrome130']

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
      delete bundle[name]
    }
  }
}

// [DOC: relative-base]
export default defineConfig({
  base: './',
  plugins: [inlineCss, dev],
  // [DOC: preact]
  resolve: {alias: {'react-dom/client': 'preact/compat/client', 'react-dom': 'preact/compat', react: 'preact/compat'}},
  oxc: {jsx: {runtime: 'automatic', importSource: 'preact'}},
  build: {target: TARGET, modulePreload: {polyfill: false}}
})
