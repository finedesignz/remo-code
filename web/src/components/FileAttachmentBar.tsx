interface AttachedFile {
  file: File
  type: 'text' | 'image'
}

interface Props {
  files: AttachedFile[]
  onRemove: (index: number) => void
}

export function FileAttachmentBar({ files, onRemove }: Props) {
  if (files.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5 px-4 pt-2">
      {files.map((f, i) => (
        <div
          key={i}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)] max-w-[200px]"
        >
          <span className="shrink-0">
            {f.type === 'image' ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="1" width="10" height="10" rx="1.5" />
                <circle cx="4" cy="4" r="1" />
                <path d="M11 8L8.5 5.5L2 11" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 1H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4L7 1z" />
                <path d="M7 1v3h3" />
              </svg>
            )}
          </span>
          <span className="truncate">{f.file.name}</span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {(f.file.size / 1024).toFixed(0)}KB
          </span>
          <button
            onClick={() => onRemove(i)}
            className="shrink-0 ml-1 text-[var(--text-muted)] hover:text-red-400 transition-colors"
            aria-label={`Remove ${f.file.name}`}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2.5" y1="2.5" x2="7.5" y2="7.5" />
              <line x1="7.5" y1="2.5" x2="2.5" y2="7.5" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

export type { AttachedFile }
