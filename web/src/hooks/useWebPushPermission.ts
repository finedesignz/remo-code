import { useCallback, useEffect, useState } from 'react'

const isSupported = typeof window !== 'undefined' && 'Notification' in window

function currentPermission(): NotificationPermission {
  if (!isSupported) return 'denied'
  return Notification.permission
}

export function useWebPushPermission() {
  const [permission, setPermission] = useState<NotificationPermission>(currentPermission)

  useEffect(() => {
    if (!isSupported) return
    const onFocus = () => setPermission(Notification.permission)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const request = useCallback(async (): Promise<NotificationPermission> => {
    if (!isSupported) return 'denied'
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
      return result
    } catch {
      const fallback = Notification.permission
      setPermission(fallback)
      return fallback
    }
  }, [])

  return { permission, request, isSupported }
}
