/** Minimal inline icons (stroke = currentColor) for the navigation. Decorative: always aria-hidden. */
const base = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const MapIcon = () => <svg {...base}><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" /><path d="M9 4v14M15 6v14" /></svg>;
export const ListIcon = () => <svg {...base}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12 18 6" /></svg>;
export const NetIcon = () => <svg {...base}><path d="M4 7h16M4 12h16M4 17h16M8 4v16M16 4v16" /><circle cx="12" cy="12" r="2.2" fill="currentColor" /></svg>;
export const HistoryIcon = () => <svg {...base}><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><path d="M3 4v4h4" /><path d="M12 7.5V12l3 2" /></svg>;
export const MoreIcon = () => <svg {...base}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></svg>;
export const PinIcon = () => <svg {...base}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></svg>;

/** AIRIntel mark: radar sweep with an aircraft glyph. */
export const BrandMark = () => (
  <svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true">
    <rect width="64" height="64" rx="16" fill="#121b24" />
    <circle cx="32" cy="32" r="21" fill="none" stroke="#2b3b4b" strokeWidth="2" />
    <circle cx="32" cy="32" r="12" fill="none" stroke="#2b3b4b" strokeWidth="2" />
    <path d="M32 32 L50 20 A21 21 0 0 1 53 32 Z" fill="#f2b544" opacity=".35" />
    <path d="M31 14h2l1.2 11.5L46 33v2.4l-11.8-4.2v8.6l4 3.2v1.8L32 43l-6.2 1.8V43l4-3.2v-8.6L18 35.4V33l11.8-7.5Z" fill="#f2b544" />
  </svg>
);
