export default function SecurityPage() {
  return (
    <div className="max-w-2xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold">Security</h1>
        <p className="text-sm text-[var(--text-muted)]">Coming soon.</p>
      </header>
      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <p className="text-sm text-[var(--text-secondary)]">
          The dangerous-skip-permissions hard cap, restrict-to-git, audit log
          toggle, and max-concurrent slider will land in Wave 3.
        </p>
      </section>
    </div>
  );
}
