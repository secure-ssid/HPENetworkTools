/**
 * web/src/app/planePollDelta.ts — plane poll enter/leave announcements.
 *
 * Shift strip already carries a continuous polite status summary. This helper
 * builds a short delta string only when the degraded-plane set changes so
 * screen readers hear *what* changed without re-reading the whole strip.
 */

/** Sorted unique plane ids. */
export function normalizePlaneIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Human announcement for degraded-set transitions.
 * Returns null when nothing meaningful changed (same set).
 */
export function planePollDeltaAnnouncement(
  previous: readonly string[],
  next: readonly string[],
): string | null {
  const prev = new Set(normalizePlaneIds(previous));
  const nxt = new Set(normalizePlaneIds(next));

  const entered: string[] = [];
  const left: string[] = [];
  for (const id of nxt) {
    if (!prev.has(id)) entered.push(id);
  }
  for (const id of prev) {
    if (!nxt.has(id)) left.push(id);
  }

  if (entered.length === 0 && left.length === 0) return null;

  const parts: string[] = [];
  if (entered.length > 0) {
    parts.push(
      entered.length === 1
        ? `${entered[0]} became degraded`
        : `${entered.join(', ')} became degraded`,
    );
  }
  if (left.length > 0) {
    parts.push(
      left.length === 1
        ? `${left[0]} recovered`
        : `${left.join(', ')} recovered`,
    );
  }

  if (nxt.size === 0 && left.length > 0) {
    return `${parts.join('. ')}. All linked planes healthy.`;
  }
  if (nxt.size > 0) {
    return `${parts.join('. ')}. ${nxt.size} plane${nxt.size === 1 ? '' : 's'} degraded: ${[...nxt].join(', ')}.`;
  }
  return `${parts.join('. ')}.`;
}
