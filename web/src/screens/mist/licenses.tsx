/**
 * web/src/screens/mist/licenses.tsx — the Mist screen's licence usage table:
 * per-site consumption as /orgs/{org}/licenses/usages reports it, the one
 * plane that publishes the read.
 *
 * The honesty rules are the Licenses screen's own (it renders the same
 * dataset): null means Mist reported NOTHING this cycle — not linked, or
 * the read failed — and is worded "not reported", never zero consumption;
 * an explicit 0 inside a service map is a real count and renders as one;
 * a service named only by the fully-loaded demand map renders its
 * consumption as '—', because the row did not state it.
 *
 * Multi-select raises **Export selected**, **Copy site ids** (unique
 * newline-joined site ids — Sites `?ids=` pattern), **Copy names** (unique
 * newline-joined site names when ids are sparse — Devices / Clients pattern;
 * Loop 231), **Copy selection link** (`?siteIds=` of marked site ids with
 * `section=licenses`; clearable chip while active — Loop 187), and Clear.
 * Selection-empty `?siteIds=` offers **Clear selection filter** (Loop 217).
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  DataTable,
  EmptyState,
  SectionHeader,
  useToast,
  type DataTableColumn,
} from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { MistLicenseUsageRow } from '@hpe/shared';
import { namesFilterForParam } from '../../app/nav';
import { exportTableCsv } from '../../lib/csv';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import { buildMistShareUrl } from './share';

/* The two counts a usage row may carry, each omitted when the row did not
   carry it — '0 devices' would be a claim Mist never made. */
