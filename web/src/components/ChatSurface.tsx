import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ChatMessage } from '../hooks/useChat'
import type { ActivityState } from '../hooks/useActivity'
import { useChatSurface } from '../hooks/useChatSurface'
import { MessageBubble } from './MessageBubble'
import { ActivityFeed } from './ActivityFeed'
import { FileAttachmentBar, type AttachedFile } from './FileAttachmentBar'

export type ChatSurfaceDensity = 'full' | 'cell' | 'mobile-expanded'

export interface SlashItem {
  kind: 'command' | 'skill'
  name: string
  description: string | null
  source: string
}

/**
 * <ChatSurface>
 *
 * Self-contained chat surface for ONE session. Three density variants:
 *  - `full`           — the single-chat page chrome (current ChatPanel look)
 *  - `cell`           — compact grid cell (smaller fonts, slim input, ≤30 initial msgs)
 *  - `mobile-expanded`— square (`aspect-ratio:1/1`) with input pinned to bottom; `100dvh` cap
 *
 * Data ownership:
 *  - When `seedMessages`/`activity`/`onSend` props are provided (full mode used by
 *    `<ChatPanel>` wrapper), the parent owns data — surface is purely presentational.
 *  - Otherwise (cell, mobile-expanded), the surface self-owns data via
 *    `useChatSurface(sessionId)`. Each instance subscribes for its sessionId.
 *
 * Streaming: text_delta events are RAF-coalesced inside `useChatSurface`.
 * Virtualization: the message list uses `@tanstack/react-virtual` for ALL densities.
 */
interface BaseProps {
  sessionId: string | null
  density: ChatSurfaceDensity
  wsConnected?: boolean
  online?: boolean
  token?: string
  className?: string
  /** Fires when this surface is interacted with (focus/click). Used by GridPage. */
  onActivate?: () => void
  /** Parent-owned cancel handler (used by ChatPanel/Layout for density="full"). */
  onCancel?: () => void
}

interface OwnedDataProps {
  /** Provided: parent owns the data layer. Used by ChatPanel for density="full". */
  messages: ChatMessage[]
  loading: boolean
  activity: ActivityState
  onSend: (content: string, images?: Array<{ media_type: string; data: string }>) => void
  onPermissionRespond: (requestId: string, approved: boolean) => void
  onQuestionRespond: (requestId: string, answer: string) => void
  subscribe?: undefined
  send?: undefined
  connectionId?: undefined
  seedMessages?: undefined
}

interface SelfOwnedDataProps {
  /** Required for self-owned: WS hook tuple from useWebSocket(). */
  subscribe: (handler: (msg: any) => void) => () => void
  send: (msg: object) => void
  connectionId: number
  seedMessages?: ChatMessage[]
  messages?: undefined
  loading?: undefined
  activity?: undefined
  onSend?: undefined
  onPermissionRespond?: undefined
  onQuestionRespond?: undefined
}

export type ChatSurfaceProps = BaseProps & (OwnedDataProps | SelfOwnedDataProps)

const MAX_FILES = 5
const MAX_TEXT_SIZE = 1024 * 1024
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const MAX_DRAFT_SIZE = 16 * 1024
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

