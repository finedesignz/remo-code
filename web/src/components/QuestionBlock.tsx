import { useState } from 'react'
import type { PendingQuestion } from '../hooks/useActivity'

interface Props {
  question: PendingQuestion
  onRespond: (requestId: string, answer: string) => void
}

export function QuestionBlock({ question, onRespond }: Props) {
  const [responded, setResponded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [customText, setCustomText] = useState('')

  const handleSubmit = (answer: string) => {
    if (!answer.trim()) return
    setResponded(true)
    onRespond(question.request_id, answer.trim())
  }

  const hasOptions = question.options && question.options.length > 0

  return (
    <div className="rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-sm overflow-hidden">
      <div className="px-3 py-2.5 flex items-start gap-2.5">
        <span className="text-indigo-400 mt-0.5 shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M6 6.5a2 2 0 1 1 2 2v1" />
            <circle cx="8" cy="12" r="0.5" fill="currentColor" />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-indigo-300 font-medium">Claude is asking</span>
          </div>
          <div className="text-[var(--text-primary)] text-sm mb-3 whitespace-pre-wrap">
            {question.question}
          </div>

          {!responded ? (
            <div className="space-y-2">
              {/* Option buttons */}
              {hasOptions && (
                <div className="flex flex-wrap gap-1.5">
                  {question.options!.map((opt) => (
                    <button
                      key={opt.label}
                      onClick={() => {
                        setSelected(opt.label)
                        setCustomText('')
                      }}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ${
                        selected === opt.label
                          ? 'bg-indigo-500/30 text-indigo-300 border-indigo-500/50'
                          : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)]/80'
                      }`}
                      title={opt.description}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Text input for custom answer or when no options */}
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder={hasOptions ? 'Or type a custom answer...' : 'Type your answer...'}
                  value={customText}
                  onChange={(e) => {
                    setCustomText(e.target.value)
                    if (e.target.value) setSelected(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const answer = customText || selected
                      if (answer) handleSubmit(answer)
                    }
                  }}
                  className="flex-1 px-2.5 py-1.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border-primary)] text-[var(--text-primary)] text-xs placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500/50"
                />
                <button
                  onClick={() => {
                    const answer = customText || selected
                    if (answer) handleSubmit(answer)
                  }}
                  disabled={!customText && !selected}
                  className="px-3 py-1.5 rounded-md bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/30 transition-colors text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">Answer sent</div>
          )}
        </div>
      </div>
    </div>
  )
}
