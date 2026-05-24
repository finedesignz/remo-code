import { useState, useEffect, useRef, useCallback } from 'react'
import type { ChatMessage } from '../hooks/useChat'
import type { ActivityState } from '../hooks/useActivity'
import { MessageBubble } from './MessageBubble'
import { ActivityFeed } from './ActivityFeed'
import { FileAttachmentBar, type AttachedFile } from './FileAttachmentBar'

interface Props {
  messages: ChatMessage[]
  loading: boolean
  onSend: (content: string, images?: Array<{ media_type: string; data: string }>) => void
  activeSessionId: string | null
  sessionStatus?: string
  activity: ActivityState
  onPermissionRespond: (requestId: string, approved: boolean) => void
  onQuestionRespond: (requestId: string, answer: string) => void
  token?: string
  wsConnected?: boolean
}

interface SlashItem {
  kind: 'command' | 'skill'
  name: string
  description: string | null
  source: string
}

const MAX_FILES = 5
const MAX_TEXT_SIZE = 1024 * 1024       // 1 MB
const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10 MB
const MAX_DRAFT_SIZE = 16 * 1024        // 16 KB per-session draft cap
const draftKey = (sid: string) => `remo:draft:${sid}`

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

function fileToBase64(file: File): Promise<{ media_type: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      // dataUrl format: data:<media_type>;base64,<data>
      const [header, data] = dataUrl.split(',')
      const media_type = header.split(':')[1].split(';')[0]
      resolve({ media_type, data })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function classifyFile(file: File): 'text' | 'image' | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('text/') || file.name.match(/\.(txt|md|json|csv|log|xml|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|fish|ps1|bat|cmd|ts|tsx|js|jsx|py|rb|rs|go|java|c|cpp|h|hpp|cs|swift|kt|scala|sql|html|css|scss|less|svg)$/i)) return 'text'
  return null
}