// Density-driven Tailwind class bundles. Kept inline for grep-ability.
// btnSquare matches textarea height so attach/mic/send/stop align cleanly.
const densityClasses = {
  full: {
    root: 'flex-1 flex flex-col min-h-0 relative',
    list: 'flex-1 overflow-y-auto p-4 chat-scroll',
    rowGap: 12, // px gap between rows
    estimateRow: 84,
    bubbleSize: 'text-sm',
    inputPad: 'p-4 pb-[max(1rem,env(safe-area-inset-bottom))]',
    textarea: 'w-full px-4 py-2.5 text-sm h-10',
    sendBtn: 'h-10 px-5 text-sm',
    btnSquare: 'h-10 w-10',
    iconSize: 18,
    showHeader: false, // ChatPanel renders the page header
    emptyText: 'text-sm py-8',
  },
  cell: {
    root: 'flex flex-col min-h-0 relative h-full rounded-xl bg-[var(--bg-secondary)]/60 overflow-hidden',
    list: 'flex-1 overflow-y-auto px-2 py-2 chat-scroll',
    rowGap: 6,
    estimateRow: 64,
    bubbleSize: 'text-[12px]',
    inputPad: 'p-2',
    textarea: 'w-full px-2 py-1.5 text-[12px] h-8',
    sendBtn: 'h-8 px-3 text-[12px]',
    btnSquare: 'h-8 w-8',
    iconSize: 14,
    showHeader: true,
    emptyText: 'text-xs py-4',
  },
  'mobile-expanded': {
    root: 'flex flex-col min-h-0 relative w-full rounded-xl bg-[var(--bg-secondary)]/60 overflow-hidden',
    list: 'flex-1 overflow-y-auto p-3 chat-scroll',
    rowGap: 8,
    estimateRow: 72,
    bubbleSize: 'text-[13px]',
    inputPad: 'p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
    textarea: 'w-full px-3 py-2 text-[13px] h-9',
    sendBtn: 'h-9 px-4 text-[13px]',
    btnSquare: 'h-9 w-9',
    iconSize: 16,
    showHeader: true,
    emptyText: 'text-xs py-6',
  },
} as const

