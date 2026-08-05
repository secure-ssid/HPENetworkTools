/**
 * web/src/screens/mist/rogues.tsx — the rogue/neighbor AP row rendering,
 * shared by the site page's per-site section (siteDetail/RogueAps.tsx) and
 * the Mist screen's across-sites section below.
 *
 * The row bits (sort, verdict badge, columns) are extracted here unchanged so the
 * two screens can never drift on what the on-your-wire flag means: true is
 * the alarm (a rogue whose BSSID resolves to YOUR wired infrastructure),
 * false is a neighbor, null reads "not reported" — never an assumed safe.
 * `EstateRogueAps` adds the across-sites wrapper: on-your-wire rows lead
 * under a danger Alert, each row naming its site, with the same honesty
 * rules as the site section (absent = not reported, empty = a real answer).
 *
 * Multi-select (Loop 193) raises **Export selected**, **Copy BSSIDs**
 * (unique newline-joined), **Copy names** (unique newline-joined SSIDs when
 * BSSIDs alone are sparse for a handoff — Devices **Copy names** pattern;
 * Loop 234), **Copy selection link** (`?bssids=` + section=rogues;
 * clearable chip), and Clear. Selection-empty `?bssids=` offers
 * **Clear selection filter** (Loop 211).
 */

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, DataTable, SectionHeader, useToast } from '../../nightdesk';
import type { DataTableColumn } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { MistRogueApRow } from '@hpe/shared';
import { namesFilterForParam } from '../../app/nav';
import { exportTableCsv } from '../../lib/csv';
import { buildMistShareUrl } from './share';

/** On-LAN first, then strongest signal first; a row with no reported signal
 *  settles after every reported one rather than reading as the weakest. */
export function byAlarmThenSignal(a: MistRogueApRow, b: MistRogueApRow): number {
  const alarmA = a.seenOnLan === true ? 0 : 1;
  const alarmB = b.seenOnLan === true ? 0 : 1;
  if (alarmA !== alarmB) return alarmA - alarmB;
  return (b.avgRssi ?? -Infinity) - (a.avgRssi ?? -Infinity);
}

export function VerdictBadge({ row }: { row: MistRogueApRow }) {
  if (row.seenOnLan === true) return <Badge tone="danger">ON YOUR WIRE</Badge>;
  if (row.seenOnLan === false) return <Badge tone="neutral">neighbor</Badge>;
  return <Badge tone="neutral">not reported</Badge>;
}

/** Stable multi-select / deep-link key — site + BSSID (estate can repeat BSSIDs). */
export function rogueRowKey(row: MistRogueApRow): string {
  return `${row.siteId}:${row.bssid}`;
}

export const ROGUE_CSV_HEADERS = [
  'site',
  'bssid',
  'ssid',
  'channel',
  'avgRssi',
  'numAps',
  'seenOnLan',
] as const;

export function rogueCsvRows(rows: readonly MistRogueApRow[]): Array<Array<unknown>> {
  return rows.map((r) => [
    r.siteName,
    r.bssid,
    r.ssid ?? '',
    r.channel ?? '',
    r.avgRssi ?? '',
    r.numAps ?? '',
    r.seenOnLan === true ? 'yes' : r.seenOnLan === false ? 'no' : '',
  ]);
}

export function RogueRow({ row, siteLabel = false }: { row: MistRogueApRow; siteLabel?: boolean }) {
  const facts = [
    row.channel !== null ? `ch ${row.channel}` : null,
    row.avgRssi !== null ? `${row.avgRssi} dBm` : null,
    row.numAps !== null ? `heard by ${countOf(row.numAps, 'AP')}` : null,
  ]
    .filter((f): f is string => f !== null)
    .join(' · ');
  return (
    <Link
      to={`/sites/${encodeURIComponent(row.siteId)}`}
      aria-label={`Open site ${row.siteName} for rogue ${row.bssid}`}
      className="nt-mist-row"
    >
      <VerdictBadge row={row} />
      <span className="nt-flex-1">
        <span className="nt-fs-12-pri">
          {row.ssid ?? 'SSID not broadcast'}
        </span>
        <span className="nt-fs-10">
          {row.bssid}
          {siteLabel ? ` · ${row.siteName}` : ''}
        </span>
      </span>
      <span className="nt-note-right nt-service-note">
        {facts || 'no readings reported'}
      </span>
    </Link>
  );
}

