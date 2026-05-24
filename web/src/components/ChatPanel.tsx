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

export function ChatPanel({ messages, loading, onSend, activeSessionId, sessionStatus, activity, onPermissionRespond, onQuestionRespond, token }: Props) {
  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [slashItems, setSlashItems] = useState<SlashItem[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  const [slashOpen, setSlashOpen] = useState(false)

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
    if (!input.startsWith('/')) return null
    const m = input.match(/^\/([\w.:-]*)/)
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

  function applySlash(item: SlashItem) {
    const rest = input.replace(/^\/[\w.:-]*/, '')
    const next = `/${item.name}${rest.startsWith(' ') ? '' : ' '}${rest}`
    const caret = item.name.length + 2 // '/' + name + ' '
    setInput(next)
    setSlashOpen(false)
    setSlashIdx(0)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(caret, caret)
    })
  }

  // Track whether user is near bottom of chat
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
  }, [])

  // Scroll to bottom on new messages/activity (if near bottom)
  useEffect(() => {
    if (isNearBottom.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, sessionStatus, activity])

  // Always scroll to bottom immediately on session switch or initial load
  useEffect(() => {
    isNearBottom.current = true
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' })
    }
  }, [activeSessionId])

  // Clear attachments on session switch
  useEffect(() => {
    setAttachedFiles([])
  }, [activeSessionId])

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
    setInput('')
    setAttachedFiles([])
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashVisible) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => Math.min(slashMatch!.matches.length - 1, i + 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx((i) => Math.max(0, i - 1)); return }
      if (e.key === 'Escape')    { e.preventDefault(); setSlashOpen(false); return }
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
      className="flex-1 flex flex-col min-h-0"
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

      <form onSubmit={handleSubmit} className="border-t border-[var(--border-color)]">
        <FileAttachmentBar files={attachedFiles} onRemove={handleRemoveFile} />
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
                  setInput(e.target.value)
                  if (e.target.value.startsWith('/')) { setSlashOpen(true); setSlashIdx(0) }
                  else setSlashOpen(false)
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => { if (input.startsWith('/')) setSlashOpen(true) }}
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
