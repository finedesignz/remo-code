import { Hono } from 'hono'

export const transcribe = new Hono()

const MAX_AUDIO_SIZE = 25 * 1024 * 1024 // OpenAI Whisper limit
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions'
const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1'

transcribe.post('/', async (c) => {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return c.json({
      error: 'Transcription unavailable: OPENAI_API_KEY is not configured on the server. Ask an admin to set it.',
    }, 503)
  }

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: 'Invalid multipart body' }, 400)
  }

  const audio = form.get('audio')
  if (!(audio instanceof File) && !(audio instanceof Blob)) {
    return c.json({ error: 'Missing "audio" file field' }, 400)
  }
  if (audio.size === 0) {
    return c.json({ error: 'Empty audio file' }, 400)
  }
  if (audio.size > MAX_AUDIO_SIZE) {
    return c.json({ error: `Audio exceeds 25MB limit (got ${audio.size} bytes)` }, 413)
  }

  const filename = (audio as File).name || 'recording.webm'
  const upstream = new FormData()
  upstream.append('file', audio, filename)
  upstream.append('model', MODEL)
  upstream.append('response_format', 'json')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
      signal: controller.signal,
    })
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      console.error('[transcribe] OpenAI error', resp.status, detail.slice(0, 200))
      return c.json({ error: `Transcription failed (${resp.status})` }, 502)
    }
    const data = await resp.json() as { text?: string }
    return c.json({ text: (data.text || '').trim() })
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return c.json({ error: 'Transcription timed out' }, 504)
    }
    console.error('[transcribe] error', err?.message)
    return c.json({ error: 'Transcription failed' }, 502)
  } finally {
    clearTimeout(timeout)
  }
})
