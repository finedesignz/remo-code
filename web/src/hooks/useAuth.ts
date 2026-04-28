import { useState, useEffect, useCallback } from "react";
import { getStoredToken, getStoredUser, storeAuth, clearAuth, type AuthUser } from "../lib/auth.ts";

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ user: null, token: null, loading: true });

  useEffect(() => {
    const token = getStoredToken();
    const user = getStoredUser();
    setState({ user, token, loading: false });
  }, []);

  const signIn = useCallback((token: string, user: AuthUser) => {
    storeAuth(token, user);
    setState({ user, token, loading: false });
  }, []);

  const signOut = useCallback(() => {
    clearAuth();
    setState({ user: null, token: null, loading: false });
  }, []);

  return { ...state, signIn, signOut };
}
