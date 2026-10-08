import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { clearAccessToken, getAuthClient } from "../lib/auth";

type Mode = "sign-in" | "sign-up";

/** Email/password sign-in for Neon Auth. Signing in lets the history and profile gateways receive a Bearer JWT. */
export function AuthPanel() {
  const auth = getAuthClient();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(auth !== null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("sign-in");
  const [formEmail, setFormEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!auth) return;
    let active = true;
    void auth.getSession().then((result) => {
      if (!active) return;
      setEmail(result.data?.user?.email ?? null);
      setChecking(false);
    }).catch(() => {
      if (!active) return;
      setError("Unable to check your session. Try signing in again.");
      setChecking(false);
    });
    return () => { active = false; };
  }, [auth]);

  if (!auth) return <div className="auth-panel"><span className="auth-note" title="Set VITE_NEON_AUTH_URL to enable sign-in">Sign-in not configured</span></div>;
  if (checking) return <div className="auth-panel"><span className="auth-note">Checking session...</span></div>;

  const refreshData = () => queryClient.invalidateQueries();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = mode === "sign-up"
        ? await auth.signUp.email({ name: formEmail.split("@")[0] || "AIRIntel user", email: formEmail, password })
        : await auth.signIn.email({ email: formEmail, password });
      if (result.error) {
        setError(result.error.message ?? "Authentication failed");
        return;
      }
      clearAccessToken();
      const session = await auth.getSession();
      setEmail(session.data?.user?.email ?? null);
      setPassword("");
      setOpen(false);
      await refreshData();
    } catch {
      setError("Sign-in could not complete. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await auth.signOut();
      if (result.error) { setError(result.error.message ?? "Sign-out failed"); return; }
      clearAccessToken();
      setEmail(null);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "aircraft" });
    } catch {
      setError("Sign-out could not complete. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (email) {
    return <div className="auth-panel"><span className="auth-note">{email}</span>{error && <span role="alert" className="auth-error">{error}</span>}<button type="button" disabled={busy} onClick={() => void signOut()}>Sign out</button></div>;
  }

  return (
    <div className="auth-panel">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Sign in</button>
      {open && (
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label>Email<input type="email" autoComplete="email" required value={formEmail} onChange={(event) => setFormEmail(event.currentTarget.value)} /></label>
          <label>Password<input type="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} required minLength={8} value={password} onChange={(event) => setPassword(event.currentTarget.value)} /></label>
          {error && <p role="alert" className="auth-error">{error}</p>}
          <div className="auth-actions">
            <button type="submit" disabled={busy}>{mode === "sign-up" ? "Create account" : "Sign in"}</button>
            <button type="button" className="auth-link" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setError(null); }}>{mode === "sign-in" ? "Need an account?" : "Have an account?"}</button>
          </div>
        </form>
      )}
    </div>
  );
}
