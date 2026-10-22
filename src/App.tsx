import { useEffect } from 'react'
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom'
import { CalendarPage, DayPage } from './pages/CalendarPage'
import { ImportPage } from './pages/ImportPage'
import { QuickPage } from './pages/QuickPage'
import { SettingsPage } from './pages/SettingsPage'
import { StatsPage } from './pages/StatsPage'
import { TodayPage } from './pages/TodayPage'
import { TripEditorPage } from './pages/TripEditorPage'
import { ToastView } from './ui/common'
import { useToastHost } from './ui/hooks'

const NAV = [
  { to: '/', label: '오늘', icon: '🗓' },
  { to: '/quick', label: '빠른 기록', icon: '⚡' },
  { to: '/calendar', label: '캘린더', icon: '📅' },
  { to: '/stats', label: '통계', icon: '📊' },
  { to: '/settings', label: '설정·백업', icon: '⚙' },
]

function Shell() {
  const toastState = useToastHost()
  useEffect(() => {
    document.body.classList.toggle('has-toast', !!toastState?.action)
    return () => document.body.classList.remove('has-toast')
  }, [toastState])
  useEffect(() => {
    // 브라우저가 저장 공간 부족 시 데이터를 지우지 않도록 요청 (허용 여부는 브라우저가 결정)
    void navigator.storage?.persist?.().catch(() => undefined)
  }, [])
  return (
    <div className="app">
      <main id="main">
        <Routes>
          <Route path="/" element={<TodayPage />} />
          <Route path="/quick" element={<QuickPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/day/:date" element={<DayPage />} />
          <Route path="/trip/new" element={<TripEditorPage />} />
          <Route path="/trip/:id" element={<TripEditorPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="*" element={<TodayPage />} />
        </Routes>
      </main>
      <ToastView toast={toastState} />
      <nav className="bottom-nav" aria-label="주요 메뉴">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}>
            <span className="nav-icon" aria-hidden="true">
              {n.icon}
            </span>
            <span className="nav-label">{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  )
}
