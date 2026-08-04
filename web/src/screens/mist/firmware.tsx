/**
 * web/src/screens/mist/firmware.tsx — the Mist screen's firmware section:
 * the Mist-claimed devices running BEHIND the recommended train, each
 * linking to its device page.
 *
 * The verdict rule is the Devices screen's own: a row is behind when the
 * plane published a recommended train (`firmwareTarget`), the device is not
 * approved-current (`firmwareApproved` false) and its running train is a
 * reported value at all. The plane's upgrade-state word (`firmwareUpdate`,
 * e.g. 'inprogress') rides verbatim beside it. Rows with no target read are
 * counted as unreported — the section never calls them compliant, and the
 * all-clear sentence only covers the rows the plane actually scored.
 *
 * Multi-select on behind rows raises **Export selected**, **Copy serials**
 * (unique newline-joined inventory serials — Devices **Copy serials**
 * pattern), **Copy names** (unique newline-joined device names when serials
 * are sparse — Devices / Topology pattern; Loop 225), **Copy selection link**
 * (`?serials=` of unique inventory serials with `section=devices` — Central
 * firmware pattern; clearable chip while active; Loop 184), and Clear
 * (Loop 180). Selection-empty `?serials=` offers **Clear selection filter**
 * (Loop 217).
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, DataTable, EmptyState, SectionHeader, useToast } from '../../nightdesk';
import type { DataTableColumn } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { DeviceRow } from '@hpe/shared';
import { deviceDetailPath, namesFilterForParam } from '../../app/nav';
import { exportTableCsv } from '../../lib/csv';
import { buildMistShareUrl } from './share';

/** The Devices screen's display rule: '—'/'unknown'/'' read "Not reported". */
function reportedFirmware(value: string): boolean {
  const normal = value.trim().toLowerCase();
  return value !== '' && normal !== '—' && normal !== 'unknown';
}

function mistDeviceRowKey(d: DeviceRow): string {
  return `${d.plane}:${d.serial ?? d.name}`;
}

const firmwareColumns: Array<DataTableColumn<DeviceRow>> = [
  {
    key: 'device',
    title: 'Device',
    hideable: false,
    render: (d) => (
      <Link
        to={deviceDetailPath({ name: d.name, plane: d.plane, serial: d.serial })}
        className="nt-text-primary"
      >
        {d.name}
      </Link>
    ),
  },
  {
    key: 'site',
    title: 'Site',
    render: (d) => d.siteName,
  },
  {
    key: 'verdict',
    title: 'Verdict',
    render: (d) => (
      <span className="nt-wrap-6">
        <Badge tone="warning">behind → {d.firmwareTarget}</Badge>
        {d.firmwareUpdate ? <Badge tone="neutral">{d.firmwareUpdate}</Badge> : null}
      </span>
    ),
  },
  {
    key: 'running',
    title: 'Running',
    render: (d) => <span className="nt-service-note">running {d.firmware}</span>,
  },
];

