import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { clearAccessToken, getAuthClient } from "./auth";

export type SessionStatus = "unconfigured" | "checking" | "signed-out" | "signed-in";
type Result = { ok: true } | { ok: false; message: string };
type SessionValue = {
  status: SessionStatus;
  email: string | null;
  signIn: (email: string, password: string) => Promise<Result>;
  signUp: (email: string, password: string, name?: string) => Promise<Result>;
  signOut: () => Promise<Result>;
};

const SessionContext = createContext<SessionValue | null>(null);

/** Neon Auth session shared by the header, the account sheet and the data views. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const auth = getAuthClient();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SessionStatus>(auth ? "checking" : "unconfigured");
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!auth) return;
    let active = true;
    auth.getSession().then((result) => {
      if (!active) return;
      const current = result.data?.user?.email ?? null;
      setEmail(current);
      setStatus(current ? "signed-in" : "signed-out");
    }).catch(() => { if (active) setStatus("signed-out"); });
    return () => { active = false; };
  }, [auth]);

  const afterAuth = useCallback(async () => {
    if (!auth) return;
    clearAccessToken();
    const session = await auth.getSession();
    const current = session.data?.user?.email ?? null;
    setEmail(current);
    setStatus(current ? "signed-in" : "signed-out");
    await queryClient.invalidateQueries();
  }, [auth, queryClient]);

  const signIn = useCallback(async (formEmail: string, password: string): Promise<Result> => {
    if (!auth) return { ok: false, message: "Sign-in is not configured for this deployment." };
    try {
      const result = await auth.signIn.email({ email: formEmail.trim(), password });
      if (result.error) return { ok: false, message: result.error.message ?? "Email or password is incorrect." };
      await afterAuth();
      return { ok: true };
    } catch {
      return { ok: false, message: "Sign-in could not complete. Check your connection and try again." };
    }
  }, [auth, afterAuth]);

  const signUp = useCallback(async (formEmail: string, password: string, name?: string): Promise<Result> => {
    if (!auth) return { ok: false, message: "Sign-up is not configured for this deployment." };
    try {
      const trimmed = formEmail.trim();
      const result = await auth.signUp.email({ name: name?.trim() || trimmed.split("@")[0] || "AIRIntel user", email: trimmed, password });
      if (result.error) return { ok: false, message: result.error.message ?? "Account could not be created." };
      await afterAuth();
      return { ok: true };
    } catch {
      return { ok: false, message: "Account creation could not complete. Check your connection and try again." };
    }
  }, [auth, afterAuth]);

  const signOut = useCallback(async (): Promise<Result> => {
    if (!auth) return { ok: true };
    try {
      const result = await auth.signOut();
      if (result.error) return { ok: false, message: result.error.message ?? "Sign-out failed." };
      clearAccessToken();
      setEmail(null);
      setStatus("signed-out");
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "aircraft" });
      return { ok: true };
    } catch {
      return { ok: false, message: "Sign-out could not complete. Please try again." };
    }
  }, [auth, queryClient]);

  const value = useMemo(() => ({ status, email, signIn, signUp, signOut }), [status, email, signIn, signUp, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}
