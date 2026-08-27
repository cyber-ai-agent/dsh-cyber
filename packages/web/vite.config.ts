import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['terminal.local', '127.0.0.1', 'localhost'],
    proxy: {
      '/api': 'http://127.0.0.1:43123',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: process.env.DSH_CYBER_SOURCEMAP === 'true',
  },
})
