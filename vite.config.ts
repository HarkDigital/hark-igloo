import { defineConfig } from 'vite'

// GitHub Pages serves from /<repo>/ — CI passes --base=/hark-igloo/.
export default defineConfig({
  server: { host: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
