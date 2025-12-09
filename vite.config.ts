
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    legacy({
      targets: ['defaults', 'not IE 11'],
    })
  ],
  define: {
    'process.env.API_KEY': JSON.stringify("AIzaSyAwIwXUfcuSFW0b2j0iDLb_YWpSitGwqZg")
  },
  build: {
    cssCodeSplit: false,
  },
  base: './'
})
