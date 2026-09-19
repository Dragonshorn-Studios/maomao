/** Tiny abstract role marks. Inline SVG, no remote assets. */

const SIZE = `width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"`;

const GLYPHS: Record<string, string> = {
  correctness: `<svg ${SIZE}><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>`,
  security: `<svg ${SIZE}><path d="M8 1.6 13.2 3.6v4.2c0 3.1-2.1 5.2-5.2 6.6C4.9 13 2.8 10.9 2.8 7.8V3.6Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 6.2v3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/></svg>`,
  tests: `<svg ${SIZE}><path d="M6 1.8h4M7 1.8v3.2L3.8 13h8.4L8.9 5V1.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="miter"/><path d="M5.2 10.2h5.6" stroke="currentColor" stroke-width="1.2"/></svg>`,
  architecture: `<svg ${SIZE}><rect x="2.2" y="2.2" width="4.6" height="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9.2" y="2.2" width="4.6" height="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2.2" y="9.2" width="4.6" height="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9.2" y="9.2" width="4.6" height="4.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`,
  api: `<svg ${SIZE}><circle cx="4" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.2 8h3.6" stroke="currentColor" stroke-width="1.3"/></svg>`,
  maintainer: `<svg ${SIZE}><path d="M8 2.2c2.4 2.2 4.8 4 4.8 7.1A4.8 4.8 0 0 1 8 14a4.8 4.8 0 0 1-4.8-4.7C3.2 6.2 5.6 4.4 8 2.2Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 6.2v5.2" stroke="currentColor" stroke-width="1.2"/></svg>`,
  aggregator: `<svg ${SIZE}><circle cx="3.2" cy="4.2" r="1.3" fill="currentColor"/><circle cx="8" cy="3.4" r="1.3" fill="currentColor"/><circle cx="12.8" cy="4.2" r="1.3" fill="currentColor"/><path d="M3.2 5.6 8 12.4 12.8 5.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  mark: `<svg ${SIZE}><path d="M4.2 11.8c1.8-4.6 3.2-7.2 3.8-9.4 1.1 2.4 2.2 4.8 3.8 9.4" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.4" cy="11.2" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M13 13 14.6 14.6" stroke="currentColor" stroke-width="1.3"/></svg>`,
};

export function roleGlyph(role: string): string {
  return GLYPHS[role] ?? GLYPHS.correctness;
}

export function brandMark(): string {
  return GLYPHS.mark;
}

/** Pancake stack with a butter pat: the easter-egg treat for completed reviews. */
export function pancakeMark(): string {
  return `<svg ${SIZE}>
    <path d="M2 13c0-1.2 2.7-2.2 6-2.2s6 1 6 2.2c0 1.2-2.7 2.2-6 2.2s-6-1-6-2.2Z" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <path d="M2 10c0-1.2 2.7-2.2 6-2.2S14 8.8 14 10" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <path d="M2 7c0-1.2 2.7-2.2 6-2.2S14 5.8 14 7" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <rect x="6.4" y="1.6" width="3.2" height="2" fill="currentColor"/>
  </svg>`.replace(/\n\s+/g, "");
}