function devicePart(row: MistLicenseUsageRow): string {
  const parts = [
    row.numDevices !== null ? countOf(row.numDevices, 'device') : null,
    row.numAps !== null ? countOf(row.numAps, 'AP') : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : 'device counts not reported';
}

/* One site's per-service consumption against its fully-loaded demand
   ('SUB-SW 22 / 24') — used / demand, '—' when the row did not state a
   consumption for a service the demand map names. */
function servicePart(row: MistLicenseUsageRow): string {
  if (row.usages === null) return 'consumption not reported';
  const usages = row.usages;
  const services = [...new Set([...Object.keys(usages), ...Object.keys(row.fullyLoaded ?? {})])];
  return services
    .map((service) => {
      const used = usages[service];
      const demand = row.fullyLoaded?.[service];
      const usedText = typeof used === 'number' ? String(used) : '—';
      return typeof demand === 'number' ? `${service} ${usedText} / ${demand}` : `${service} ${usedText}`;
    })
    .join(' · ');
}

function servicesCsvCell(row: MistLicenseUsageRow): string {
  if (row.usages === null && row.fullyLoaded === null) return '';
  const usages = row.usages ?? {};
  const demand = row.fullyLoaded ?? {};
  const keys = [...new Set([...Object.keys(usages), ...Object.keys(demand)])].sort();
  return keys
    .map((k) => {
      const used = usages[k];
      const full = demand[k];
      const usedText = typeof used === 'number' ? String(used) : '—';
      return typeof full === 'number' ? `${k}=${usedText}/${full}` : `${k}=${usedText}`;
    })
    .join('|');
}

const LICENSE_CSV_HEADERS = ['site', 'siteId', 'numDevices', 'numAps', 'services'] as const;

function licenseCsvRows(rows: readonly MistLicenseUsageRow[]): Array<Array<unknown>> {
  return rows.map((row) => [
    row.siteName,
    row.siteId,
    row.numDevices ?? '',
    row.numAps ?? '',
    servicesCsvCell(row),
  ]);
}

const licenseColumns: Array<DataTableColumn<MistLicenseUsageRow>> = [
  {
    key: 'site',
    title: 'Site',
    hideable: false,
    render: (row) => (
      <span className="nt-flex-1">
        <span className="nt-fs-12-pri">{row.siteName}</span>
        <span className="nt-fs-10">{devicePart(row)}</span>
      </span>
    ),
  },
  {
    key: 'services',
    title: 'Usage',
    render: (row) => <span className="nt-note-right nt-service-note">{servicePart(row)}</span>,
  },
];

export function LicenseUsageSection({
  licenseUsages,
  live = false,
}: {
  licenseUsages: MistLicenseUsageRow[] | null | undefined;
  /** Gates **Download server CSV** (live Mist envelope only). */
  live?: boolean;
}) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /mist?section=licenses&siteIds=a\nb (bulk Copy selection link). */
  const siteIdsFilter = namesFilterForParam(searchParams.get('siteIds'));
  const allRows = licenseUsages ?? [];
  const rows =
    siteIdsFilter === null
      ? allRows
      : allRows.filter((r) => siteIdsFilter.includes(r.siteId));
  const siteIdsPresent =
    siteIdsFilter === null
      ? 0
      : siteIdsFilter.filter((id) => allRows.some((r) => r.siteId === id)).length;

  const meta =
    licenseUsages == null
      ? 'NOT REPORTED'
      : licenseUsages.length === 0
        ? 'NO SITES'
        : siteIdsFilter !== null
          ? `${countOf(rows.length, 'SITE').toUpperCase()} OF ${licenseUsages.length} · USED / FULLY-LOADED · MIST`
          : `${countOf(licenseUsages.length, 'SITE').toUpperCase()} · USED / FULLY-LOADED · MIST`;

  const exportClientCsv = () => {
    if (rows.length === 0) return;
    const n = exportTableCsv('mist-licenses.csv', [...LICENSE_CSV_HEADERS], licenseCsvRows(rows));
    toast(`Exported ${countOf(n, 'site')}`, {
      description: 'mist-licenses.csv — per-site usage tallies currently on screen.',
    });
  };

  const exportServerCsv = () => {
    void (async () => {
      const res = await downloadApiCsv('/api/mist/export?part=licenses', 'mist-licenses.csv');
      if (res.ok) {
        toast('Server CSV downloaded', {
          description: 'mist-licenses.csv — per-site Mist licence usage tallies.',
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
    <div id="mist-section-licenses" className="nt-mist-section nt-section-panel nt-stack nt-gap-2">
      <div className="nt-row-between-12">
        <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · Mist entitlement lane · usage owns hue</div>
        <SectionHeader label="Licence usage per site" meta={meta} />
        <div className="nt-wrap-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const url = buildMistShareUrl('licenses');
              void navigator.clipboard.writeText(url).then(
                () => toast('Licences section link copied', { description: 'section=licenses', tone: 'success' }),
                () => toast('Could not copy link', { description: url, tone: 'warning' }),
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
          {live && licenseUsages != null ? (
            <Button variant="ghost" size="sm" onClick={exportServerCsv}>
              Download server CSV
            </Button>
          ) : null}
        </div>
      </div>
      {licenseUsages == null ? (
        <div className="nt-service-note">
          Mist reported no licence usage this cycle — the plane is not linked, or the usages read
          failed. Absent is not zero consumption.
        </div>
      ) : licenseUsages.length === 0 ? (
        <div className="nt-service-note">
          Mist answered the usages read with no per-site rows — a real answer, not a failed read.
        </div>
      ) : (
        <>
          {siteIdsFilter !== null ? (
            <div className="nt-chip-row" role="group" aria-label="Selection deep link">
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('siteIds');
                  setSearchParams(next, { replace: true });
                  setSelectedKeys([]);
                }}
                title={siteIdsFilter.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {siteIdsPresent === siteIdsFilter.length
                  ? `${siteIdsFilter.length} selected site${siteIdsFilter.length === 1 ? '' : 's'}`
                  : `${siteIdsPresent} of ${siteIdsFilter.length} selected sites present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          {rows.length === 0 ? (
            siteIdsFilter !== null ? (
              <EmptyState
                title="No licence rows match this selection"
                description="Clear the selection filter to restore the full usage table."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('siteIds');
                    setSearchParams(next, { replace: true });
                    setSelectedKeys([]);
                  }}
                >
                  Clear selection filter
                </Button>
              </EmptyState>
            ) : (
              <div className="nt-service-note">
                No licence rows match the current filter.
              </div>
            )
          ) : (
            <DataTable
              ariaLabel="Mist licence usage"
              density="compact"
              columns={licenseColumns}
              rows={rows}
              rowKey={(r) => r.siteId}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
            />
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Mist licence selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy site ids or site names, or share a selection link for only the sites you
                marked — full list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((r) => selected.has(r.siteId));
                    if (picked.length === 0) {
                      toast('No selected licence rows still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'mist-licenses-selected.csv',
                      [...LICENSE_CSV_HEADERS],
                      licenseCsvRows(picked),
                    );
                    toast(`Exported ${countOf(n, 'selected site')}`, {
                      description: 'mist-licenses-selected.csv — per-site usage tallies only.',
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
                      const picked = rows.filter((r) => selected.has(r.siteId));
                      if (picked.length === 0) {
                        toast('No selected licence rows still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const ids = [
                        ...new Set(
                          picked
                            .map((r) => (r.siteId ?? '').trim())
                            .filter((id) => id && id !== '—'),
                        ),
                      ];
                      if (ids.length === 0) {
                        toast('No site ids on the selected rows', {
                          description: 'Those rows did not publish a site id — use Copy names or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = ids.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(ids.length, 'site id')}`, {
                          description:
                            ids.length < picked.length
                              ? `${picked.length - ids.length} selected without a site id skipped`
                              : 'newline-joined · paste into a ticket or change window',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy site ids', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy site ids
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((r) => selected.has(r.siteId));
                      if (picked.length === 0) {
                        toast('No selected licence rows still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const names = [
                        ...new Set(
                          picked
                            .map((r) => (r.siteName ?? '').trim())
                            .filter((name) => name && name !== '—'),
                        ),
                      ];
                      if (names.length === 0) {
                        toast('No names on the selected rows', {
                          description: 'Those rows did not publish a site name — export CSV for site ids instead.',
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
                              ? `${picked.length - names.length} selected without a site name skipped`
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
                      const picked = rows.filter((r) => selected.has(r.siteId));
                      if (picked.length === 0) {
                        toast('No selected licence rows still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const ids = [
                        ...new Set(
                          picked
                            .map((r) => (r.siteId ?? '').trim())
                            .filter((id) => id.length > 0),
                        ),
                      ];
                      if (ids.length === 0) {
                        toast('No site ids on the selected rows', {
                          description: 'Use Copy names or export CSV for row detail instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('siteIds', ids.join('\n'));
                      next.set('section', 'licenses');
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}#mist-section-licenses`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${ids.length} site${ids.length === 1 ? '' : 's'} · siteIds=`,
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
        </>
      )}
    </div>
  );
}
