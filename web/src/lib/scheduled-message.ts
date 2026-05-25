export function parseScheduledPrefix(content: string): { taskName: string; body: string } | null {
  const m = content.match(/^\[scheduled:\s*([^\]]+)\]\n\n([\s\S]*)$/)
  return m ? { taskName: m[1].trim(), body: m[2] } : null
}
