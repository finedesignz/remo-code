interface Props {
  count: number
}

export function UnreadBadge({ count }: Props) {
  if (count <= 0) return null
  return (
    <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-[var(--text-on-accent)] text-[10px] font-bold">
      {count > 99 ? '99+' : count}
    </span>
  )
}
