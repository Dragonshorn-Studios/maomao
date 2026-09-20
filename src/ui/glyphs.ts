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

/** Fallback account mark when the operator has no avatar (password sessions). */
export function operatorMark(): string {
  return `<svg ${SIZE}><circle cx="8" cy="5.4" r="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.2 13.2c.6-2.6 2.2-3.8 4.8-3.8s4.2 1.2 4.8 3.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square"/></svg>`;
}

/** Official GitHub mark, currentColor, for forge titles (not a `[GitHub]` prefix). */
export function githubMark(): string {
  return `<svg ${SIZE}><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;
}

/** GitLab tanuki, currentColor, for forge titles (not a `[GitLab]` prefix). */
export function gitlabMark(): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M22.65 14.39 12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94Z"/></svg>`;
}

export function forgeMark(provider: string): string {
  switch (provider.toLowerCase()) {
    case "github":
      return githubMark();
    case "gitlab":
      return gitlabMark();
    default:
      return "";
  }
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
