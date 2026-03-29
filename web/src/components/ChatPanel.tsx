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

export function ChatPanel({ messages, loading, onSend, activeSessionId, sessionStatus, activity }: Props) {
  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottom = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
    onSend(content, images.length > 0 ? images : undefined)
    setInput('')
    setAttachedFiles([])
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        <ActivityFeed activity={activity} />
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
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Send a message to Claude..."
              rows={1}
              className="flex-1 px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none max-h-32"
            />
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
