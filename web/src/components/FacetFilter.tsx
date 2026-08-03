/**
 * web/src/components/FacetFilter.tsx — composable faceted filtering with live
 * counts, hand-rolled on the nightdesk popover rules (no new dependencies).
 *
 * A screen declares its filter dimensions as data — one FacetDef per
 * dimension (plane, state, site, severity, …) — keeps the selection as
 * controlled state, and runs its rows through applyFacets:
 *
 *   const deviceFacets: Array<FacetDef<DeviceRow>> = [
 *     { key: 'plane', label: 'Plane', values: (d) => [d.plane] },
 *     { key: 'site', label: 'Site', values: (d) => [d.siteId],
 *       formatValue: (id) => siteNameOf(id) },
 *   ];
 *   const rows = applyFacets(baseRows, deviceFacets, selection);
 *
 * Composition is the standard faceted-search rule: OR within a facet (a row
 * matching ANY ticked value passes), AND across facets (a row must pass EVERY
 * active facet). Facets compose with the screen's other filters by position
 * in the pipeline: the `rows` prop is the universe AFTER every non-facet
 * filter (free text, switches, URL deep links), and applyFacets' output is
 * what the table renders — so a count never promises rows the search box
 * would then hide.
 *
 * Counts are honest counts: an option's count is computed over the rows that
 * pass every OTHER active facet, never the facet's own selection. Ticking
 * 'P1' must not zero the 'P2' count — that would hide the very information
 * the operator needs to widen the filter. An option nothing currently matches
 * stays listed with a 0, and a selected value the feed no longer carries
 * stays listed too (count 0): a filter that is hiding rows must never become
 * invisible — the same rule the Devices ?plane= deep-link union follows.
 *
 * The popovers follow the repo's overlay rules without a library: Escape
 * closes and returns focus to the trigger, a pointer down outside closes, and
 * the trigger advertises its expanded state — the same pattern
 * nightdesk/TableViewOptions.tsx documents. The panel reuses the
 * nd-viewopts classes, left-anchored (the filter row's triggers sit mid-row,
 * where a right-anchored panel would overflow the viewport edge).
 */

import { useEffect, useRef, useState } from 'react';
import { cx } from '../nightdesk/utils';

/** The controlled facet state: facet key → the ticked values. Absent/empty = no constraint. */
export type FacetSelection = Record<string, string[]>;

export type FacetDef<Row> = {
  /** Stable dimension id — the selection and saved views persist against it. */
  key: string;
  /** Trigger and popover heading — 'Plane', 'Severity'. */
  label: string;
  /** The row's value(s) for this dimension (usually one; multi-valued rows match any). */
  values: (row: Row) => string[];
  /** Display label for a raw value (a site id renders its site name). Default: the value itself. */
  formatValue?: (value: string) => string;
};

/**
 * The filtered rows: OR within each facet, AND across facets. A facet with
 * nothing ticked constrains nothing; with no active facet this returns `rows`
 * unchanged (same array — cheap enough to sit in a render pipeline).
 */
export function applyFacets<Row>(rows: Row[], facets: Array<FacetDef<Row>>, selection: FacetSelection): Row[] {
  const active = facets.filter((facet) => (selection[facet.key]?.length ?? 0) > 0);
  if (active.length === 0) return rows;
  return rows.filter((row) =>
    active.every((facet) => {
      const ticked = new Set(selection[facet.key]);
      return facet.values(row).some((value) => ticked.has(value));
    }),
  );
}

export type FacetOptionCount = {
  value: string;
  label: string;
  /** Rows matching this value AND every other active facet — never this facet's own selection. */
  count: number;
};

/**
 * One facet's checklist with honest counts: every option the UNIVERSE
 * carries, first-seen order, each counted over the rows passing every OTHER
 * facet. The option list never collapses on this or another facet's
 * selection — a 0 says "nothing in view matches" while keeping the option
 * visible (only a NON-facet filter, like the search box, removes an option
 * outright, because those rows are outside the universe itself). Ticked
 * values the universe no longer carries append at the end with a 0 — a
 * hiding filter stays visible and clearable.
 */
