/**
 * web/src/screens/mist/wlans.tsx — the Mist screen's WLAN summary: the WLAN
 * inventory the plane's config read reported (the same site-scoped walk the
 * Configure screen renders), each row's scope text verbatim, with the count
 * in the meta and the edit path left where it belongs — Configure's Mist
 * flow, linked from every row state.
 *
 * Three states, the screen's standing rule: absent/null means the read did
 * not happen or the plane named it unavailable (never an implied empty
 * org); present-and-empty is Mist's real "no WLANs" answer.
 *
 * Loop 115: optional `q` substring + `enabled` (1/0/true/false/yes/no/on/off)
 * filter the on-screen list and ride **Download server CSV** so the file
 * matches the strip. Filters write back on `section=wlans` share links.
 * Loop 140: an **Enabled** chip row (counts over the q universe) toggles the
 * same `?enabled=` as the Select — click again to clear.
 *
 * Multi-select raises **Export selected**, **Copy names** (unique
 * newline-joined SSID names — Central WLANs pattern), **Copy selection link**
 * (`?names=` of marked SSID names with `section=wlans`; clearable chip while
 * active — Loop 187), and Clear. Filtered empties (q / enabled) offer
 * **Clear filters** (Loop 204). Selection-empty `?names=` offers
 * **Clear selection filter** (Loop 211).
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  DataTable,
  Input,
  SectionHeader,
  Select,
  useToast,
  type DataTableColumn,
} from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { SsidObject } from '@hpe/shared';
import { namesFilterForParam } from '../../app/nav';
import { exportTableCsv } from '../../lib/csv';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import { buildSsidDeepLink } from '../configure/deepLink';
import { buildMistShareUrl } from './share';

const ENABLED_OPTIONS = [
  { value: 'all', label: 'All states' },
  { value: '1', label: 'Enabled' },
  { value: '0', label: 'Disabled' },
];

const WLAN_CSV_HEADERS = ['name', 'vlan', 'security', 'targets', 'plane', 'enabled', 'note'] as const;

function wlanRowKey(row: SsidObject): string {
  return `${row.name}|${row.vlan}|${row.targets}`;
}

function wlanCsvRows(rows: readonly SsidObject[]): Array<Array<unknown>> {
  return rows.map((w) => [
    w.name,
    w.vlan,
    w.security,
    w.targets,
    w.plane,
    w.enabled === undefined ? '' : w.enabled ? 'yes' : 'no',
    w.note ?? '',
  ]);
}

/** Client filter mirrors server filterMistWlanRows. */
export function filterMistWlansForView(
  wlans: SsidObject[],
  q: string,
  enabled: string,
): SsidObject[] {
  const ql = q.trim().toLowerCase();
  let enabledWant: boolean | null = null;
  const er = enabled.trim().toLowerCase();
  if (er === '1' || er === 'true' || er === 'yes' || er === 'on') enabledWant = true;
  else if (er === '0' || er === 'false' || er === 'no' || er === 'off') enabledWant = false;
  if (!ql && enabledWant === null) return wlans;
  return wlans.filter((row) => {
    if (enabledWant !== null) {
      if (row.enabled !== true && row.enabled !== false) return false;
      if (row.enabled !== enabledWant) return false;
    }
    if (ql) {
      const hay = [row.name, row.vlan, row.security, row.targets, row.plane, row.note]
        .map((v) => String(v ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });
}

const wlanColumns: Array<DataTableColumn<SsidObject>> = [
  {
    key: 'name',
    title: 'SSID',
    hideable: false,
    render: (row) => {
      const to = buildSsidDeepLink(row, 'MIST') ?? '/configure';
      return (
        <Link
          to={to}
          aria-label={`Edit WLAN ${row.name} in Configure`}
          className="nt-text-primary"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <span className="nt-block-12-pri">
            {row.name}
            {row.enabled !== undefined ? (
              <>
                {' '}
                <Badge tone={row.enabled ? 'success' : 'neutral'}>
                  {row.enabled ? 'enabled' : 'disabled'}
                </Badge>
              </>
            ) : null}
          </span>
        </Link>
      );
    },
  },
  {
    key: 'scope',
    title: 'Scope',
    render: (row) => (
      <span className="nt-hint-muted">
        {row.targets}
        {row.note ? ` · ${row.note}` : ''}
      </span>
    ),
  },
  {
    key: 'security',
    title: 'Security / VLAN',
    render: (row) => (
      <span className="nt-hint-muted nt-ta-right">
        {row.security} · {row.vlan}
      </span>
    ),
  },
];

export function WlanSummary({
  wlans,
  live = false,
}: {
  wlans: SsidObject[] | null | undefined;
  /** Gates **Download server CSV** (live Mist envelope only). */
  live?: boolean;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [enabled, setEnabled] = useState(() => {
    const e = searchParams.get('enabled')?.trim().toLowerCase() ?? '';
    if (e === '1' || e === 'true' || e === 'yes' || e === 'on') return '1';
    if (e === '0' || e === 'false' || e === 'no' || e === 'off') return '0';
    return 'all';
  });
  /* Deep link: /mist?section=wlans&names=a\nb (bulk Copy selection link). */
  const namesFilter = namesFilterForParam(searchParams.get('names'));

  /* Keep q/enabled shareable when the WLANs section is in focus (section=wlans
     or no section). Do not clobber other Mist section deep-links. */
  useEffect(() => {
    const section = (searchParams.get('section') ?? '').toLowerCase();
    if (section && section !== 'wlans' && section !== 'wlan' && section !== 'ssid' && section !== 'ssids') {
      return;
    }
    const next = new URLSearchParams(searchParams);
    const qTrim = q.trim();
    if (qTrim) next.set('q', qTrim);
    else next.delete('q');
    if (enabled !== 'all') next.set('enabled', enabled);
    else next.delete('enabled');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [q, enabled, searchParams, setSearchParams]);

  const filtered = useMemo(
    () => (wlans ? filterMistWlansForView(wlans, q, enabled) : []),
    [wlans, q, enabled],
  );
  const rows =
    namesFilter === null
      ? filtered
      : filtered.filter((w) => namesFilter.includes(w.name));
  const namesPresent =
    namesFilter === null
      ? 0
      : namesFilter.filter((name) => (wlans ?? []).some((w) => w.name === name)).length;

  /* Enabled chips count over q (not enabled) so the on/off mix stays visible. */
  const enabledUniverse = useMemo(
    () => (wlans ? filterMistWlansForView(wlans, q, 'all') : []),
    [wlans, q],
  );
  const enabledChips = (
    [
      { key: '1' as const, label: 'Enabled', tone: 'success' as const },
      { key: '0' as const, label: 'Disabled', tone: 'neutral' as const },
    ] as const
  )
    .map((m) => ({
      ...m,
      count: enabledUniverse.filter((w) =>
        m.key === '1' ? w.enabled === true : w.enabled === false,
      ).length,
    }))
    .filter((c) => c.count > 0 || enabled === c.key);

  const meta =
    wlans == null
      ? 'NOT REPORTED'
      : wlans.length === 0
        ? 'NONE'
        : namesFilter !== null
          ? `${countOf(rows.length, 'WLAN').toUpperCase()} OF ${wlans.length} · MIST`
          : `${countOf(filtered.length, 'WLAN').toUpperCase()}${
              filtered.length !== wlans.length ? ` OF ${wlans.length}` : ''
            } · MIST`;

  const exportClientCsv = () => {
    if (rows.length === 0) return;
    const n = exportTableCsv('mist-wlans.csv', [...WLAN_CSV_HEADERS], wlanCsvRows(rows));
    toast(`Exported ${countOf(n, 'WLAN')}`, {
      description: 'mist-wlans.csv — WLAN inventory currently on screen (no PSKs).',
    });
  };

  const exportServerCsv = () => {
    void (async () => {
      const qs = new URLSearchParams({ part: 'wlans' });
      if (q.trim()) qs.set('q', q.trim());
      if (enabled !== 'all') qs.set('enabled', enabled);
      const res = await downloadApiCsv(`/api/mist/export?${qs.toString()}`, 'mist-wlans.csv');
      if (res.ok) {
        toast('Server CSV downloaded', {
          description: 'mist-wlans.csv — Mist WLAN inventory (no PSKs).',
          tone: 'success',
        });
      } else {
        toast('Server CSV failed', {
          description: res.error ?? 'Could not download export',
          tone: 'warning',
        });
      }
    })();
  };

  return (
    <div id="mist-section-wlans" className="nt-mist-section nt-section-panel nt-stack nt-gap-2">
      <div className="nt-row-between-12">
        <div className="nt-plane-theater nt-plane-theater--compact" role="note">HPE Network Tools · Mist WLAN theater · SSID fabric</div>
        <SectionHeader label="WLANs" meta={meta} />
        <div className="nt-wrap-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const url = buildMistShareUrl('wlans');
              /* Append active WLAN filters so the section link reopens the strip. */
              const u = new URL(url, window.location.origin);
              if (q.trim()) u.searchParams.set('q', q.trim());
              if (enabled !== 'all') u.searchParams.set('enabled', enabled);
              const finalUrl = u.toString();
              void navigator.clipboard.writeText(finalUrl).then(
                () =>
                  toast('WLANs section link copied', {
                    description: u.searchParams.toString() || 'section=wlans',
                    tone: 'success',
                  }),
                () => toast('Could not copy link', { description: finalUrl, tone: 'warning' }),
              );
            }}
          >
            Copy section link
          </Button>
          {rows.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={exportClientCsv}>
              Export CSV
            </Button>
          ) : null}
          {live && wlans != null ? (
            <Button variant="ghost" size="sm" onClick={exportServerCsv}>
              Download server CSV
            </Button>
          ) : null}
        </div>
      </div>
      {wlans == null ? (
        <div className="nt-service-note">
          The WLAN inventory was not read this cycle — a failed read, no linked Mist plane, or the
          plane named it unavailable.{' '}
          <Link to="/configure" className="nt-accent-text">
            Configure
          </Link>{' '}
          carries the same read when it is available.
        </div>
      ) : wlans.length === 0 ? (
        <div className="nt-service-note">Mist reported no WLANs — a real answer, not a failed read.</div>
      ) : (
        <>
          <div className="nt-filter-bar nt-gap-8">
            <div className="nt-filter-field nt-min-w-160">
              <Input
                size="sm"
                mono
                placeholder="Filter WLANs…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Filter Mist WLANs"
              />
            </div>
            <div className="nt-filter-field nt-filter-field--md">
              <Select
                options={ENABLED_OPTIONS}
                value={enabled}
                onValueChange={setEnabled}
                size="sm"
                aria-label="WLAN enabled filter"
              />
            </div>
          </div>
          {enabledChips.length > 0 ? (
            <div className="nt-chip-row" role="group" aria-label="WLAN enabled">
              <span className="nt-chip-row__label">Enabled</span>
              {enabledChips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setEnabled(enabled === c.key ? 'all' : c.key)}
                  className={
                    enabled === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
                  }
                  aria-pressed={enabled === c.key}
                  data-enabled={c.key}
                >
                  <Badge tone={c.tone}>{c.label}</Badge>
                  <span className="nt-chip__count">{c.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          {namesFilter !== null ? (
            <div className="nt-chip-row" role="group" aria-label="Selection deep link">
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('names');
                  setSearchParams(next, { replace: true });
                  setSelectedKeys([]);
                }}
                title={namesFilter.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {namesPresent === namesFilter.length
                  ? `${namesFilter.length} selected WLAN${namesFilter.length === 1 ? '' : 's'}`
                  : `${namesPresent} of ${namesFilter.length} selected WLANs present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          {filtered.length === 0 ? (
            <div className="nt-stack nt-gap-8">
              <div className="nt-service-note">
                Nothing matches this WLAN filter. Clear q / enabled to see every SSID Mist reported.
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setQ('');
                    setEnabled('all');
                    setSelectedKeys([]);
                  }}
                >
                  Clear filters
                </Button>
              </div>
            </div>
          ) : rows.length === 0 ? (
            <div className="nt-stack nt-gap-8">
              <div className="nt-service-note">
                No Mist WLANs match the selection deep link — clear the selection filter to restore
                the filtered roster.
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('names');
                    setSearchParams(next, { replace: true });
                    setSelectedKeys([]);
                  }}
                >
                  Clear selection filter
                </Button>
              </div>
            </div>
          ) : (
            <DataTable
              ariaLabel="Mist WLANs"
              density="compact"
              columns={wlanColumns}
              rows={rows}
              rowKey={wlanRowKey}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
              onRowActivate={(row) => {
                const to = buildSsidDeepLink(row, 'MIST') ?? '/configure';
                navigate(to);
              }}
            />
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Mist WLAN selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy names, or share a selection link for only the WLANs you marked — full list
                export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((w) => selected.has(wlanRowKey(w)));
                    if (picked.length === 0) {
                      toast('No selected WLANs still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'mist-wlans-selected.csv',
                      [...WLAN_CSV_HEADERS],
                      wlanCsvRows(picked),
                    );
                    toast(`Exported ${countOf(n, 'selected WLAN')}`, {
                      description: 'mist-wlans-selected.csv — Mist WLAN inventory fields only (no PSKs).',
                      tone: 'success',
                    });
                  }}
                >
                  Export selected
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((w) => selected.has(wlanRowKey(w)));
                      if (picked.length === 0) {
                        toast('No selected WLANs still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const names = [
                        ...new Set(
                          picked
                            .map((w) => (w.name ?? '').trim())
                            .filter((name) => name && name !== '—'),
                        ),
                      ];
                      if (names.length === 0) {
                        toast('No names on the selected WLANs', {
                          description: 'Those rows did not publish an SSID name — export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = names.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(names.length, 'name')}`, {
                          description:
                            names.length < picked.length
                              ? `${picked.length - names.length} selected without a name skipped`
                              : 'newline-joined · paste into a ticket or change window',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy names', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy names
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((w) => selected.has(wlanRowKey(w)));
                      if (picked.length === 0) {
                        toast('No selected WLANs still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const names = [
                        ...new Set(
                          picked
                            .map((w) => (w.name ?? '').trim())
                            .filter((name) => name.length > 0),
                        ),
                      ];
                      if (names.length === 0) {
                        toast('No names on the selected WLANs', {
                          description: 'Export CSV for row detail instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('names', names.join('\n'));
                      next.set('section', 'wlans');
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}#mist-section-wlans`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${names.length} WLAN${names.length === 1 ? '' : 's'} · names=`,
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy link', { description: url, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy selection link
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                  Clear
                </Button>
              </span>
            </div>
          ) : null}
          <div className="nt-fs-105 nt-hint-muted">
            Scope text as Mist reports it — the same WLAN at several sites is one row naming them
            all. Edits go through{' '}
            <Link to="/configure" className="nt-accent-text">
              Configure&apos;s Mist flow
            </Link>
            .
          </div>
        </>
      )}
    </div>
  );
}
