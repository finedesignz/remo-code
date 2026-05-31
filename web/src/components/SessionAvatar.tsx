import { useState } from 'react'
import type { CodeSession } from '../hooks/useSessions'
import { githubOwnerRepo } from '../hooks/useSessions'
import { sessionLabel } from './SessionDropdown'

/**
 * SessionAvatar — a square per-project icon used in the COLLAPSED sidebar rail
 * (and anywhere a compact project glyph helps). Source priority:
 *
 *   1. GitHub owner avatar (`https://github.com/<owner>.png`) when the session
 *      is GitHub-keyed (`github_owner` known). This is a real square logo with
 *      no backend work. If it 404s/errors, we fall back to the monogram.
 *   2. Deterministic monogram — first 1–2 letters of the repo/folder name on a
 *      stable per-repo background hue (hash the label → hue). Always works,
 *      never blank, no network.
 *
 * Follow-up (NOT built here — needs supervisor+hub plumbing): extracting the
 * project's own on-disk favicon/logo. See report note.
 */

function hashHue(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 360
}

function monogram(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  if (!cleaned) return '?'
  const parts = cleaned.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return cleaned.slice(0, 2).toUpperCase()
}

interface Props {
  session: CodeSession
  /** Pixel size of the square (default 28). */
  size?: number
  className?: string
}

export function SessionAvatar({ session, size = 28, className = '' }: Props) {
  const [imgFailed, setImgFailed] = useState(false)
  const ownerRepo = githubOwnerRepo(session)
  const label = ownerRepo ?? sessionLabel(session)
  const owner = session.github_owner ?? null
  const avatarUrl = owner ? `https://github.com/${encodeURIComponent(owner)}.png?size=64` : null

  const box: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(6, Math.round(size * 0.28)),
  }

  if (avatarUrl && !imgFailed) {
    return (
      <img
        src={avatarUrl}
        alt={label}
        title={label}
        width={size}
        height={size}
        style={box}
        onError={() => setImgFailed(true)}
        className={`object-cover shrink-0 ${className}`}
      />
    )
  }

  const hue = hashHue(label || session.id)
  const mono: React.CSSProperties = {
    ...box,
    backgroundColor: `hsl(${hue} 55% 32%)`,
    color: '#fff',
    fontSize: Math.round(size * 0.4),
  }
  return (
    <span
      aria-label={label}
      title={label}
      style={mono}
      className={`inline-flex items-center justify-center font-semibold leading-none shrink-0 select-none ${className}`}
    >
      {monogram(label)}
    </span>
  )
}

export default SessionAvatar
