export function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="w-full border-t border-[var(--border-color)] bg-[var(--bg-primary)] py-2 px-4 text-xs text-[var(--text-muted)] flex items-center justify-between gap-4 shrink-0">
      <span>© {year} Remo Code</span>
      <nav className="flex items-center gap-4">
        <a href="#/privacy" className="hover:text-[var(--text-primary)] transition-colors">Privacy</a>
        <a href="#/terms" className="hover:text-[var(--text-primary)] transition-colors">Terms</a>
        <a
          href="https://status.remo-code.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-[var(--text-primary)] transition-colors"
        >
          Status
        </a>
      </nav>
    </footer>
  )
}
