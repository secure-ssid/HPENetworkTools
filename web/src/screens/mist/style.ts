/**
 * web/src/screens/mist/style.ts — the one `noteStyle` the Mist screen's
 * sections share. The site-detail and systems sections each defined this
 * verbatim; the Mist screen's sections import it here instead of adding a
 * fourth copy (the extracted audit half re-homes the systems copy to it too).
 */

export const noteStyle = {
  fontFamily: 'var(--nd-font-mono)',
  fontSize: 'var(--nd-text-11)',
  color: 'var(--nd-text-muted)',
  lineHeight: 1.6,
} as const;
