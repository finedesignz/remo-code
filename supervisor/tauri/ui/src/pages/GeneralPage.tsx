export default function GeneralPage() {
  return (
    <div className="max-w-2xl space-y-5">
      <header>
        <h1 className="text-lg font-semibold">General</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Remo Code Supervisor — coming soon.
        </p>
      </header>
      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1">Status</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          The supervisor sidecar will report its status here.
        </p>
      </section>
    </div>
  );
}
