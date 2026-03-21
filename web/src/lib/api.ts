export const HUB_URL = import.meta.env.VITE_HUB_URL || ''

export function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

export function hubFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${HUB_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(token), ...init?.headers },
  })
}
