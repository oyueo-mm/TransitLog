import { defineConfig } from '@playwright/test'

// 빌드한 결과물(서비스 워커 포함)을 그대로 띄워 실제 PWA 와 같은 조건에서 검증한다.
// 브라우저가 없다면: npx playwright install chromium  (또는 PW_CHANNEL=msedge 로 설치된 Edge 사용)
const channel = process.env.PW_CHANNEL || undefined

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/',
    channel,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile-360',
      testIgnore: /desktop.spec.ts/,
      use: { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 } },
      testMatch: /desktop\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    reuseExistingServer: true,
    timeout: 180_000,
  },
})
