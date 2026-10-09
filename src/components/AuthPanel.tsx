import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useSession } from "../lib/session";

type Mode = "sign-in" | "sign-up";

/** Mobile-friendly email/password form for Neon Auth (sign in or create an account). */
export function AuthForm({ onDone, autoFocus = false }: { onDone?: () => void; autoFocus?: boolean }) {
  const session = useSession();
  const ids = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (autoFocus) emailRef.current?.focus({ preventScroll: true }); }, [autoFocus]);

  if (session.status === "unconfigured") {
    return <p className="notice notice-warn" role="status">Sign-in is not configured for this deployment. The owner must set <code>VITE_NEON_AUTH_URL</code> (or the Vercel Neon integration variable) and redeploy.</p>;
  }
  if (session.status === "checking") return <p className="notice" role="status"><span className="spinner" aria-hidden="true" /> Checking your session…</p>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (!email.trim() || !password) { setError("Enter your email and password."); return; }
    if (mode === "sign-up" && password.length < 8) { setError("Use at least 8 characters for your password."); return; }
    setBusy(true);
    const result = mode === "sign-up" ? await session.signUp(email, password) : await session.signIn(email, password);
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    setPassword("");
    onDone?.();
  };

  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)} noValidate aria-busy={busy}>
      <div className="segmented" role="tablist" aria-label="Account action">
        <button type="button" role="tab" aria-selected={mode === "sign-in"} onClick={() => { setMode("sign-in"); setError(null); }}>Sign in</button>
        <button type="button" role="tab" aria-selected={mode === "sign-up"} onClick={() => { setMode("sign-up"); setError(null); }}>Create account</button>
      </div>
      <div className="field">
        <label htmlFor={`${ids}-email`}>Email</label>
        <input
          ref={emailRef}
          id={`${ids}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          required
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${ids}-password`}>Password</label>
        <div className="input-with-action">
          <input
            id={`${ids}-password`}
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            required
            minLength={mode === "sign-up" ? 8 : undefined}
            aria-describedby={mode === "sign-up" ? `${ids}-password-hint` : undefined}
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
          <button type="button" className="input-action" aria-pressed={showPassword} aria-controls={`${ids}-password`} onClick={() => setShowPassword((value) => !value)}>{showPassword ? "Hide" : "Show"}</button>
        </div>
        {mode === "sign-up" && <small id={`${ids}-password-hint`}>At least 8 characters.</small>}
      </div>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <button type="submit" className="button button-primary button-block" disabled={busy}>
        {busy && <span className="spinner" aria-hidden="true" />}
        {busy ? (mode === "sign-up" ? "Creating account…" : "Signing in…") : mode === "sign-up" ? "Create account" : "Sign in"}
      </button>
      {mode === "sign-up" && <p className="fine-print">After creating an account, the owner grants recorded-history access with <code>npm run access:grant</code>.</p>}
    </form>
  );
}

/** Signed-in summary with sign-out. */
export function AccountSummary() {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (session.status !== "signed-in") return null;
  return (
    <div className="account-summary">
      <span className="avatar" aria-hidden="true">{(session.email ?? "?").slice(0, 1).toUpperCase()}</span>
      <div><strong>Signed in</strong><span className="truncate">{session.email}</span></div>
      <button type="button" className="button button-ghost" disabled={busy} onClick={() => { setBusy(true); void session.signOut().then((result) => { setBusy(false); setError(result.ok ? null : result.message); }); }}>{busy ? "Signing out…" : "Sign out"}</button>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
    </div>
  );
}

/** Header account button; opens a full-height sheet on phones and a dialog on larger screens. */
export function AuthPanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const session = useSession();
  const [open, setOpen] = useState(defaultOpen);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; };
  }, [open]);

  const label = session.status === "signed-in" ? "Account" : session.status === "checking" ? "Checking…" : "Sign in";
  return (
    <>
      <button type="button" className={`button ${session.status === "signed-in" ? "button-ghost account-chip" : "button-primary"}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {session.status === "signed-in" ? <><span className="avatar avatar-sm" aria-hidden="true">{(session.email ?? "?").slice(0, 1).toUpperCase()}</span><span className="sr-only">Account</span></> : label}
      </button>
      {open && createPortal(
        <div className="sheet-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <div className="sheet-handle" aria-hidden="true" />
            <header className="sheet-header">
              <div><p className="eyebrow">AIRIntel account</p><h2 id={titleId}>{session.status === "signed-in" ? "Your account" : "Sign in to AIRIntel"}</h2></div>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setOpen(false)}>✕</button>
            </header>
            {session.status === "signed-in" ? <AccountSummary /> : (
              <>
                <p className="sheet-copy">Signing in unlocks your Netted Aircraft log, recorded history and aircraft profiles. Live aircraft stay visible without an account.</p>
                <AuthForm autoFocus onDone={() => setOpen(false)} />
              </>
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
