// Crypto helpers shared across hub modules.
// Kept dependency-free (Web Crypto only) so it can be imported from API routes,
// WS handlers, and middleware without pulling in channel/session code.

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
