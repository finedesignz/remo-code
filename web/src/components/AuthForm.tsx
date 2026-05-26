import { useState } from "react";
import { apiLogin, apiRegister } from "../lib/auth.ts";
import type { AuthUser } from "../lib/auth.ts";

interface Props {
  onAuth: (token: string, user: AuthUser) => void;
}

export function AuthForm({ onAuth }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const fn = mode === "login" ? apiLogin : apiRegister;
      const { token, user } = await fn(email, password);
      onAuth(token, user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
      <div className="w-full max-w-md p-8">
        <img src="/logo.png" alt="Remo Code" className="h-14 w-auto mx-auto mb-4" />
        <h1 className="text-3xl font-bold text-center mb-2 text-[var(--text-primary)]">Remo Code</h1>
        <p className="text-center text-[var(--text-muted)] mb-8">
          Remote access to your Claude Code sessions
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            {mode === "login" ? "Sign in" : "Create account"}
          </h2>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            className="px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors disabled:opacity-50"
          >
            {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button
          className="mt-4 w-full text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          onClick={() => { setMode(m => m === "login" ? "register" : "login"); setError(null); }}
        >
          {mode === "login" ? "Need an account?" : "Already have an account?"}
        </button>
      </div>
    </div>
  );
}