export function ChatSurface(props: ChatSurfaceProps) {
  const { sessionId, density, wsConnected = true, online = true, token, className, onActivate, onCancel } = props
  const isParentOwned = 'messages' in props && props.messages !== undefined
  const d = densityClasses[density]

  // Unified cancel handler — parent-owned routes through onCancel prop;
  // self-owned uses the `send` already in props to fire {type:'cancel',session_id}.
  const handleCancel = useCallback(() => {
    if (!sessionId) return
    if (isParentOwned) {
      onCancel?.()
    } else {
      ;(props as SelfOwnedDataProps).send({ type: 'cancel', session_id: sessionId })
    }
  }, [sessionId, isParentOwned, onCancel, props])

  // Self-owned data path
  const selfOwned = useChatSurface({
    sessionId,
    token: token ?? '',
    subscribe: isParentOwned ? (() => () => {}) : props.subscribe!,
    send: isParentOwned ? (() => {}) : props.send!,
    connectionId: isParentOwned ? 0 : props.connectionId!,
    seedMessages: isParentOwned ? undefined : props.seedMessages,
  })

  const messages: ChatMessage[] = isParentOwned ? (props as OwnedDataProps).messages : selfOwned.messages
  const loading: boolean = isParentOwned ? (props as OwnedDataProps).loading : selfOwned.loading
  const activity: ActivityState = isParentOwned ? (props as OwnedDataProps).activity : selfOwned.activity
  const onSend = isParentOwned
    ? (props as OwnedDataProps).onSend
    : selfOwned.sendMessage
  const onPermissionRespond = isParentOwned
    ? (props as OwnedDataProps).onPermissionRespond
    : selfOwned.respondPermission
  const onQuestionRespond = isParentOwned
    ? (props as OwnedDataProps).onQuestionRespond
    : selfOwned.respondQuestion

  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [slashItems, setSlashItems] = useState<SlashItem[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  const [slashOpen, setSlashOpen] = useState(false)
  const slashSuppressedRef = useRef(false)

  // Voice recording state (only meaningful in `full` density — keep wiring identical)
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

  function hasUnfinishedSlashToken(s: string): boolean {
    const m = s.match(/(^|\s)\/([\w.:-]*)$/)
    return !!m
  }

  // Load synced commands once per token
  useEffect(() => {
    if (!token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/commands`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' })
      .then(r => r.ok ? r.json() : { commands: [] })
      .then(d => setSlashItems(d.commands || []))
      .catch(() => {})
  }, [token])

  const slashMatch = (() => {
    const m = input.match(/^\/([\w.:-]*)$/)
    if (!m) return null
    const q = m[1].toLowerCase()
    const matches = slashItems
      .filter(c => c.name.toLowerCase().includes(q))
      .slice(0, 8)
    return { query: q, matches }
  })()
  const slashVisible = slashOpen && !!slashMatch && slashMatch.matches.length > 0

  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottom = useRef(true)
  const forceBottomRef = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [newCount, setNewCount] = useState(0)

  // ---- Virtualizer over the message list ----
  // Activity feed is rendered as an extra "row" after the last message so the
  // virtualizer's scroll math accounts for it.
  const rowCount = messages.length + 1 // +1 for activity feed slot

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => d.estimateRow,
    overscan: 6,
    gap: d.rowGap,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

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
    const caret = item.name.length + 2
    setInput(next)
    setSlashOpen(false)
    slashSuppressedRef.current = true
    setSlashIdx(0)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(caret, caret)
    })
  }

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const anchored = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    isNearBottom.current = anchored
    if (anchored) setNewCount(0)
  }, [])

  // Auto-scroll on new messages/activity. Always run inside rAF so layout
  // settles before we measure scrollHeight. Forced/anchored scroll never
  // depends on a stale prevMsgCountRef — only the "↓ N new" badge does.
  const prevMsgCountRef = useRef(messages.length)
  useEffect(() => {
    const delta = messages.length - prevMsgCountRef.current
    prevMsgCountRef.current = messages.length

    if (forceBottomRef.current || isNearBottom.current) {
      const raf = requestAnimationFrame(() => {
        const node = scrollRef.current
        if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'auto' })
      })
      if (forceBottomRef.current && messages.length > 0) forceBottomRef.current = false
      isNearBottom.current = true
      setNewCount(0)
      return () => cancelAnimationFrame(raf)
    }
    if (delta > 0) {
      setNewCount(c => c + delta)
    }
  }, [messages, activity])

  // Session switch: re-arm forced bottom and pin to bottom UNCONDITIONALLY
  // across several frames. The virtualizer measures rows progressively, so
  // scrollHeight grows over multiple frames after a switch. We pin the
  // scroll to the bottom for ~12 frames (~200ms) and on every measurement
  // pass within a 600ms window to absorb late row measurements without
  // running indefinitely.
  useEffect(() => {
    forceBottomRef.current = true
    isNearBottom.current = true
    setNewCount(0)
    prevMsgCountRef.current = 0

    let cancelled = false
    let frameId = 0
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const deadline = performance.now() + 600

    const pin = () => {
      if (cancelled) return
      const el = scrollRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
      if (performance.now() < deadline) {
        frameId = requestAnimationFrame(pin)
      }
    }
    frameId = requestAnimationFrame(pin)
    // Final safety pass after layout fully settles
    timeoutId = setTimeout(() => {
      const el = scrollRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    }, 250)

    return () => {
      cancelled = true
      cancelAnimationFrame(frameId)
      if (timeoutId) clearTimeout(timeoutId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Clear attachments on session switch
  useEffect(() => {
    setAttachedFiles([])
  }, [sessionId])

  // Per-session draft persistence
  const prevSessionIdRef = useRef<string | null>(null)
  const inputRef = useRef('')
  useEffect(() => { inputRef.current = input }, [input])

  useEffect(() => {
    const outgoing = prevSessionIdRef.current
    if (outgoing && outgoing !== sessionId) {
      try {
        const pending = inputRef.current
        if (pending && pending.trim()) {
          localStorage.setItem(draftKey(outgoing), pending.slice(0, MAX_DRAFT_SIZE))
        } else {
          localStorage.removeItem(draftKey(outgoing))
        }
      } catch {}
    }
    prevSessionIdRef.current = sessionId

    if (!sessionId) {
      setInput('')
      slashSuppressedRef.current = true
      setSlashOpen(false)
      return
    }
    let saved = ''
    try { saved = localStorage.getItem(draftKey(sessionId)) ?? '' } catch {}
    setInput(saved)
    inputRef.current = saved
    if (/^\/[\w.:-]*$/.test(saved)) {
      slashSuppressedRef.current = false
      setSlashOpen(true)
    } else {
      slashSuppressedRef.current = true
      setSlashOpen(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    const sid = sessionId
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
  }, [input, sessionId])

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
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  }, [addFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault() }, [])

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

  const transcribeBlob = useCallback(async (blob: Blob, type: string) => {
    if (!token) { setRecError('Not authenticated'); return }
    setTranscribing(true)
    setRecError(null)
    try {
      const hubUrl = import.meta.env.VITE_HUB_URL || ''
      const ext = type.includes('webm') ? 'webm' : (type.includes('mp4') || type.includes('m4a') ? 'm4a' : 'webm')
      const fd = new FormData()
      fd.append('audio', blob, `recording.${ext}`)
      const csrf = (() => {
        if (typeof document === 'undefined') return null
        for (const part of (document.cookie || '').split(';')) {
          const c = part.trim()
          if (c.startsWith('csrf_token=')) return decodeURIComponent(c.slice('csrf_token='.length))
        }
        return null
      })()
      const txHeaders: Record<string, string> = { Authorization: `Bearer ${token}` }
      if (csrf) txHeaders['X-CSRF-Token'] = csrf
      const resp = await fetch(`${hubUrl}/api/transcribe`, {
        method: 'POST',
        headers: txHeaders,
        body: fd,
        credentials: 'include',
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

  const startRecording = useCallback(async () => {
    if (recording || transcribing) return
    setRecError(null)
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
  }, [recording, transcribing, cleanupRecording, transcribeBlob])

  const stopRecording = useCallback((cancel = false) => {
    recCancelledRef.current = cancel
    const rec = mediaRecRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    else cleanupRecording()
  }, [cleanupRecording])

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
    if ((!input.trim() && attachedFiles.length === 0) || !sessionId) return
    let content = ''
    const images: Array<{ media_type: string; data: string }> = []
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
    if (!content && images.length > 0) content = '[Image attached]'
    if (!content) return
    onSend(content, images.length > 0 ? images : undefined)
    try { localStorage.removeItem(draftKey(sessionId)) } catch {}
    setInput('')
    setAttachedFiles([])
    slashSuppressedRef.current = false
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const bareSlashToken = /^\/[\w.:-]*$/.test(input)
    const slashActive = slashVisible && bareSlashToken
    if (slashActive) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx(i => Math.min(slashMatch!.matches.length - 1, i + 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx(i => Math.max(0, i - 1)); return }
      if (e.key === 'Escape')    { e.preventDefault(); setSlashOpen(false); slashSuppressedRef.current = true; return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        applySlash(slashMatch!.matches[slashIdx])
        return
      }
    }
    if (e.key === 'Escape' && slashOpen) {
      e.preventDefault()
      setSlashOpen(false)
      slashSuppressedRef.current = true
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (slashOpen) { setSlashOpen(false); slashSuppressedRef.current = true }
      handleSubmit(e)
    }
  }

  // Mobile-expanded outer wrapper: square aspect ratio, dvh cap
  const rootStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (density !== 'mobile-expanded') return undefined
    return { aspectRatio: '1 / 1', maxHeight: '100dvh' }
  }, [density])

  if (!sessionId) {
    return (
      <div className={`${d.root} ${className ?? ''}`} style={rootStyle}>
        <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-sm">
          No session selected
        </div>
      </div>
    )
  }

  return (
    <div
      className={`${d.root} ${className ?? ''}`}
      style={rootStyle}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onFocusCapture={onActivate}
      onClickCapture={onActivate}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={d.list}
      >
        {loading && messages.length === 0 && (
          <div className={`text-center text-[var(--text-muted)] ${d.emptyText}`}>Loading messages...</div>
        )}
        {!loading && messages.length === 0 && (
          <div className={`text-center text-[var(--text-muted)] ${d.emptyText}`}>
            {density === 'full' ? 'No messages yet. Send a message to Claude.' : 'No messages yet.'}
          </div>
        )}

        {/* Virtualized rows */}
        {!loading && messages.length > 0 && (
          <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
            {virtualItems.map(vi => {
              const isActivityRow = vi.index === messages.length
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {isActivityRow ? (
                    <ActivityFeed
                      activity={activity}
                      onPermissionRespond={onPermissionRespond}
                      onQuestionRespond={onQuestionRespond}
                    />
                  ) : (
                    <div className={d.bubbleSize}>
                      <MessageBubble message={messages[vi.index]} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Render activity feed inline when there are no messages (no virtualization needed) */}
        {!loading && messages.length === 0 && (
          <ActivityFeed
            activity={activity}
            onPermissionRespond={onPermissionRespond}
            onQuestionRespond={onQuestionRespond}
          />
        )}
      </div>

      {newCount > 0 && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-xs text-[var(--text-on-accent)] ring-1 ring-blue-500/30 z-10"
        >
          ↓ {newCount} new
        </button>
      )}

      <form onSubmit={handleSubmit} className="safe-bottom border-t border-[var(--border-color)]">
        {!wsConnected && (
          <div className="px-3 py-1 text-[11px] text-amber-400 bg-amber-500/10 border-b border-[var(--border-color)]">
            {online ? 'Reconnecting…' : 'Offline — messages will send when you’re back online.'}
          </div>
        )}
        <FileAttachmentBar files={attachedFiles} onRemove={handleRemoveFile} />
        {(recording || transcribing || recError) && density === 'full' && (
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
        <div className={d.inputPad}>
          <div className="flex gap-2 items-center flex-nowrap w-full">
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
              className={`${d.btnSquare} flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors shrink-0 rounded-lg hover:bg-[var(--bg-tertiary)]/50`}
              title="Attach files"
              aria-label="Attach files"
            >
              <svg width={d.iconSize} height={d.iconSize} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15.5 9.2L9.2 15.5a3.5 3.5 0 0 1-5-5L10.9 3.8a2.3 2.3 0 1 1 3.3 3.3L7.5 13.8a1.2 1.2 0 0 1-1.7-1.7l6-6" />
              </svg>
            </button>
            {density === 'full' && (
              <button
                type="button"
                onClick={() => (recording ? stopRecording(false) : startRecording())}
                disabled={!wsConnected || transcribing}
                className={`${d.btnSquare} flex items-center justify-center transition-colors shrink-0 rounded-lg hover:bg-[var(--bg-tertiary)]/50 disabled:opacity-40 ${recording ? 'text-red-400' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}
                title={recording ? 'Stop recording' : 'Record voice message'}
                aria-label={recording ? 'Stop recording' : 'Record voice message'}
              >
                {recording ? (
                  <svg width={d.iconSize} height={d.iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse">
                    <line x1="2" y1="2" x2="22" y2="22" />
                    <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                    <path d="M5 10v2a7 7 0 0 0 12 5" />
                    <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                ) : (
                  <svg width={d.iconSize} height={d.iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                )}
              </button>
            )}
            <div className="flex-1 min-w-0 relative">
              {slashVisible && (
                <div className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto rounded-lg bg-[var(--bg-secondary)] shadow-xl ring-1 ring-[var(--border-color)] z-10">
                  {slashMatch!.matches.map((it, i) => (
                    <button
                      key={`${it.kind}:${it.name}:${it.source}`}
                      type="button"
                      onMouseEnter={() => setSlashIdx(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applySlash(it)}
                      className={`w-full text-left px-3 py-2 text-sm ${i === slashIdx ? 'bg-blue-600/20 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'}`}
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
                  const prev = input
                  setInput(v)
                  const unfinished = hasUnfinishedSlashToken(v)
                  const prevUnfinished = hasUnfinishedSlashToken(prev)
                  if (!unfinished || !prevUnfinished) slashSuppressedRef.current = false
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
                placeholder={density === 'full' ? 'Send a message to Claude... (type / for commands)' : 'Message…'}
                rows={1}
                className={`${d.textarea} bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none max-h-32`}
              />
            </div>
            {activity.status !== 'idle' ? (
              <button
                type="button"
                onClick={handleCancel}
                className={`${d.sendBtn} inline-flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-white font-medium transition-colors shrink-0`}
                title="Stop"
                aria-label="Stop"
              >
                <svg width={d.iconSize} height={d.iconSize} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() && attachedFiles.length === 0}
                className={`${d.sendBtn} bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 rounded-lg text-[var(--text-on-accent)] font-medium transition-colors shrink-0`}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
