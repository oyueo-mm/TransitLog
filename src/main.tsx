import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'
import { startSync } from './sync/instance'

// 오프라인 사용을 위한 서비스 워커. 새 버전은 다음 실행 때 자동으로 적용된다.
registerSW({ immediate: true })

// Google Drive 동기화(연결한 경우에만 동작)
startSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
