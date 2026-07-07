// Inline SVG icons (fill uses currentColor).
export const ICONS = {
  play: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`,
  stop: `<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>`,
  // Repeat (all)
  repeat: `<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>`,
  // Repeat one (with a small "1")
  repeatOne: `<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="15" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor">1</text></svg>`,
  // Play once (arrow to a bar)
  once: `<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 1 2.34 5.66l1.42-1.42A6 6 0 1 0 6 12H9l-4 4-4-4h3z"/><path d="M12 8v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  volume: `<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9H4zm12 3a4 4 0 0 0-2-3.46v6.92A4 4 0 0 0 16 12zm-2-8v2.06a6 6 0 0 1 0 11.88V22a8 8 0 0 0 0-18z"/></svg>`,
  muted: `<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 8l6 8M22 8l-6 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  note: `<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`,
};
