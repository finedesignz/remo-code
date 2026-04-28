const HUB_URL = import.meta.env.VITE_HUB_URL || "";

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  display_name?: string;
}

export async function apiLogin(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${HUB_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Login failed" }));
    throw new Error(err.error || "Login failed");
  }
  return res.json();
}

export async function apiRegister(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${HUB_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Registration failed" }));
    throw new Error(err.error || "Registration failed");
  }
  return res.json();
}

export function getStoredToken(): string | null {
  return localStorage.getItem("remo_token");
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem("remo_user");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function storeAuth(token: string, user: AuthUser): void {
  localStorage.setItem("remo_token", token);
  localStorage.setItem("remo_user", JSON.stringify(user));
}

export function clearAuth(): void {
  localStorage.removeItem("remo_token");
  localStorage.removeItem("remo_user");
}
