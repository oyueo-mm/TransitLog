import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
const BASE = process.env.VITE_BASE ?? '/TransitLog/'

export default defineConfig({
  // GitHub Pages 프로젝트 사이트: https://oyueo-mm.github.io/TransitLog/
  // 라우팅은 HashRouter 라 별도의 404 리다이렉트가 필요 없다. 다른 경로에 배포하려면 VITE_BASE 로 바꾼다.
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      // 서비스 워커는 base(/TransitLog/) 아래에서 같은 범위로 등록된다
      manifest: {
        name: 'TransitLog — 대중교통 탑승 기록',
        short_name: 'TransitLog',
        description: '지하철·버스 탑승을 빠르게 기록하고 분석하는 개인용 앱',
        lang: 'ko',
        id: BASE,
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [{ name: '빠른 기록', short_name: '빠른 기록', url: `${BASE}#/quick` }],
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
