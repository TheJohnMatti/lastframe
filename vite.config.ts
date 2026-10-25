import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { syncPlugin } from './server/syncPlugin.ts'

// One fixed port: your library lives in this origin's localStorage, so a
// different port would open an empty one.
const port = 5178

export default defineConfig({
  plugins: [react(), syncPlugin()],
  base: './',
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
})
