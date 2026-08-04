/** Device detail tables: facts, ports and clients. */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Table,
  useToast,
  type DataTableColumn,
} from '../../nightdesk';
import {
  SharedFacts,
  partitionColumns,
  type DataColumn,
} from '../dataColumns';
import {
  healthTone,
  portAdminDown,
  portErrorText,
  portTrafficText,
  joinFacts,
  sameMac,
  speedText,
  statusTone,
} from './facts';
import {
  countOf,
  type DeviceClientRow,
  type DevicePort,
  type Fact,
  type Tone,
} from '@hpe/shared';
import { type ReactNode } from 'react';
import { namesFilterForParam } from '../../app/nav';
import { exportTableCsv } from '../../lib/csv';

/** An Identity fact plus an optional colour override — a fact that carries a
 *  judgement (firmware off the approved train) has to look like one. */
export type LiveFact = Fact & { tone?: string };

/** Honest "no live feed" note under a section header — mono, muted, never a fixture stand-in. */
export function LiveGapNote({ children }: { children: ReactNode }) {
  return (
    <div
      className="nt-service-note nt-pad-8-0"
    >
      {children}
    </div>
  );
}

/** One class-block row: a mono key, one or two lines of facts, a Badge. */
export function DetailRow({
  keyText,
  keyWidth = 74,
  title,
  facts,
  badge,
  badgeTone,
  trailing,
}: {
  keyText: string;
  keyWidth?: number;
  title?: string;
  facts: string;
  badge?: string;
  badgeTone?: Tone;
  trailing?: string;
}) {
  return (
    <div
      className="nt-fact-start-row"
    >
      <span
        className="nt-mono-11 nt-fact-key" style={{ ["--nd-fact-key" as string]: `${keyWidth}px` }}
      >
        {keyText}
      </span>
      <div className="nt-flex-1">
        {title ? (
          <div
            className="nt-fs-12-pri"
          >
            {title}
          </div>
        ) : null}
        <div
          className="nt-service-note nt-wrap-anywhere"
        >
          {facts}
        </div>
      </div>
      {trailing ? (
        <span
          className="nt-hint-muted nt-pt2-nowrap"
        >
          {trailing}
        </span>
      ) : null}
      {badge ? <Badge tone={badgeTone}>{badge}</Badge> : null}
    </div>
  );
}

/**
 * The port list as a table.
 *
 * Attribute columns are dropped when every port answers them identically and
 * stated once underneath instead. On a healthy access switch STP reads
 * 'Designated/Forwarding' on all sixteen rows and PoE names the same class on
 * all sixteen — as columns that is 280px of the panel spent repeating two
 * facts, and it squeezed the health verdict, the one thing the list exists to
 * show, off the right edge. The same collapse StatRow does for a caption every
 * tile shares.
 *
 * A set of one or two ports is never collapsed: with that few rows "they all
 * agree" is a coincidence, not a property of the switch.
 *
 * Multi-select raises **Export selected**, **Copy ports** (unique
 * newline-joined port names — Devices **Copy serials** pattern), **Copy
 * neighbours** (unique newline-joined LLDP/CDP far-end names when port names
 * alone are sparse for a handoff — Overview/Alerts **Copy titles** pattern;
 * Loop 237), **Copy selection link** (`?ports=` of marked port names;
 * clearable chip while active — Loop 187), and Clear.
 */
