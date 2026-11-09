import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, refreshAccessToken, session } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  status: "loading" | "authenticated" | "anonymous";
  login(email: string, password: string): Promise<void>;
  register(input: { email: string; password: string; displayName: string }): Promise<{ verificationRequired: boolean }>;
  logout(): Promise<void>;
  setUser(u: User): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");

  useEffect(() => {
    // Restore the session from the refresh cookie on load.
    refreshAccessToken().then(async (token) => {
      if (!token) return setStatus("anonymous");
      try {
        const me = await api<{ user: User }>("/users/me");
        setUser(me.user);
        setStatus("authenticated");
      } catch {
        setStatus("anonymous");
      }
    });
    session.onLost(() => {
      session.set(null);
      setUser(null);
      setStatus("anonymous");
    });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api<{ user: User; accessToken: string }>("/auth/login", { body: { email, password } });
    session.set(res.accessToken);
    setUser(res.user);
    setStatus("authenticated");
  }, []);

  const register = useCallback(async (input: { email: string; password: string; displayName: string }) => {
    const res = await api<{ user: User; accessToken?: string; verificationRequired?: boolean }>("/auth/register", { body: input });
    if (res.accessToken) {
      session.set(res.accessToken);
      setUser(res.user);
      setStatus("authenticated");
    }
    return { verificationRequired: !!res.verificationRequired };
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include", headers: { "x-zuum-csrf": "1" } }).catch(
      () => undefined,
    );
    session.set(null);
    setUser(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo(() => ({ user, status, login, register, logout, setUser }), [user, status, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth di luar AuthProvider");
  return ctx;
}