export function ChatPanel({ messages, loading, onSend, activeSessionId, sessionStatus, activity, onPermissionRespond, onQuestionRespond, token, wsConnected = true }: Props) {
  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [slashItems, setSlashItems] = useState<SlashItem[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  const [slashOpen, setSlashOpen] = useState(false)
  const slashSuppressedRef = useRef(false)

  // Voice recording state
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [recError, setRecError] = useState<string | null>(null)
  const [recElapsed, setRecElapsed] = useState(0)
  const mediaRecRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recCancelledRef = useRef(false)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recHardStopRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const REC_MAX_MS = 5 * 60 * 1000

  // True if input ends with an unfinished slash token (e.g. "/foo" or "/" or "hi /bar"),
  // i.e. a "/" that starts the input or follows whitespace, with no space after it.
  function hasUnfinishedSlashToken(s: string): boolean {
    const m = s.match(/(^|\s)\/([\w.:-]*)$/)
    return !!m
  }

  // Load synced commands once per session
  useEffect(() => {
    if (!token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/commands`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : { commands: [] })
      .then((d) => setSlashItems(d.commands || []))
      .catch(() => {})
  }, [token])

  const slashMatch = (() => {
    // Only treat as slash trigger when input is a bare unfinished slash token at the start
    // (e.g. "/foo"). Once user types a space after the token ("/foo bar"), we stop matching.
    const m = input.match(/^\/([\w.:-]*)$/)
    if (!m) return null
    const q = m[1].toLowerCase()
    const matches = slashItems
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 8)
    return { query: q, matches }
  })()
  const slashVisible = slashOpen && !!slashMatch && slashMatch.matches.length > 0

  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottom = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [newCount, setNewCount] = useState(0)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
    isNearBottom.current = true
    setNewCount(0)
  }, [])

  function applySlash(item: SlashItem) {
    const rest = input.replace(/^\/[\w.:-]*/, '')
    const next = `/${item.name}${rest.startsWith(' ') ? '' : ' '}${rest}`
    const caret = item.name.length + 2 // '/' + name + ' '
    setInput(next)
    setSlashOpen(false)
    slashSuppressedRef.current = true // latch closed; do not reopen on the next render
    setSlashIdx(0)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(caret, caret)
    })
  }

  // Track whether user is anchored near bottom (~80px window)
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const anchored = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    isNearBottom.current = anchored
    if (anchored) setNewCount(0)
  }, [])

  // On new messages/activity: scroll only if anchored; else count unseen messages
  const prevMsgCountRef = useRef(messages.length)
  useEffect(() => {
    const delta = messages.length - prevMsgCountRef.current
    prevMsgCountRef.current = messages.length
    if (isNearBottom.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    } else if (delta > 0) {
      setNewCount((c) => c + delta)
    }
  }, [messages, sessionStatus, activity])

  // Always scroll to bottom on session switch — runs after DOM commit, and again
  // when loading flips false so the freshly-rendered messages land at the bottom.
  useEffect(() => {
    isNearBottom.current = true
    setNewCount(0)
    prevMsgCountRef.current = messages.length
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, loading])

  // Clear attachments on session switch
  useEffect(() => {
    setAttachedFiles([])
  }, [activeSessionId])

  // Track previous session id and latest input value for synchronous flush on switch
  const prevSessionIdRef = useRef<string | null>(null)
  const inputRef = useRef('')
  useEffect(() => { inputRef.current = input }, [input])

  // Load persisted draft on mount / session switch.
  // CRITICAL: flush the outgoing session's pending text synchronously BEFORE loading
  // the new draft, so text typed within the debounce window isn't lost — and so the
  // new session's input is set unconditionally (empty string clears A's leftover text).
  useEffect(() => {
    const outgoing = prevSessionIdRef.current
    if (outgoing && outgoing !== activeSessionId) {
      try {
        const pending = inputRef.current
        if (pending && pending.trim()) {
          localStorage.setItem(draftKey(outgoing), pending.slice(0, MAX_DRAFT_SIZE))
        } else {
          localStorage.removeItem(draftKey(outgoing))
        }
      } catch {}
    }
    prevSessionIdRef.current = activeSessionId

    if (!activeSessionId) {
      setInput('')
      slashSuppressedRef.current = true
      setSlashOpen(false)
      return
    }
    let saved = ''
    try {
      saved = localStorage.getItem(draftKey(activeSessionId)) ?? ''
    } catch {
      saved = ''
    }
    setInput(saved) // unconditional — empty string clears prior session's text
    inputRef.current = saved
    // Only reopen the dropdown if the restored draft is still an unfinished slash token
    // (e.g. "/gsd-pl") — not when the user already typed past it ("/gsd-plan-phase do stuff").
    if (/^\/[\w.:-]*$/.test(saved)) {
      slashSuppressedRef.current = false
      setSlashOpen(true)
    } else {
      slashSuppressedRef.current = true
      setSlashOpen(false)
    }
  }, [activeSessionId])

  // Debounced persist of input to localStorage (text only). Guard with the session id
  // captured at effect-creation so a pending timer can never write to the wrong key
  // after a session switch.
  useEffect(() => {
    if (!activeSessionId) return
    const sid = activeSessionId
    const key = draftKey(sid)
    const t = setTimeout(() => {
      try {
        if (!input) { localStorage.removeItem(key); return }
        let value = input
        if (value.length > MAX_DRAFT_SIZE) {
          console.warn(`[remo] draft for ${sid} exceeds ${MAX_DRAFT_SIZE}B; truncating`)
          value = value.slice(0, MAX_DRAFT_SIZE)
        }
        localStorage.setItem(key, value)
      } catch {}
    }, 200)
    return () => clearTimeout(t)
  }, [input, activeSessionId])

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    setAttachedFiles(prev => {
      const remaining = MAX_FILES - prev.length
      if (remaining <= 0) return prev

      const toAdd: AttachedFile[] = []
      for (const file of files.slice(0, remaining)) {
        const type = classifyFile(file)
        if (!type) continue
        if (type === 'text' && file.size > MAX_TEXT_SIZE) continue
        if (type === 'image' && file.size > MAX_IMAGE_SIZE) continue
        toAdd.push({ file, type })
      }
      return [...prev, ...toAdd]
    })
  }, [])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer?.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }, [addFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index))
  }, [])

  const cleanupRecording = useCallback(() => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null }
    if (recHardStopRef.current) { clearTimeout(recHardStopRef.current); recHardStopRef.current = null }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop())
      mediaStreamRef.current = null
    }
    mediaRecRef.current = null
    audioChunksRef.current = []
    setRecording(false)
    setRecElapsed(0)
  }, [])

  const startRecording = useCallback(async () => {
    if (recording || transcribing) return
    setRecError(null)
    // Pause slash autocomplete while recording
    slashSuppressedRef.current = true
    setSlashOpen(false)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '')
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaRecRef.current = rec
      audioChunksRef.current = []
      recCancelledRef.current = false
      rec.ondataavailable = (ev) => { if (ev.data.size > 0) audioChunksRef.current.push(ev.data) }
      rec.onstop = async () => {
        const chunks = audioChunksRef.current.slice()
        const wasCancelled = recCancelledRef.current
        const type = rec.mimeType || 'audio/webm'
        cleanupRecording()
        if (wasCancelled || chunks.length === 0) return
        const blob = new Blob(chunks, { type })
        await transcribeBlob(blob, type)
      }
      rec.start()
      setRecording(true)
      setRecElapsed(0)
      const startedAt = Date.now()
      recTimerRef.current = setInterval(() => setRecElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250)
      recHardStopRef.current = setTimeout(() => {
        if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') mediaRecRef.current.stop()
      }, REC_MAX_MS)
    } catch (err: any) {
      console.error('[remo] mic error', err)
      setRecError(err?.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Microphone unavailable')
      cleanupRecording()
    }
  }, [recording, transcribing, cleanupRecording])

  const stopRecording = useCallback((cancel = false) => {
    recCancelledRef.current = cancel
    const rec = mediaRecRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    else cleanupRecording()
  }, [cleanupRecording])

  const transcribeBlob = useCallback(async (blob: Blob, type: string) => {
    if (!token) { setRecError('Not authenticated'); return }
    setTranscribing(true)
    setRecError(null)
    try {
      const hubUrl = import.meta.env.VITE_HUB_URL || ''
      const ext = type.includes('webm') ? 'webm' : (type.includes('mp4') || type.includes('m4a') ? 'm4a' : 'webm')
      const fd = new FormData()
      fd.append('audio', blob, `recording.${ext}`)
      const resp = await fetch(`${hubUrl}/api/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      })
      const data = await resp.json().catch(() => ({} as any))
      if (!resp.ok) {
        setRecError(data?.error || `Transcription failed (${resp.status})`)
        return
      }
      const text = (data.text || '').trim()
      if (!text) { setRecError('No speech detected'); return }
      setInput(prev => prev ? `${prev}${prev.endsWith(' ') ? '' : ' '}${text}` : text)
      requestAnimationFrame(() => textareaRef.current?.focus())
    } catch (err: any) {
      console.error('[remo] transcribe error', err)
      setRecError('Network error during transcription')
    } finally {
      setTranscribing(false)
    }
  }, [token])

  // Cleanup recorder on unmount
  useEffect(() => () => {
    if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') {
      recCancelledRef.current = true
      mediaRecRef.current.stop()
    }
    cleanupRecording()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if ((!input.trim() && attachedFiles.length === 0) || !activeSessionId) return

    let content = ''
    const images: Array<{ media_type: string; data: string }> = []

    // Process text files
    for (const f of attachedFiles) {
      if (f.type === 'text') {
        const text = await readFileAsText(f.file)
        content += `[Attached file: ${f.file.name}]\n${text}\n\n`
      } else if (f.type === 'image') {
        const img = await fileToBase64(f.file)
        images.push(img)
      }
    }

    content += input.trim()
    // Ensure content is non-empty (hub requires min 1 char)
    if (!content && images.length > 0) {
      content = '[Image attached]'
    }
    if (!content) return
    onSend(content, images.length > 0 ? images : undefined)
    try { localStorage.removeItem(draftKey(activeSessionId)) } catch {}
    setInput('')
    setAttachedFiles([])
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashVisible) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => Math.min(slashMatch!.matches.length - 1, i + 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx((i) => Math.max(0, i - 1)); return }
      if (e.key === 'Escape')    { e.preventDefault(); setSlashOpen(false); slashSuppressedRef.current = true; return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        applySlash(slashMatch!.matches[slashIdx])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
        Select a session from the sidebar to start chatting
      </div>
    )
  }

  return (
    <div
      className="flex-1 flex flex-col min-h-0 relative"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 space-y-3 chat-scroll"
      >
        {loading && (
          <div className="text-center text-[var(--text-muted)] text-sm py-4">Loading messages...</div>
        )}
        {!loading && messages.length === 0 && (
          <div className="text-center text-[var(--text-muted)] text-sm py-8">
            No messages yet. Send a message to Claude.
          </div>
        )}
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Activity feed (live streaming from agent) */}
        <ActivityFeed activity={activity} onPermissionRespond={onPermissionRespond} onQuestionRespond={onQuestionRespond} />
      </div>

      {newCount > 0 && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-xs text-[var(--text-on-accent)] shadow-lg ring-1 ring-indigo-500/30 z-10"
        >
          ↓ {newCount} new
        </button>
      )}

      <form onSubmit={handleSubmit} className="border-t border-[var(--border-color)]">
        {!wsConnected && (
          <div className="px-4 py-1.5 text-xs text-amber-400 bg-amber-500/10 border-b border-[var(--border-color)]">
            Reconnecting… your message will send once the connection is back.
          </div>
        )}
        <FileAttachmentBar files={attachedFiles} onRemove={handleRemoveFile} />
        {(recording || transcribing || recError) && (
          <div className="px-4 py-1.5 text-xs flex items-center gap-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/40">
            {recording && (
              <>
                <span className="inline-flex items-center gap-1.5 text-red-400">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  Recording {String(Math.floor(recElapsed / 60)).padStart(1, '0')}:{String(recElapsed % 60).padStart(2, '0')}
                </span>
                <button type="button" onClick={() => stopRecording(true)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
              </>
            )}
            {!recording && transcribing && <span className="text-[var(--text-muted)]">Transcribing…</span>}
            {!recording && !transcribing && recError && (
              <span className="text-red-400 flex items-center gap-2">
                {recError}
                <button type="button" onClick={() => setRecError(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">dismiss</button>
              </span>
            )}
          </div>
        )}
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex gap-2 items-end">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-2.5 text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors shrink-0 rounded-lg hover:bg-[var(--bg-tertiary)]/50"
              title="Attach files"
              aria-label="Attach files"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15.5 9.2L9.2 15.5a3.5 3.5 0 0 1-5-5L10.9 3.8a2.3 2.3 0 1 1 3.3 3.3L7.5 13.8a1.2 1.2 0 0 1-1.7-1.7l6-6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => (recording ? stopRecording(false) : startRecording())}
              disabled={!wsConnected || transcribing}
              className={`p-2.5 transition-colors shrink-0 rounded-lg hover:bg-[var(--bg-tertiary)]/50 disabled:opacity-40 ${recording ? 'text-red-400' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}
              title={recording ? 'Stop recording' : 'Record voice message'}
              aria-label={recording ? 'Stop recording' : 'Record voice message'}
            >
              {recording ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse">
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                  <path d="M5 10v2a7 7 0 0 0 12 5" />
                  <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              )}
            </button>
            <div className="flex-1 relative">
              {slashVisible && (
                <div className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto rounded-lg bg-[var(--bg-secondary)] shadow-xl ring-1 ring-[var(--border-color)] z-10">
                  {slashMatch!.matches.map((it, i) => (
                    <button
                      key={`${it.kind}:${it.name}:${it.source}`}
                      type="button"
                      onMouseEnter={() => setSlashIdx(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applySlash(it)}
                      className={`w-full text-left px-3 py-2 text-sm ${i === slashIdx ? 'bg-indigo-600/20 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'}`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono">/{it.name}</span>
                        <span className="text-[10px] text-[var(--text-muted)] uppercase">{it.kind}</span>
                        <span className="text-[10px] text-[var(--text-muted)] truncate">{it.source}</span>
                      </div>
                      {it.description && <div className="text-xs text-[var(--text-muted)] truncate">{it.description}</div>}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => {
                  const v = e.target.value
                  setInput(v)
                  const unfinished = hasUnfinishedSlashToken(v)
                  // Clear the suppression latch only when the user has edited away from
                  // a slash token entirely (so a fresh "/" later can reopen the menu).
                  if (!unfinished) slashSuppressedRef.current = false
                  if (unfinished && !slashSuppressedRef.current && /^\/[\w.:-]*$/.test(v)) {
                    setSlashOpen(true); setSlashIdx(0)
                  } else {
                    setSlashOpen(false)
                  }
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => {
                  if (!slashSuppressedRef.current && /^\/[\w.:-]*$/.test(input)) setSlashOpen(true)
                }}
                placeholder="Send a message to Claude... (type / for commands)"
                rows={1}
                className="w-full px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none max-h-32"
              />
            </div>
            <button
              type="submit"
              disabled={!input.trim() && attachedFiles.length === 0}
              className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors shrink-0"
            >
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
