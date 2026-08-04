/**
 * web/src/screens/central/FirmwareSection.tsx — devices behind their
 * recommended firmware train.
 *
 * The verdict is the PLANE'S OWN: its approved-train check
 * (firmwareApproved), carried with the recommended train when the plane
 * publishes one and its own upgrade state word verbatim. The portal never
 * compares version strings itself — a train it invented would be the one
 * verdict on this screen nobody can act on.
 *
 * Honest states: no device inventory this cycle means no verdict can be
 * asserted (never an implied clean bill); an empty list over a reported
 * inventory is the real "everything is on its train".
 *
 * Multi-select raises **Export selected**, **Copy serials** (unique
 * newline-joined inventory serials — Devices **Copy serials** pattern),
 * **Copy selection link** (`?serials=` of unique inventory serials with
 * `section=firmware` — Licences `?skus=` pattern; clearable chip while
 * active; Loop 181), and Clear (Loop 177).
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, DataTable, SectionHeader, useToast } from '../../nightdesk';
import type { DataTableColumn } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { CentralFirmwareRow } from '@hpe/shared';
import { deviceDetailPath, namesFilterForParam } from '../../app/nav';
import { exportTableCsv } from '../../lib/csv';

const firmwareColumns: Array<DataTableColumn<CentralFirmwareRow>> = [
  {
    key: 'device',
    title: 'Device',
    hideable: false,
    render: (row) => (
      <>
        <Link
          to={deviceDetailPath({ name: row.name, plane: 'CENTRAL', serial: row.serial })}
          className="nt-text-primary"
        >
          {row.name}
        </Link>
        <span className="nt-hint-muted nt-ml-8">{row.model}</span>
      </>
    ),
  },
  { key: 'site', title: 'Site', render: (row) => row.siteName },
  {
    key: 'installed',
    title: 'Installed',
    render: (row) => <Badge tone="warning">{row.firmware}</Badge>,
  },
  {
    key: 'recommended',
    title: 'Recommended',
    render: (row) => row.target ?? <span className="nt-service-note">approved-train verdict</span>,
  },
  {
    key: 'upgrade',
    title: 'Upgrade state',
    render: (row) => row.update ?? <span className="nt-service-note">—</span>,
  },
];

function firmwareRowKey(row: CentralFirmwareRow): string {
  return `${row.name}|${row.serial ?? ''}`;
}

export function FirmwareSection({
  rows,
  devicesReported,
  fleetTotal,
  density,
}: {
  rows: CentralFirmwareRow[];
  devicesReported: boolean;
  fleetTotal: number;
  density: 'comfortable' | 'compact';
}) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /central?section=firmware&serials=a\nb (bulk Copy selection link). */
  const serialsFilter = namesFilterForParam(searchParams.get('serials'));
  const serialsFilterLc =
    serialsFilter === null
      ? null
      : serialsFilter.map((serial) => serial.trim().toLowerCase()).filter(Boolean);
  const viewRows =
    serialsFilterLc === null
      ? rows
      : rows.filter((r) => serialsFilterLc.includes((r.serial ?? '').trim().toLowerCase()));
  const serialsPresent =
    serialsFilterLc === null
      ? 0
      : serialsFilterLc.filter((serial) =>
          rows.some((r) => (r.serial ?? '').trim().toLowerCase() === serial),
        ).length;
  const meta = !devicesReported
    ? 'NOT REPORTED'
    : rows.length === 0
      ? 'ALL ON APPROVED TRAINS'
      : serialsFilterLc !== null
        ? `${countOf(viewRows.length, 'DEVICE').toUpperCase()} OF ${rows.length} BEHIND`
        : `${countOf(rows.length, 'DEVICE').toUpperCase()} BEHIND`;

  const copySectionLink = () => {
    const url = `${window.location.origin}/central?section=firmware#firmware`;
    void navigator.clipboard.writeText(url).then(
      () => toast('Firmware section link copied', { description: 'section=firmware', tone: 'success' }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  const exportCsv = () => {
    if (viewRows.length === 0) return;
    const n = exportTableCsv(
      'central-firmware.csv',
      ['name', 'model', 'type', 'site', 'firmware', 'target', 'update', 'serial'],
      viewRows.map((f) => [
        f.name,
        f.model,
        f.type,
        f.siteName,
        f.firmware,
        f.target ?? '',
        f.update ?? '',
        f.serial ?? '',
      ]),
    );
    toast(`Exported ${n} firmware row${n === 1 ? '' : 's'}`, {
      description: 'central-firmware.csv — devices behind approved trains.',
    });
  };

  return (
    <div id="central-section-firmware" className="nt-stack nt-gap-2 nt-central-section nt-section-panel">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · firmware theater · compliance owns hue</div>
      <div className="nt-row-between-12">
        <SectionHeader label="Firmware" meta={meta} />
        <div className="nt-wrap-6">
          <Button variant="ghost" size="sm" onClick={copySectionLink}>
            Copy section link
          </Button>
          {viewRows.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
          ) : null}
        </div>
      </div>
      {!devicesReported ? (
        <div className="nt-service-note">
          Central did not report its device inventory this cycle, so no firmware verdict can be
          asserted — this is an unread estate, not a compliant one.
        </div>
      ) : rows.length === 0 ? (
        <div className="nt-service-note">
          {fleetTotal > 0
            ? `Every one of the ${countOf(fleetTotal, 'device')} Central manages is on its approved firmware train.`
            : 'Central reported no devices — no firmware verdicts to give.'}
        </div>
      ) : (
        <>
          {serialsFilterLc !== null ? (
            <div className="nt-chip-row" role="group" aria-label="Selection deep link">
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('serials');
                  setSearchParams(next, { replace: true });
                  setSelectedKeys([]);
                }}
                title={serialsFilter?.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {serialsPresent === serialsFilterLc.length
                  ? `${serialsFilterLc.length} selected serial${serialsFilterLc.length === 1 ? '' : 's'}`
                  : `${serialsPresent} of ${serialsFilterLc.length} selected serials present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          {viewRows.length === 0 ? (
            <div className="nt-service-note">
              No firmware rows match the selection deep link — clear the chip to restore the behind-train list.
            </div>
          ) : (
            <DataTable
              ariaLabel="Central firmware behind approved trains"
              density={density}
              columns={firmwareColumns}
              rows={viewRows}
              rowKey={firmwareRowKey}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
            />
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Central firmware selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy serials, or share a selection link for only the behind devices you marked — full list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = viewRows.filter((r) => selected.has(firmwareRowKey(r)));
                    if (picked.length === 0) {
                      toast('No selected firmware rows still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'central-firmware-selected.csv',
                      ['name', 'model', 'type', 'site', 'firmware', 'target', 'update', 'serial'],
                      picked.map((f) => [
                        f.name,
                        f.model,
                        f.type,
                        f.siteName,
                        f.firmware,
                        f.target ?? '',
                        f.update ?? '',
                        f.serial ?? '',
                      ]),
                    );
                    toast(`Exported ${countOf(n, 'selected firmware row')}`, {
                      description: 'central-firmware-selected.csv — behind-train fields only.',
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
                      const picked = viewRows.filter((r) => selected.has(firmwareRowKey(r)));
                      if (picked.length === 0) {
                        toast('No selected firmware rows still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const serials = [
                        ...new Set(
                          picked
                            .map((r) => (r.serial ?? '').trim())
                            .filter((serial) => serial && serial !== '—'),
                        ),
                      ];
                      if (serials.length === 0) {
                        toast('No serials on the selected devices', {
                          description: 'Those rows did not publish a serial — export CSV for names instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = serials.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(serials.length, 'serial')}`, {
                          description:
                            serials.length < picked.length
                              ? `${picked.length - serials.length} selected without a serial skipped`
                              : 'newline-joined · paste into a ticket or RMA',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy serials', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy serials
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = viewRows.filter((r) => selected.has(firmwareRowKey(r)));
                      if (picked.length === 0) {
                        toast('No selected firmware rows still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const serials = [
                        ...new Set(
                          picked
                            .map((r) => (r.serial ?? '').trim())
                            .filter((serial) => serial && serial !== '—'),
                        ),
                      ];
                      if (serials.length === 0) {
                        toast('No serials on the selected devices', {
                          description: 'Those rows did not publish a serial — export CSV for names instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('serials', serials.join('\n'));
                      next.set('section', 'firmware');
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${serials.length} serial${serials.length === 1 ? '' : 's'} · serials=`,
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
            The verdict is the plane&rsquo;s own approved-train check; upgrades are scheduled in
            Central, not from here.
          </div>
        </>
      )}
    </div>
  );
}
