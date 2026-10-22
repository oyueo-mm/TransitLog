import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // 상대 경로: 어떤 하위 경로에 배포해도(GitHub Pages 등) 동작한다. 라우팅은 HashRouter 를 쓴다.
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'TransitLog — 대중교통 탑승 기록',
        short_name: 'TransitLog',
        description: '지하철·버스 탑승을 빠르게 기록하고 분석하는 개인용 앱',
        lang: 'ko',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [{ name: '빠른 기록', short_name: '빠른 기록', url: './#/quick' }],
      },
      workbox: {
        // PDF 가져오기용 pdf.js 워커도 오프라인에서 쓸 수 있도록 미리 캐시한다
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,mjs}'],
      },
    }),
  ],
})
