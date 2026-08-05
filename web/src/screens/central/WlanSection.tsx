/**
 * web/src/screens/central/WlanSection.tsx — the Central screen's WLAN
 * summary: the WLAN inventory the plane's config read reported (the same
 * /network-config walk the Configure screen renders), each row's scope text
 * verbatim, with the count in the meta and the edit path left where it
 * belongs — Configure, linked from every state.
 *
 * Three states, the screen's standing rule: not-reported means the read did
 * not happen this cycle (never an implied empty org); present-and-empty is
 * Central's real "no WLANs" answer.
 *
 * Multi-select raises **Export selected**, **Copy names** (unique
 * newline-joined SSID names — Devices **Copy serials** pattern), **Copy
 * selection link** (`?names=` of marked SSID names with `section=wlans`;
 * clearable chip while active — Loop 183), and Clear. Selection-empty
 * `?names=` deep links offer **Clear selection filter** (Loop 207).
 */

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, DataTable, EmptyState, SectionHeader, useToast } from '../../nightdesk';
import type { DataTableColumn } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { SsidObject } from '@hpe/shared';
import { namesFilterForParam } from '../../app/nav';
import { buildSsidDeepLink } from '../configure/deepLink';
import { exportTableCsv } from '../../lib/csv';

function wlanRowKey(row: SsidObject): string {
  return `${row.name}|${row.vlan}|${row.targets}`;
}

const WLAN_CSV_HEADERS = ['name', 'vlan', 'security', 'targets', 'plane', 'enabled'] as const;

function wlanCsvRows(rows: readonly SsidObject[]): Array<Array<unknown>> {
  return rows.map((w) => [
    w.name,
    w.vlan,
    w.security,
    w.targets,
    w.plane,
    w.enabled === undefined ? '' : w.enabled ? 'yes' : 'no',
  ]);
}

const wlanColumns: Array<DataTableColumn<SsidObject>> = [
  {
    key: 'name',
    title: 'SSID',
    hideable: false,
    render: (row) => {
      const to = buildSsidDeepLink(row, 'CENTRAL') ?? '/configure';
      return (
        <Link
          to={to}
          aria-label={`Edit WLAN ${row.name} in Configure`}
          className="nt-text-primary"
          onClick={(e) => {
            /* Row activate also navigates — keep the explicit link for a11y tests. */
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

export function WlanSection({
  wlans,
  wlansReported,
  density = 'comfortable',
}: {
  wlans: SsidObject[];
  wlansReported: boolean;
  density?: 'comfortable' | 'compact';
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /central?section=wlans&names=a\nb (bulk Copy selection link). */
  const namesFilter = namesFilterForParam(searchParams.get('names'));
  const rows =
    namesFilter === null
      ? wlans
      : wlans.filter((w) => namesFilter.includes(w.name));
  const namesPresent =
    namesFilter === null
      ? 0
      : namesFilter.filter((name) => wlans.some((w) => w.name === name)).length;

  const meta = !wlansReported
    ? 'NOT REPORTED'
    : wlans.length === 0
      ? 'NONE'
      : namesFilter !== null
        ? `${countOf(rows.length, 'WLAN').toUpperCase()} OF ${wlans.length} · CENTRAL`
        : `${countOf(wlans.length, 'WLAN').toUpperCase()} · CENTRAL`;

  const copySectionLink = () => {
    const url = `${window.location.origin}/central?section=wlans#wlans`;
    void navigator.clipboard.writeText(url).then(
      () => toast('WLANs section link copied', { description: 'section=wlans', tone: 'success' }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  const exportCsv = () => {
    if (rows.length === 0) return;
    const n = exportTableCsv('central-wlans.csv', [...WLAN_CSV_HEADERS], wlanCsvRows(rows));
    toast(`Exported ${n} WLAN${n === 1 ? '' : 's'}`, {
      description: 'central-wlans.csv — Central WLAN inventory on this screen.',
    });
  };

  return (
    <div id="central-section-wlans" className="nt-stack nt-gap-2 nt-central-section nt-section-panel">
      <div className="nt-status-ribbon nt-status-ribbon--compact nt-wlan-ribbon" role="status" aria-label="WLAN status ribbon">
        <span className="nt-status-ribbon__item">WLAN · SSID fabric</span>
        <span className="nt-status-ribbon__item">security path</span>
      </div>
      <div className="nt-row-between-12">
        <SectionHeader label="WLANs" meta={meta} />
        <div className="nt-wrap-6">
          <Button variant="ghost" size="sm" onClick={copySectionLink}>
            Copy section link
          </Button>
          {rows.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
          ) : null}
        </div>
      </div>
      {!wlansReported ? (
        <div className="nt-service-note">
          The WLAN inventory was not read this cycle — a failed read, no linked Central plane, or
          the gateway named it unavailable.{' '}
          <Link to="/configure" className="nt-accent-text">
            Configure
          </Link>{' '}
          carries the same read when it is available.
        </div>
      ) : wlans.length === 0 ? (
        <div className="nt-service-note">Central reported no WLANs — a real answer, not a failed read.</div>
      ) : (
        <>
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
          {rows.length === 0 ? (
            <EmptyState
              title="No WLANs match this selection"
              description="Clear the selection filter to restore the full Central WLAN roster."
            >
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
            </EmptyState>
          ) : (
            <DataTable
              ariaLabel="Central WLANs"
              density={density}
              columns={wlanColumns}
              rows={rows}
              rowKey={wlanRowKey}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
              onRowActivate={(row) => {
                const to = buildSsidDeepLink(row, 'CENTRAL') ?? '/configure';
                navigate(to);
              }}
            />
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Central WLAN selection actions"
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
                      'central-wlans-selected.csv',
                      [...WLAN_CSV_HEADERS],
                      wlanCsvRows(picked),
                    );
                    toast(`Exported ${countOf(n, 'selected WLAN')}`, {
                      description: 'central-wlans-selected.csv — Central WLAN inventory fields only.',
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
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}#wlans`;
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
          <div className="nt-service-note nt-fs-105-pt6">
            Scope text as Central reports it — the same WLAN at several scopes is one row naming
            them all. Edits go through{' '}
            <Link to="/configure" className="nt-accent-text">
              Configure
            </Link>
            .
          </div>
        </>
      )}
    </div>
  );
}
