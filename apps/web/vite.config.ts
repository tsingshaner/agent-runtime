import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    tanstackRouter({
      autoCodeSplitting: true,
      target: 'react'
    }),
    react({
      compiler: true
    }),
    tailwindcss()
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/auth': { changeOrigin: false, target: 'http://127.0.0.1:4310' },
      '/health': { changeOrigin: false, target: 'http://127.0.0.1:4310' },
      '/projects': { changeOrigin: false, target: 'http://127.0.0.1:4310' },
      '/runs': { changeOrigin: false, target: 'http://127.0.0.1:4310' },
      '/sessions': { changeOrigin: false, target: 'http://127.0.0.1:4310' },
      '/skills': { changeOrigin: false, target: 'http://127.0.0.1:4310' }
    },
    strictPort: true
  }
})
