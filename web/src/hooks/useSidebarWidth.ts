import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Sidebar width with border-drag resize + localStorage persistence.
 *
 * The Sessions sidebar's RIGHT BORDER is itself the grab target (no visible
 * handle): `startResize` is wired to a thin invisible strip overlaying the
 * border that shows `cursor: col-resize`. Width clamps to [MIN, MAX] and is
 * persisted under `remo:sidebar-width` so it survives reload — mirroring the
 * existing `remo:sidebar-collapsed` pattern in ChatLayout.
 */
const STORAGE_KEY = 'remo:sidebar-width'
export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 520
export const SIDEBAR_DEFAULT_WIDTH = 288 // matches the old Tailwind w-72

function clamp(px: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)))
}

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const n = Number.parseInt(raw, 10)
      if (Number.isFinite(n)) return clamp(n)
    }
  } catch { /* ignore */ }
  return SIDEBAR_DEFAULT_WIDTH
}

export function useSidebarWidth() {
  const [width, setWidth] = useState<number>(readStored)
  const draggingRef = useRef(false)

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      // The sidebar's left edge is the viewport left (it's the first column),
      // so the drag width is simply the pointer's clientX.
      setWidth(clamp(ev.clientX))
    }
    const onUp = () => {
      draggingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
      setWidth((w) => {
        try { localStorage.setItem(STORAGE_KEY, String(w)) } catch { /* ignore */ }
        return w
      })
    }

    // Lock the cursor + disable selection for the whole drag (feels smooth and
    // prevents text-selection flicker over the chat panel).
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // Safety: clear listeners if the component unmounts mid-drag.
  useEffect(() => () => { draggingRef.current = false }, [])

  return { width, startResize }
}
