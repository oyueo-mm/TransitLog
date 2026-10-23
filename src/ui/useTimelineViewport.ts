import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { anchoredScroll, clampTimelineScale, fitScale } from '../domain/timelineLayout'

type View = 'focus' | 'full' | 'free'
type Anchor = { minute: number; pixel: number }

/** Keep native horizontal scrolling while adding anchored zoom and gestures. */
export function useTimelineViewport(scrollRef: RefObject<HTMLDivElement | null>, width: number, axisEnd: number, focusStart: number, focusEnd: number, date: string, enabled: boolean) {
  const [state, setState] = useState<{ scale: number; view: View }>({ scale: 1, view: 'focus' })
  const live = useRef({ scale: 1, view: 'focus' as View, width: 0, axisEnd, focusStart, focusEnd, date })
  const pending = useRef<Anchor | null>(null)

  const scroll = useCallback(() => pending.current
    ? anchoredScroll(pending.current.minute, pending.current.pixel, live.current.scale)
    : scrollRef.current?.scrollLeft ?? 0, [scrollRef])

  const update = useCallback((scale: number, view: View, anchor: Anchor) => {
    const cur = live.current
    const next = clampTimelineScale(scale, cur.width, cur.axisEnd)
    live.current = { ...cur, scale: next, view }
    pending.current = anchor
    setState({ scale: next, view })
  }, [])

  useLayoutEffect(() => {
    if (!width || !enabled) return
    const old = live.current
    const view = date !== old.date ? 'focus' : old.view
    const center = (scroll() + old.width / 2) / old.scale
    live.current = { ...old, width, axisEnd, focusStart, focusEnd, date }
    if (view === 'free') update(old.scale, view, { minute: center, pixel: width / 2 })
    else update(fitScale(width, view === 'full' ? 0 : focusStart, view === 'full' ? axisEnd : focusEnd), view, { minute: view === 'full' ? 0 : focusStart, pixel: 0 })
  }, [width, axisEnd, focusStart, focusEnd, date, scroll, update, enabled])

  useLayoutEffect(() => {
    const sc = scrollRef.current
    const anchor = pending.current
    if (!sc || !anchor || state.scale !== live.current.scale) return
    sc.scrollLeft = anchoredScroll(anchor.minute, anchor.pixel, state.scale)
    pending.current = null
  }, [state, width, scrollRef])

  const fit = useCallback((view: 'full' | 'focus') => {
    const cur = live.current
    update(fitScale(cur.width, view === 'full' ? 0 : cur.focusStart, view === 'full' ? cur.axisEnd : cur.focusEnd), view, { minute: view === 'full' ? 0 : cur.focusStart, pixel: 0 })
  }, [update])
  const zoom = useCallback((ratio: number, pixel?: number) => {
    const cur = live.current
    const at = pixel ?? cur.width / 2
    update(cur.scale * ratio, 'free', { minute: (scroll() + at) / cur.scale, pixel: at })
  }, [scroll, update])
  const pan = useCallback((pixels: number) => {
    live.current.view = 'free'
    setState(s => ({ ...s, view: 'free' }))
    scrollRef.current?.scrollBy({ left: pixels, behavior: 'smooth' })
  }, [scrollRef])

  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    let suppressClick = false
    let drag: { x: number; y: number; scroll: number; axis: 'pending' | 'x' | 'y' } | null = null
    let pinch: { distance: number; scale: number; minute: number } | null = null
    let mouse: { id: number; x: number; scroll: number } | null = null
    const relativeX = (x: number) => x - sc.getBoundingClientRect().left
    const startPan = () => {
      live.current.view = 'free'
      setState(s => s.view === 'free' ? s : { ...s, view: 'free' })
      sc.classList.add('is-dragging')
      suppressClick = true
    }
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return // ordinary wheel keeps scrolling the page
      e.preventDefault()
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? sc.clientHeight : 1)
      zoom(Math.exp(Math.max(-0.4, Math.min(0.4, -delta * 0.003))), relativeX(e.clientX))
    }
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      suppressClick = false
      mouse = { id: e.pointerId, x: e.clientX, scroll: sc.scrollLeft }
      // Capture after the drag threshold, so a simple tap still targets its bar.
    }
    const move = (e: PointerEvent) => {
      if (!mouse || mouse.id !== e.pointerId) return
      const dx = e.clientX - mouse.x
      if (Math.abs(dx) < 4 && !suppressClick) return
      e.preventDefault()
      sc.setPointerCapture(e.pointerId)
      startPan()
      sc.scrollLeft = mouse.scroll - dx
    }
    const up = (e: PointerEvent) => {
      if (mouse?.id !== e.pointerId) return
      if (sc.hasPointerCapture(e.pointerId)) sc.releasePointerCapture(e.pointerId)
      mouse = null
      sc.classList.remove('is-dragging')
    }
    const touchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        const [a, b] = [e.touches[0], e.touches[1]]
        const pixel = relativeX((a.clientX + b.clientX) / 2)
        pinch = { distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), scale: live.current.scale, minute: (scroll() + pixel) / live.current.scale }
        drag = null
        suppressClick = true
        if (e.cancelable) e.preventDefault()
      } else if (e.touches.length === 1) {
        const t = e.touches[0]
        drag = { x: t.clientX, y: t.clientY, scroll: sc.scrollLeft, axis: 'pending' }
        suppressClick = false
      }
    }
    const touchMove = (e: TouchEvent) => {
      if (pinch && e.touches.length >= 2) {
        if (e.cancelable) e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        update(pinch.scale * distance / pinch.distance, 'free', { minute: pinch.minute, pixel: relativeX((a.clientX + b.clientX) / 2) })
      } else if (drag && e.touches.length === 1) {
        const t = e.touches[0]
        const dx = t.clientX - drag.x
        const dy = t.clientY - drag.y
        if (drag.axis === 'pending' && Math.max(Math.abs(dx), Math.abs(dy)) > 6) drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
        if (drag.axis !== 'x') return // let vertical gestures scroll the page
        if (e.cancelable) e.preventDefault()
        startPan()
        sc.scrollLeft = drag.scroll - dx
      }
    }
    const touchEnd = (e: TouchEvent) => {
      pinch = null
      drag = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, scroll: sc.scrollLeft, axis: 'pending' } : null
      sc.classList.remove('is-dragging')
    }
    const click = (e: MouseEvent) => {
      if (!suppressClick) return
      e.preventDefault()
      e.stopPropagation()
      suppressClick = false
    }
    sc.addEventListener('wheel', wheel, { passive: false })
    sc.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    sc.addEventListener('touchstart', touchStart, { passive: false })
    sc.addEventListener('touchmove', touchMove, { passive: false })
    sc.addEventListener('touchend', touchEnd)
    sc.addEventListener('touchcancel', touchEnd)
    sc.addEventListener('click', click, true)
    return () => {
      sc.removeEventListener('wheel', wheel)
      sc.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      sc.removeEventListener('touchstart', touchStart)
      sc.removeEventListener('touchmove', touchMove)
      sc.removeEventListener('touchend', touchEnd)
      sc.removeEventListener('touchcancel', touchEnd)
      sc.removeEventListener('click', click, true)
    }
  }, [scrollRef, scroll, zoom, update, date, enabled])

  return { pxPerMin: state.scale, view: state.view, fit, zoom, pan, canZoomOut: state.scale > fitScale(Math.max(1, width), 0, axisEnd) + 0.00001, canZoomIn: state.scale < 120 }
}