export function FirmwareSection({ devices }: { devices: DeviceRow[] }) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const scored = devices.filter((d) => d.firmwareTarget !== undefined);
  const behind = scored.filter((d) => !d.firmwareApproved && reportedFirmware(d.firmware));
  const unreported = devices.length - scored.length;
  /* Deep link: /mist?section=devices&serials=a\nb (bulk Copy selection link). */
  const serialsFilter = namesFilterForParam(searchParams.get('serials'));
  const serialsFilterLc =
    serialsFilter === null
      ? null
      : serialsFilter.map((serial) => serial.trim().toLowerCase()).filter(Boolean);
  const viewBehind =
    serialsFilterLc === null
      ? behind
      : behind.filter((d) => serialsFilterLc.includes((d.serial ?? '').trim().toLowerCase()));
  const serialsPresent =
    serialsFilterLc === null
      ? 0
      : serialsFilterLc.filter((serial) =>
          behind.some((d) => (d.serial ?? '').trim().toLowerCase() === serial),
        ).length;

  const copySectionLink = () => {
    const url = buildMistShareUrl('devices');
    void navigator.clipboard.writeText(url).then(
      () => toast('Devices section link copied', { description: 'section=devices', tone: 'success' }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  /** Behind-train compliance list — same verdict the section lists. */
  const exportComplianceCsv = () => {
    if (viewBehind.length === 0) return;
    const n = exportTableCsv(
      'mist-firmware-compliance.csv',
      [
        'name',
        'type',
        'model',
        'site',
        'state',
        'firmware',
        'serial',
        'firmwareTarget',
        'firmwareApproved',
        'firmwareUpdate',
      ],
      viewBehind.map((d) => [
        d.name,
        d.type,
        d.model,
        d.siteName,
        d.state,
        d.firmware,
        d.serial ?? '',
        d.firmwareTarget ?? '',
        d.firmwareApproved === undefined ? '' : d.firmwareApproved ? 'yes' : 'no',
        d.firmwareUpdate ?? '',
      ]),
    );
    toast(`Exported ${n} behind device${n === 1 ? '' : 's'}`, {
      description: 'mist-firmware-compliance.csv — devices not on their recommended train.',
    });
  };

  const exportDevicesCsv = () => {
    if (devices.length === 0) return;
    const n = exportTableCsv(
      'mist-devices.csv',
      ['name', 'type', 'model', 'site', 'state', 'firmware', 'serial', 'firmwareTarget', 'firmwareApproved', 'firmwareUpdate'],
      devices.map((d) => [
        d.name,
        d.type,
        d.model,
        d.siteName,
        d.state,
        d.firmware,
        d.serial ?? '',
        d.firmwareTarget ?? '',
        d.firmwareApproved === undefined ? '' : d.firmwareApproved ? 'yes' : 'no',
        d.firmwareUpdate ?? '',
      ]),
    );
    toast(`Exported ${n} device${n === 1 ? '' : 's'}`, {
      description: 'mist-devices.csv — Mist-claimed inventory on this screen.',
    });
  };

  return (
    <div id="mist-section-devices" className="nt-mist-section nt-section-panel nt-stack nt-gap-2">
      <div className="nt-row-between-12">
        <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · Mist firmware theater · compliance owns hue</div>
        <SectionHeader
          label="Firmware"
          meta={
            devices.length === 0
              ? 'NO DEVICES'
              : behind.length > 0
                ? `${
                    serialsFilterLc !== null
                      ? `${countOf(viewBehind.length, 'DEVICE').toUpperCase()} OF ${behind.length} BEHIND · `
                      : `${behind.length} BEHIND · `
                  }${countOf(devices.length, 'DEVICE').toUpperCase()} · MIST`
                : `${countOf(devices.length, 'DEVICE').toUpperCase()} · MIST`
          }
        />
        <div className="nt-wrap-6">
          <Button variant="ghost" size="sm" onClick={copySectionLink}>
            Copy section link
          </Button>
          {viewBehind.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={exportComplianceCsv}>
              Export compliance CSV
            </Button>
          ) : null}
          {devices.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={exportDevicesCsv}>
              Export CSV
            </Button>
          ) : null}
        </div>
      </div>
      {devices.length === 0 ? (
        <div className="nt-service-note">No Mist-claimed devices in the inventory this cycle.</div>
      ) : (
        <>
          {behind.length > 0 ? (
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
              {viewBehind.length === 0 ? (
                serialsFilterLc !== null ? (
                  <EmptyState
                    title="No firmware rows match this selection"
                    description="Clear the selection filter to restore the behind-train list."
                  >
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const next = new URLSearchParams(searchParams);
                        next.delete('serials');
                        setSearchParams(next, { replace: true });
                        setSelectedKeys([]);
                      }}
                    >
                      Clear selection filter
                    </Button>
                  </EmptyState>
                ) : (
                  <div className="nt-service-note">
                    No firmware rows match the current filter.
                  </div>
                )
              ) : (
                <DataTable
                  ariaLabel="Mist firmware behind recommended trains"
                  density="compact"
                  columns={firmwareColumns}
                  rows={viewBehind}
                  rowKey={mistDeviceRowKey}
                  selectedKeys={selectedKeys}
                  onSelectionChange={setSelectedKeys}
                />
              )}
              {selectedKeys.length > 0 ? (
                <div
                  className="nt-configure-bulk-bar nt-bulk-glass"
                  role="region"
                  aria-label="Mist firmware selection actions"
                >
                  <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
                  <span className="nt-configure-bulk-bar__hint">
                    export, copy serials/names, or share a selection link for only the behind devices you marked — full list export stays in the header
                  </span>
                  <span className="nt-configure-bulk-bar__actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const selected = new Set(selectedKeys);
                        const picked = viewBehind.filter((d) => selected.has(mistDeviceRowKey(d)));
                        if (picked.length === 0) {
                          toast('No selected firmware rows still in view', {
                            description: 'Clear selection or adjust filters.',
                            tone: 'info',
                          });
                          return;
                        }
                        const n = exportTableCsv(
                          'mist-firmware-selected.csv',
                          [
                            'name',
                            'type',
                            'model',
                            'site',
                            'state',
                            'firmware',
                            'serial',
                            'firmwareTarget',
                            'firmwareApproved',
                            'firmwareUpdate',
                          ],
                          picked.map((d) => [
                            d.name,
                            d.type,
                            d.model,
                            d.siteName,
                            d.state,
                            d.firmware,
                            d.serial ?? '',
                            d.firmwareTarget ?? '',
                            d.firmwareApproved === undefined ? '' : d.firmwareApproved ? 'yes' : 'no',
                            d.firmwareUpdate ?? '',
                          ]),
                        );
                        toast(`Exported ${countOf(n, 'selected firmware row')}`, {
                          description: 'mist-firmware-selected.csv — behind-train fields only.',
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
                          const picked = viewBehind.filter((d) => selected.has(mistDeviceRowKey(d)));
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
                                .map((d) => (d.serial ?? '').trim())
                                .filter((serial) => serial && serial !== '—'),
                            ),
                          ];
                          if (serials.length === 0) {
                            toast('No serials on the selected devices', {
                              description: 'Those rows did not publish a serial — use Copy names or export CSV instead.',
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
                          const picked = viewBehind.filter((d) => selected.has(mistDeviceRowKey(d)));
                          if (picked.length === 0) {
                            toast('No selected firmware rows still in view', {
                              description: 'Clear selection or adjust filters.',
                              tone: 'info',
                            });
                            return;
                          }
                          const names = [
                            ...new Set(
                              picked
                                .map((d) => (d.name ?? '').trim())
                                .filter((name) => name && name !== '—'),
                            ),
                          ];
                          if (names.length === 0) {
                            toast('No names on the selected devices', {
                              description: 'Those rows did not publish a name — export CSV instead.',
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
                          const picked = viewBehind.filter((d) => selected.has(mistDeviceRowKey(d)));
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
                                .map((d) => (d.serial ?? '').trim())
                                .filter((serial) => serial && serial !== '—'),
                            ),
                          ];
                          if (serials.length === 0) {
                            toast('No serials on the selected devices', {
                              description: 'Those rows did not publish a serial — use Copy names or export CSV instead.',
                              tone: 'info',
                            });
                            return;
                          }
                          const next = new URLSearchParams(searchParams);
                          next.set('serials', serials.join('\n'));
                          next.set('section', 'devices');
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
            </>
          ) : (
            <div className="nt-service-note">
              {scored.length > 0
                ? `Every Mist device with a recommended-train read (${countOf(scored.length, 'device')}) runs it.`
                : 'No Mist device carried a recommended-train read this cycle.'}
            </div>
          )}
          {unreported > 0 ? (
            <div className="nt-fs-105 nt-hint-muted">
              {countOf(unreported, 'device')} carried no recommended-train read — their standing is
              unreported, not compliant.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
