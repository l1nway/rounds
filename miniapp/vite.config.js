import react from '@vitejs/plugin-react'
import {defineConfig} from 'vite'

// [DOC: relative-base]
export default defineConfig({base: './', plugins: [react()]})