export function PortTable({
  rows,
  exportName = 'device-ports',
}: {
  rows: DevicePort[];
  /** Filename stem for bulk Export selected (device name when known). */
  exportName?: string;
}) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /devices/:name?ports=1/1/1\n1/1/2 (bulk Copy selection link). */
  const portsFilter = namesFilterForParam(searchParams.get('ports'));
  const portsFilterLc =
    portsFilter === null
      ? null
      : portsFilter.map((p) => p.trim().toLowerCase()).filter(Boolean);
  const viewRows =
    portsFilterLc === null
      ? rows
      : rows.filter((p) => portsFilterLc.includes((p.name ?? '').trim().toLowerCase()));
  const portsPresent =
    portsFilterLc === null
      ? 0
      : portsFilterLc.filter((name) =>
          rows.some((p) => (p.name ?? '').trim().toLowerCase() === name),
        ).length;
  const columns: Array<DataColumn<DevicePort>> = [
    { key: 'Type', value: (p: DevicePort) => p.neighbourType || null, nowrap: true },
    {
      key: 'Link',
      value: (p: DevicePort) =>
        joinFacts([
          speedText(p.speedBps),
          p.duplex && p.duplex !== '-' ? p.duplex.toLowerCase() : null,
        ]) || null,
      nowrap: true,
    },
    /* Counters only exist on rows whose plane reports an interface
       statistics map (the local AOS-CX collector; Central's interface list
       carries none). On rows without a block the column reads null, and a
       table where NO row carries counters drops both columns entirely —
       the collapse rule already encodes "the plane did not say". On a
       healthy switch the Errors column then collapses the other way: every
       port answers '0 err · 0 drop', so the fact is stated once underneath
       and only a port with real faults keeps the column on screen. */
    {
      key: 'Traffic',
      value: (p: DevicePort) => (p.counters ? portTrafficText(p.counters) : null),
      nowrap: true,
    },
    {
      key: 'Errors',
      value: (p: DevicePort) => (p.counters ? portErrorText(p.counters) : null),
      nowrap: true,
    },
    {
      key: 'VLAN',
      value: (p: DevicePort) =>
        p.allowedVlanIds && p.allowedVlanIds.length > 0
          ? `${p.vlanMode || 'vlan'} ${p.nativeVlan ?? '?'} + ${p.allowedVlanIds.join(',')}`
          : p.nativeVlan != null
            ? `${p.vlanMode || 'vlan'} ${p.nativeVlan}`
            : p.vlanMode || null,
      nowrap: false,
    },
    {
      key: 'PoE',
      value: (p: DevicePort) =>
        p.poeStatus && !/^not used$/i.test(p.poeStatus)
          ? joinFacts([p.poeStatus, p.poeClass || null]) || null
          : null,
      nowrap: false,
    },
    {
      key: 'STP',
      value: (p: DevicePort) => [p.stpRole, p.stpState].filter(Boolean).join('/') || null,
      nowrap: false,
    },
  ];

  const { shown, shared } = partitionColumns(rows, columns);

  /* No sortValue: port order is urgency-sorted upstream; header sort marks
     would also break columnheader text assertions that expect plain titles. */
  const tableColumns: Array<DataTableColumn<DevicePort>> = [
    {
      key: 'port',
      title: 'Port',
      hideable: false,
      render: (p) => <span className="nt-cell-mono nt-cell-nowrap">{p.name}</span>,
    },
    {
      key: 'neighbour',
      title: 'Neighbour',
      render: (p) =>
        p.neighbour ? (
          <>
            {p.neighbour}
            {p.neighbourPort ? (
              <span className="nt-cell-mono nt-cell-dim"> {p.neighbourPort}</span>
            ) : null}
          </>
        ) : (
          <span className="nt-cell-dim">{p.status || 'No neighbour discovered'}</span>
        ),
    },
    ...shown.map(
      (c): DataTableColumn<DevicePort> => ({
        key: c.key,
        title: c.key,
        render: (p) => <MonoAttr value={c.value(p)} nowrap={c.nowrap} />,
      }),
    ),
    {
      key: 'health',
      title: 'Health',
      render: (p) =>
        /* A port someone shut is not a healthy port, whatever the
           plane's cached verdict on its neighbour still says. That
           verdict scored a link that is not passing traffic, and left
           in the Health column it renders GOOD in green on a port
           that is disabled — the answer to "why is the AP on 1/1/12
           offline" shown as evidence that nothing is wrong. The admin
           state takes the badge; the verdict stays, dimmed, so the
           reading is not lost, only demoted. */
        portAdminDown(p) === true ? (
          <span className="nt-inline-6">
            <Badge tone="warning">ADMIN DOWN</Badge>
            {p.neighbourHealth ? <span className="nt-cell-dim">{p.neighbourHealth}</span> : null}
          </span>
        ) : (
          <Badge tone={p.neighbourHealth ? healthTone(p.neighbourHealth) : statusTone(p.status)}>
            {p.neighbourHealth || p.status || '—'}
          </Badge>
        ),
    },
  ];

  return (
    <>
      {portsFilterLc !== null ? (
        <div className="nt-chip-row" role="group" aria-label="Selection deep link">
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('ports');
              setSearchParams(next, { replace: true });
              setSelectedKeys([]);
            }}
            title={portsFilter?.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {portsPresent === portsFilterLc.length
              ? `${portsFilterLc.length} selected port${portsFilterLc.length === 1 ? '' : 's'}`
              : `${portsPresent} of ${portsFilterLc.length} selected ports present`}
            {' — clear'}
          </button>
        </div>
      ) : null}
      {viewRows.length === 0 && portsFilterLc !== null ? (
        <EmptyState
          title="No ports match this selection"
          description="Clear the selection filter to restore the full interface list."
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('ports');
              setSearchParams(next, { replace: true });
              setSelectedKeys([]);
            }}
          >
            Clear selection filter
          </Button>
        </EmptyState>
      ) : (
        <DataTable
          ariaLabel="Device ports"
          density="compact"
          className="nt-port-table"
          columns={tableColumns}
          rows={viewRows}
          rowKey={(p) => p.name}
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
        />
      )}
      {selectedKeys.length > 0 ? (
        <div
          className="nt-configure-bulk-bar nt-bulk-glass"
          role="region"
          aria-label="Device port selection actions"
        >
          <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
          <span className="nt-configure-bulk-bar__hint">
            export, copy port or neighbour names, or share a selection link for only the interfaces you marked —
            full list export stays above
          </span>
          <span className="nt-configure-bulk-bar__actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const selected = new Set(selectedKeys);
                const picked = viewRows.filter((p) => selected.has(p.name));
                if (picked.length === 0) {
                  toast('No selected ports still in view', {
                    description: 'Clear selection or refresh the device.',
                    tone: 'info',
                  });
                  return;
                }
                const n = exportTableCsv(
                  `${exportName}-selected.csv`,
                  [
                    'port',
                    'status',
                    'admin',
                    'oper',
                    'neighbour',
                    'neighbourPort',
                    'neighbourType',
                    'neighbourHealth',
                    'vlanMode',
                    'nativeVlan',
                  ],
                  picked.map((p) => [
                    p.name,
                    p.status,
                    p.adminStatus,
                    p.operStatus,
                    p.neighbour ?? '',
                    p.neighbourPort ?? '',
                    p.neighbourType ?? '',
                    p.neighbourHealth ?? '',
                    p.vlanMode,
                    p.nativeVlan ?? '',
                  ]),
                );
                toast(`Exported ${countOf(n, 'selected port')}`, {
                  description: `${exportName}-selected.csv — interface fields only.`,
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
                  const picked = viewRows.filter((p) => selected.has(p.name));
                  if (picked.length === 0) {
                    toast('No selected ports still in view', {
                      description: 'Clear selection or refresh the device.',
                      tone: 'info',
                    });
                    return;
                  }
                  const ports = [
                    ...new Set(
                      picked
                        .map((p) => (p.name ?? '').trim())
                        .filter((name) => name && name !== '—'),
                    ),
                  ];
                  if (ports.length === 0) {
                    toast('No names on the selected ports', {
                      description:
                        'Those rows did not publish a port name — use Copy neighbours or export CSV instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const text = ports.join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    toast(`Copied ${countOf(ports.length, 'port')}`, {
                      description:
                        ports.length < picked.length
                          ? `${picked.length - ports.length} selected without a name skipped`
                          : 'newline-joined · paste into a ticket or change window',
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy ports', { description: text, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy ports
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const selected = new Set(selectedKeys);
                  const picked = viewRows.filter((p) => selected.has(p.name));
                  if (picked.length === 0) {
                    toast('No selected ports still in view', {
                      description: 'Clear selection or refresh the device.',
                      tone: 'info',
                    });
                    return;
                  }
                  const neighbours = [
                    ...new Set(
                      picked
                        .map((p) => (p.neighbour ?? '').trim())
                        .filter((name) => name && name !== '—'),
                    ),
                  ];
                  if (neighbours.length === 0) {
                    toast('No neighbours on the selected ports', {
                      description:
                        'Those rows did not publish a far-end name — use Copy ports or export CSV instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const text = neighbours.join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    toast(`Copied ${countOf(neighbours.length, 'neighbour')}`, {
                      description:
                        neighbours.length < picked.length
                          ? `${picked.length - neighbours.length} selected without a neighbour skipped`
                          : 'newline-joined · paste into a ticket or change window',
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy neighbours', { description: text, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy neighbours
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const selected = new Set(selectedKeys);
                  const picked = viewRows.filter((p) => selected.has(p.name));
                  if (picked.length === 0) {
                    toast('No selected ports still in view', {
                      description: 'Clear selection or refresh the device.',
                      tone: 'info',
                    });
                    return;
                  }
                  const ports = [
                    ...new Set(
                      picked
                        .map((p) => (p.name ?? '').trim())
                        .filter((name) => name.length > 0),
                    ),
                  ];
                  if (ports.length === 0) {
                    toast('No names on the selected ports', {
                      description: 'Export CSV for row detail instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const next = new URLSearchParams(searchParams);
                  next.set('ports', ports.join('\n'));
                  const qs = next.toString();
                  const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Selection link copied', {
                      description: `${ports.length} port${ports.length === 1 ? '' : 's'} · ports=`,
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
      <SharedFacts facts={shared} count={viewRows.length} noun="ports" />
    </>
  );
}

function clientRowKey(client: DeviceClientRow, index: number): string {
  return `${client.name}-${client.detail}-${client.mac ?? ''}-${index}`;
}

/**
 * "Clients on this device" as a table.
 *
 * The column set is chosen by what the rows actually carry. A live row is sent
 * with model/mac/ip/where kept apart, so it gets a column each; an authored
 * demo row carries only a sentence — and a different sentence per device class
 * ('port 1/1/20 · MAB · vlan 820' on a switch, '5 GHz · −52 dBm' on an AP) —
 * so those share one Details column rather than being split on '·' and hoped
 * into the wrong headings.
 *
 * Multi-select raises **Export selected**, **Copy MACs** (unique newline-joined
 * inventory MACs — ClearPass endpoints pattern), **Copy names** (unique
 * newline-joined client hostnames when MACs are sparse — Clients **Copy names**
 * pattern; Loop 232), **Copy selection link** (`?macs=` of unique session MACs —
 * Clients pattern; clearable chip while active; Loop 184), and Clear (Loop 180).
 * Selection-empty `?macs=` offers **Clear selection filter** (Loop 217).
 */
export function ClientTable({
  rows,
  exportName = 'device-clients',
}: {
  rows: DeviceClientRow[];
  /** Filename stem for bulk Export selected (device name when known). */
  exportName?: string;
}) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /devices/:name?macs=aa\nbb (bulk Copy selection link). */
  const macsFilter = namesFilterForParam(searchParams.get('macs'));
  const macsFilterLc =
    macsFilter === null
      ? null
      : macsFilter.map((mac) => mac.trim().toLowerCase()).filter(Boolean);
  const viewRows =
    macsFilterLc === null
      ? rows
      : rows.filter((c) => macsFilterLc.includes((c.mac ?? '').trim().toLowerCase()));
  const macsPresent =
    macsFilterLc === null
      ? 0
      : macsFilterLc.filter((mac) =>
          rows.some((c) => (c.mac ?? '').trim().toLowerCase() === mac),
        ).length;
  const columned = rows.some((r) => r.mac || r.ip || r.where || r.model);
  const columns: Array<DataTableColumn<DeviceClientRow>> = columned
    ? [
        {
          key: 'client',
          title: 'Client',
          hideable: false,
          sortValue: (c) => c.name,
          render: (client) =>
            /* A client the plane could not name is listed under its MAC.
               With the MAC in a column of its own, printing it again here
               is the same value twice on one row. */
            sameMac(client.name, client.mac) ? (
              <span className="nt-cell-dim">Not reported</span>
            ) : (
              client.name
            ),
        },
        {
          key: 'model',
          title: 'Model',
          sortValue: (c) => c.model ?? '',
          render: (c) => <MonoAttr value={c.model} />,
        },
        {
          key: 'mac',
          title: 'MAC',
          sortValue: (c) => c.mac ?? '',
          render: (c) => <MonoAttr value={c.mac} nowrap />,
        },
        {
          key: 'ip',
          title: 'IP',
          sortValue: (c) => c.ip ?? '',
          render: (c) => <MonoAttr value={c.ip} nowrap />,
        },
        {
          key: 'where',
          title: 'Where',
          sortValue: (c) => c.where ?? '',
          render: (c) => <MonoAttr value={c.where} />,
        },
        {
          key: 'state',
          title: 'State',
          sortValue: (c) => c.state,
          render: (c) => <Badge tone={c.tone}>{c.state}</Badge>,
        },
      ]
    : [
        {
          key: 'client',
          title: 'Client',
          hideable: false,
          sortValue: (c) => c.name,
          render: (client) =>
            sameMac(client.name, client.mac) ? (
              <span className="nt-cell-dim">Not reported</span>
            ) : (
              client.name
            ),
        },
        {
          key: 'details',
          title: 'Details',
          sortValue: (c) => c.detail,
          render: (c) => <span className="nt-cell-mono nt-cell-dim">{c.detail}</span>,
        },
        {
          key: 'state',
          title: 'State',
          sortValue: (c) => c.state,
          render: (c) => <Badge tone={c.tone}>{c.state}</Badge>,
        },
      ];

  return (
    <>
      {macsFilterLc !== null ? (
        <div className="nt-chip-row" role="group" aria-label="Selection deep link">
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('macs');
              setSearchParams(next, { replace: true });
              setSelectedKeys([]);
            }}
            title={macsFilter?.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {macsPresent === macsFilterLc.length
              ? `${macsFilterLc.length} selected MAC${macsFilterLc.length === 1 ? '' : 's'}`
              : `${macsPresent} of ${macsFilterLc.length} selected MACs present`}
            {' — clear'}
          </button>
        </div>
      ) : null}
      {viewRows.length === 0 && macsFilterLc !== null ? (
        <EmptyState
          title="No clients match this selection"
          description="Clear the selection filter to restore the full session list."
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('macs');
              setSearchParams(next, { replace: true });
              setSelectedKeys([]);
            }}
          >
            Clear selection filter
          </Button>
        </EmptyState>
      ) : (
        <DataTable
          ariaLabel="Clients on this device"
          density="compact"
          className="nt-client-table"
          columns={columns}
          rows={viewRows}
          rowKey={clientRowKey}
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
        />
      )}
      {selectedKeys.length > 0 ? (
        <div
          className="nt-configure-bulk-bar nt-bulk-glass"
          role="region"
          aria-label="Device client selection actions"
        >
          <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
          <span className="nt-configure-bulk-bar__hint">
            export, copy MACs/names, or share a selection link for only the sessions you marked — full list export stays above
          </span>
          <span className="nt-configure-bulk-bar__actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const selected = new Set(selectedKeys);
                const picked = viewRows.filter((c, i) => selected.has(clientRowKey(c, i)));
                if (picked.length === 0) {
                  toast('No selected clients still in view', {
                    description: 'Clear selection or refresh the device.',
                    tone: 'info',
                  });
                  return;
                }
                const n = exportTableCsv(
                  `${exportName}-selected.csv`,
                  ['client', 'model', 'mac', 'ip', 'where', 'state', 'detail'],
                  picked.map((c) => [
                    c.name,
                    c.model ?? '',
                    c.mac ?? '',
                    c.ip ?? '',
                    c.where ?? '',
                    c.state,
                    c.detail,
                  ]),
                );
                toast(`Exported ${countOf(n, 'selected client')}`, {
                  description: `${exportName}-selected.csv — attached session fields only.`,
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
                  const picked = viewRows.filter((c, i) => selected.has(clientRowKey(c, i)));
                  if (picked.length === 0) {
                    toast('No selected clients still in view', {
                      description: 'Clear selection or refresh the device.',
                      tone: 'info',
                    });
                    return;
                  }
                  const macs = [
                    ...new Set(
                      picked
                        .map((c) => (c.mac ?? '').trim())
                        .filter((mac) => mac && mac !== '—'),
                    ),
                  ];
                  if (macs.length === 0) {
                    toast('No MACs on the selected clients', {
                      description: 'Those rows did not publish a MAC — use Copy names or export CSV instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const text = macs.join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    toast(`Copied ${countOf(macs.length, 'MAC')}`, {
                      description:
                        macs.length < picked.length
                          ? `${picked.length - macs.length} selected without a MAC skipped`
                          : 'newline-joined · paste into NAC or a ticket',
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy MACs', { description: text, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy MACs
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const selected = new Set(selectedKeys);
                  const picked = viewRows.filter((c, i) => selected.has(clientRowKey(c, i)));
                  if (picked.length === 0) {
                    toast('No selected clients still in view', {
                      description: 'Clear selection or refresh the device.',
                      tone: 'info',
                    });
                    return;
                  }
                  const names = [
                    ...new Set(
                      picked
                        .map((c) => String(c.name ?? '').trim())
                        .filter((name) => name && name !== '—'),
                    ),
                  ];
                  if (names.length === 0) {
                    toast('No names on the selected clients', {
                      description: 'Those rows did not publish a hostname — export CSV instead.',
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
                  const picked = viewRows.filter((c, i) => selected.has(clientRowKey(c, i)));
                  if (picked.length === 0) {
                    toast('No selected clients still in view', {
                      description: 'Clear selection or refresh the device.',
                      tone: 'info',
                    });
                    return;
                  }
                  const macs = [
                    ...new Set(
                      picked
                        .map((c) => (c.mac ?? '').trim())
                        .filter((mac) => mac && mac !== '—'),
                    ),
                  ];
                  if (macs.length === 0) {
                    toast('No MACs on the selected clients', {
                      description: 'Those rows did not publish a MAC — use Copy names or export CSV instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const next = new URLSearchParams(searchParams);
                  next.set('macs', macs.join('\n'));
                  const qs = next.toString();
                  const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Selection link copied', {
                      description: `${macs.length} MAC${macs.length === 1 ? '' : 's'} · macs=`,
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
  );
}

/** Mono attribute content (DataTable cells wrap their own td). */
function MonoAttr({ value, nowrap }: { value?: string | null; nowrap?: boolean }) {
  return (
    <span className={nowrap ? 'nt-cell-mono nt-cell-nowrap' : 'nt-cell-mono'}>
      {value ? value : <span className="nt-cell-dim">—</span>}
    </span>
  );
}

/** One mono attribute cell. An em-dash means the plane reported nothing for
 *  this port, which is not the same as reporting a zero or an empty string. */
export function PortCell({ value, nowrap }: { value?: string | null; nowrap?: boolean }) {
  return (
    <Table.Cell className={nowrap ? 'nt-cell-mono nt-cell-nowrap' : 'nt-cell-mono'}>
      {value ? value : <span className="nt-cell-dim">—</span>}
    </Table.Cell>
  );
}
