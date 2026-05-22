import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/corpora':       'http://localhost:8000',
      '/documents':     'http://localhost:8000',
      '/chat':          'http://localhost:8000',
      '/vs-datastores': 'http://localhost:8000',
      '/vs-documents':  'http://localhost:8000',
      '/vs-chat':       'http://localhost:8000',
      '/fs-corpora':    'http://localhost:8000',
      '/fs-documents':  'http://localhost:8000',
      '/fs-chat':       'http://localhost:8000',
      '/vsr-corpora':   'http://localhost:8000',
      '/vsr-documents': 'http://localhost:8000',
      '/vsr-chat':      'http://localhost:8000',
    }
  }
})
