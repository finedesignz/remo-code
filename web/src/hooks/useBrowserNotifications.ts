import { useEffect } from 'react'
import type { Profile } from './useProfile'

type Subscribe = (handler: (msg: any) => void) => () => void

interface Options {
  subscribe: Subscribe
  profile: Profile | null
}

/**
 * Side-effect hook: listens for `notification` WS events and fires a native
 * browser Notification when the page is hidden, the user has opted in
 * (`web_push_enabled`), and permission has been granted.
 *
 * In-app toasts handle visible-tab notifications elsewhere — this hook is
 * strictly for backgrounded tabs to avoid duplicates.
 */
export function useBrowserNotifications({ subscribe, profile }: Options) {
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (!profile?.web_push_enabled) return

    const unsubscribe = subscribe((msg) => {
      if (!msg || msg.type !== 'notification') return
      if (Notification.permission !== 'granted') return
      if (!document.hidden) return // visible tab → let in-app toast handle it

      const title: string = typeof msg.title === 'string' ? msg.title : 'Remo Code'
      const body: string = typeof msg.body === 'string' ? msg.body : ''
      const url: string | undefined = typeof msg.url === 'string' ? msg.url : undefined
      const tag: string = msg.run_id || msg.task_id || `${title}:${Date.now()}`

      try {
        const n = new Notification(title, { body, icon: '/favicon.svg', tag })
        n.onclick = () => {
          try { window.focus() } catch {}
          if (url) {
            try { window.location.href = url } catch {}
          }
          n.close()
        }
      } catch {
        // Some browsers throw if construction fails — silently ignore.
      }
    })

    return unsubscribe
  }, [subscribe, profile?.web_push_enabled])
}
