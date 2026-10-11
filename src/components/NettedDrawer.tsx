import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const EXIT_MS = 220;

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Short line under the title, e.g. "Last 24 h · 7 mi radius". */
  subtitle?: string;
  children: ReactNode;
};

/**
 * Accessible slide-out drawer: right side panel on desktop, bottom sheet on phones.
 * role="dialog" + aria-modal, focus moves in on open and is trapped, Esc / backdrop / close button dismiss,
 * focus returns to the control that opened it, the page behind is inert and does not scroll. Motion is disabled
 * by the global prefers-reduced-motion rule.
 */
export function NettedDrawer({ open, onClose, title, subtitle, children }: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  // Mount on open, keep mounted through the exit transition.
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // Focus management, inert background and scroll lock while open.
  useEffect(() => {
    if (!open || !mounted) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      root?.removeAttribute("inert");
      document.documentElement.style.overflow = previousOverflow;
      const target = returnFocusRef.current;
      if (target && document.contains(target)) target.focus({ preventScroll: true });
    };
  }, [open, mounted]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab") return;
    const nodes = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((node) => node.offsetParent !== null || node === document.activeElement);
    if (nodes.length === 0) { event.preventDefault(); return; }
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !panelRef.current?.contains(active))) { event.preventDefault(); first.focus(); }
  }, [onClose]);

  if (!mounted) return null;
  return createPortal(
    <div className={`drawer-root${visible ? " is-open" : ""}`} onKeyDown={onKeyDown}>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className="drawer-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="netted-drawer">
        <span className="drawer-handle" aria-hidden="true" />
        <header className="drawer-header">
          <div className="drawer-title">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close netted log"><span aria-hidden="true">✕</span></button>
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