export function rogueColumns(siteLabel: boolean): Array<DataTableColumn<MistRogueApRow>> {
  return [
    {
      key: 'verdict',
      title: 'Verdict',
      hideable: false,
      render: (row) => <VerdictBadge row={row} />,
    },
    {
      key: 'ssid',
      title: 'SSID',
      hideable: false,
      sortValue: (row) => row.ssid ?? '',
      render: (row) => (
        <Link
          to={`/sites/${encodeURIComponent(row.siteId)}`}
          aria-label={`Open site ${row.siteName} for rogue ${row.bssid}`}
          className="nt-text-primary"
          onClick={(e) => {
            /* Row activate also navigates — keep the explicit link for a11y tests. */
            e.stopPropagation();
          }}
        >
          <span className="nt-flex-1">
            <span className="nt-fs-12-pri">{row.ssid ?? 'SSID not broadcast'}</span>
            <span className="nt-fs-10">
              {row.bssid}
              {siteLabel ? ` · ${row.siteName}` : ''}
            </span>
          </span>
        </Link>
      ),
    },
    {
      key: 'facts',
      title: 'Heard',
      render: (row) => {
        const facts = [
          row.channel !== null ? `ch ${row.channel}` : null,
          row.avgRssi !== null ? `${row.avgRssi} dBm` : null,
          row.numAps !== null ? `heard by ${countOf(row.numAps, 'AP')}` : null,
        ]
          .filter((f): f is string => f !== null)
          .join(' · ');
        return <span className="nt-note-right nt-service-note">{facts || 'no readings reported'}</span>;
      },
    },
  ];
}

/**
 * The Mist screen's across-sites section: every site's rogue/neighbor report
 * in one list, on-your-wire first. `rogues` ABSENT means the walk was not
 * reported this cycle (a failed read, or no linked Mist plane) — worded as
 * such, never as an all-clear; present-and-empty is the real all-clear.
 */