export function facetOptionCounts<Row>(
  rows: Row[],
  facets: Array<FacetDef<Row>>,
  facet: FacetDef<Row>,
  selection: FacetSelection,
): FacetOptionCount[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const value of facet.values(row)) {
      if (!seen.has(value)) {
        seen.add(value);
        order.push(value);
      }
    }
  }
  const othersPass = applyFacets(
    rows,
    facets.filter((f) => f.key !== facet.key),
    selection,
  );
  const counts = new Map<string, number>();
  for (const row of othersPass) {
    for (const value of new Set(facet.values(row))) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const label = (value: string) => facet.formatValue?.(value) ?? value;
  const options = order.map((value) => ({ value, label: label(value), count: counts.get(value) ?? 0 }));
  for (const value of selection[facet.key] ?? []) {
    if (!seen.has(value)) options.push({ value, label: label(value), count: 0 });
  }
  return options;
}

/** The selection with one value toggled; an emptied facet key drops out (absent = no constraint). */
function toggled(selection: FacetSelection, key: string, value: string): FacetSelection {
  const current = selection[key] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const out = { ...selection };
  if (next.length === 0) delete out[key];
  else out[key] = next;
  return out;
}

/**
 * Type-guard a stored selection (a saved view's `filters.facets`): keeps only
 * string-array entries, drops everything else — a malformed view narrows
 * nothing rather than hiding rows by accident.
 */
export function sanitizeFacetSelection(value: unknown): FacetSelection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) && entry[1].every((v) => typeof v === 'string'),
    ),
  );
}

/** Ticked values across every facet — drives the clear-all chip. */
function selectedCount(selection: FacetSelection): number {
  return Object.values(selection).reduce((n, values) => n + values.length, 0);
}

function FacetPopover<Row>({
  facets,
  facet,
  rows,
  selection,
  onChange,
}: {
  facets: Array<FacetDef<Row>>;
  facet: FacetDef<Row>;
  rows: Row[];
  selection: FacetSelection;
  onChange: (next: FacetSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const ticked = selection[facet.key] ?? [];
  const options = facetOptionCounts(rows, facets, facet, selection);

  return (
    <div className="nd-viewopts" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="nd-btn nd-btn--secondary nd-btn--sm"
        aria-expanded={open}
        title={ticked.length > 0 ? ticked.map((v) => options.find((o) => o.value === v)?.label ?? v).join(', ') : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {facet.label}
        {ticked.length > 0 ? ` · ${ticked.length}` : ''}
      </button>
      {open ? (
        /* Left-anchored: filter-row triggers sit mid-row, where the
           nd-viewopts right anchor would overflow the viewport edge. */
        <div
          className="nd-viewopts__panel"
          role="group"
          aria-label={`${facet.label} filter`}
          style={{ right: 'auto', left: 0 }}
        >
          <div className="nd-viewopts__heading">{facet.label}</div>
          <ul className="nd-viewopts__list">
            {options.map((option) => (
              <li key={option.value} className="nd-viewopts__item">
                <label className={cx('nd-checkbox', 'nd-viewopts__check')}>
                  <input
                    type="checkbox"
                    checked={ticked.includes(option.value)}
                    onChange={() => onChange(toggled(selection, facet.key, option.value))}
                  />
                  <span>{option.label}</span>
                </label>
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: option.count > 0 ? 'var(--nd-text-muted)' : 'var(--nd-border-strong)',
                  }}
                >
                  {option.count}
                </span>
              </li>
            ))}
          </ul>
          {ticked.length > 0 ? (
            <button
              type="button"
              className="nd-viewopts__reset"
              onClick={() => {
                const next = { ...selection };
                delete next[facet.key];
                onChange(next);
              }}
            >
              Clear {facet.label.toLowerCase()}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One popover checklist per declared facet, plus a clear-all chip while any
 * selection is active. `rows` is the universe the counts describe: every row
 * the screen would show with NO facet active (free text, switches and URL
 * filters already applied), so a count never covers rows another control is
 * hiding.
 */
export function FacetFilter<Row>({
  facets,
  rows,
  selection,
  onChange,
}: {
  facets: Array<FacetDef<Row>>;
  rows: Row[];
  selection: FacetSelection;
  onChange: (next: FacetSelection) => void;
}) {
  const active = selectedCount(selection);
  return (
    <>
      {facets.map((facet) => (
        <FacetPopover
          key={facet.key}
          facets={facets}
          facet={facet}
          rows={rows}
          selection={selection}
          onChange={onChange}
        />
      ))}
      {active > 0 ? (
        <button
          type="button"
          onClick={() => onChange({})}
          style={{
            background: 'none',
            border: '1px solid var(--nd-border)',
            borderRadius: 4,
            padding: '2px 8px',
            cursor: 'pointer',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-accent-text)',
          }}
        >
          {`${active} facet value${active === 1 ? '' : 's'} — clear`}
        </button>
      ) : null}
    </>
  );
}