export function EstateRogueAps({ rogues }: { rogues: MistRogueApRow[] | undefined }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /mist?section=rogues&bssids=aa\nbb (bulk Copy selection link). */
  const bssidsFilter = namesFilterForParam(searchParams.get('bssids'));

  const sorted = rogues === undefined ? [] : [...rogues].sort(byAlarmThenSignal);
  const rows =
    bssidsFilter === null
      ? sorted
      : sorted.filter((r) => bssidsFilter.includes(r.bssid));
  const bssidsPresent =
    bssidsFilter === null
      ? 0
      : bssidsFilter.filter((b) => sorted.some((r) => r.bssid === b)).length;
  const onLan = rows.filter((r) => r.seenOnLan === true);
  const sites = new Set(rows.map((r) => r.siteId)).size;
  const meta =
    rogues === undefined
      ? 'NOT REPORTED'
      : sorted.length === 0
        ? 'NONE HEARD'
        : bssidsFilter !== null
          ? `${countOf(rows.length, 'HEARD').toUpperCase()} OF ${sorted.length} · MIST`
          : `${onLan.length > 0 ? `${onLan.length} ON YOUR WIRE · ` : ''}${rows.length} HEARD · ${countOf(sites, 'SITE').toUpperCase()} · MIST`;

  return (
    <div id="mist-section-rogues" className="nt-mist-section nt-section-panel nt-stack nt-gap-2">
      <div className="nt-row-between-12">
        <SectionHeader label="Rogue & neighbor APs" meta={meta} />
        <div className="nt-wrap-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const url = buildMistShareUrl('rogues');
              void navigator.clipboard.writeText(url).then(
                () => toast('Rogues section link copied', { description: 'section=rogues', tone: 'success' }),
                () => toast('Could not copy link', { description: url, tone: 'warning' }),
              );
            }}
          >
            Copy section link
          </Button>
          {rows.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const n = exportTableCsv(
                  'mist-rogues.csv',
                  [...ROGUE_CSV_HEADERS],
                  rogueCsvRows(rows),
                );
                toast(`Exported ${n} rogue${n === 1 ? '' : 's'}`, {
                  description: 'mist-rogues.csv — BSSIDs currently in this section (on-wire first).',
                });
              }}
            >
              Export CSV
            </Button>
          ) : null}
        </div>
      </div>
      {rogues === undefined ? (
        <div className="nt-service-note">
          The rogue/neighbor walk was not reported this cycle — a failed read, or no linked Mist
          plane. Nothing below is an all-clear.
        </div>
      ) : sorted.length === 0 ? (
        <div className="nt-service-note">
          Mist reported no rogue or neighbor BSSIDs at any site this cycle — nothing in earshot is a
          real answer, not a failed read.
        </div>
      ) : (
        <>
          {bssidsFilter !== null ? (
            <div className="nt-chip-row" role="group" aria-label="Rogue selection deep link">
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('bssids');
                  setSearchParams(next, { replace: true });
                  setSelectedKeys([]);
                }}
                title={bssidsFilter.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {bssidsPresent === bssidsFilter.length
                  ? `${bssidsFilter.length} selected BSSID${bssidsFilter.length === 1 ? '' : 's'}`
                  : `${bssidsPresent} of ${bssidsFilter.length} selected BSSIDs present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          {onLan.length > 0 ? (
            <Alert tone="danger" title={`${countOf(onLan.length, 'rogue BSSID')} on your wire`}>
              A rogue AP whose traffic reaches your wired infrastructure is the finding to act on —
              everything below it is only in earshot.{' '}
              {onLan.map((r) => `${r.ssid ?? r.bssid} (${r.siteName})`).join(' · ')}
            </Alert>
          ) : null}
          {rows.length === 0 ? (
            <div className="nt-stack nt-gap-8">
              <div className="nt-service-note">
                No rogue BSSIDs match the selection deep link — clear the selection filter to
                restore the full estate list.
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('bssids');
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
              ariaLabel="Mist rogue and neighbor APs"
              columns={rogueColumns(true)}
              rows={rows}
              rowKey={rogueRowKey}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
              onRowActivate={(row) => navigate(`/sites/${encodeURIComponent(row.siteId)}`)}
            />
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Mist rogue selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy BSSIDs or SSIDs, or share a selection link for only the rogues you marked
                — full list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((r) => selected.has(rogueRowKey(r)));
                    if (picked.length === 0) {
                      toast('No selected rogues still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'mist-rogues-selected.csv',
                      [...ROGUE_CSV_HEADERS],
                      rogueCsvRows(picked),
                    );
                    toast(`Exported ${countOf(n, 'selected rogue')}`, {
                      description: 'mist-rogues-selected.csv — BSSID inventory fields only.',
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
                      const picked = rows.filter((r) => selected.has(rogueRowKey(r)));
                      if (picked.length === 0) {
                        toast('No selected rogues still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const bssids = [
                        ...new Set(
                          picked
                            .map((r) => (r.bssid ?? '').trim())
                            .filter((b) => b.length > 0),
                        ),
                      ];
                      if (bssids.length === 0) {
                        toast('No BSSIDs on the selected rogues', {
                          description: 'Use Copy names or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = bssids.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(bssids.length, 'BSSID')}`, {
                          description:
                            bssids.length < picked.length
                              ? `${picked.length - bssids.length} selected without a BSSID skipped`
                              : 'newline-joined · paste into a ticket or change window',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy BSSIDs', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy BSSIDs
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((r) => selected.has(rogueRowKey(r)));
                      if (picked.length === 0) {
                        toast('No selected rogues still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const names = [
                        ...new Set(
                          picked
                            .map((r) => (r.ssid ?? '').trim())
                            .filter((name) => name.length > 0 && name !== '—'),
                        ),
                      ];
                      if (names.length === 0) {
                        toast('No names on the selected rogues', {
                          description:
                            'Those rows did not publish an SSID — use Copy BSSIDs or export CSV instead.',
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
                              ? `${picked.length - names.length} selected without an SSID skipped`
                              : 'newline-joined · paste into a ticket or handoff',
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
                      const picked = rows.filter((r) => selected.has(rogueRowKey(r)));
                      if (picked.length === 0) {
                        toast('No selected rogues still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const bssids = [
                        ...new Set(
                          picked
                            .map((r) => (r.bssid ?? '').trim())
                            .filter((b) => b.length > 0),
                        ),
                      ];
                      if (bssids.length === 0) {
                        toast('No BSSIDs on the selected rogues', {
                          description: 'Use Copy names or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('bssids', bssids.join('\n'));
                      next.set('section', 'rogues');
                      const qs = next.toString();
                      const path =
                        !window.location.pathname || window.location.pathname === '/'
                          ? '/mist'
                          : window.location.pathname;
                      const url = `${window.location.origin}${path}${qs ? `?${qs}` : ''}#mist-section-rogues`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${bssids.length} BSSID${bssids.length === 1 ? '' : 's'} · bssids=`,
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
