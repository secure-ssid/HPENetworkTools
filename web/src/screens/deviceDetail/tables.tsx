/** Device detail tables: facts, ports and clients. */

import {
  Badge,
  Table,
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
  type DeviceClientRow,
  type DevicePort,
  type Fact,
  type Tone,
} from '@hpe/shared';
import { type ReactNode } from 'react';

/** An Identity fact plus an optional colour override — a fact that carries a
 *  judgement (firmware off the approved train) has to look like one. */
export type LiveFact = Fact & { tone?: string };

/** Honest "no live feed" note under a section header — mono, muted, never a fixture stand-in. */
export function LiveGapNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--nd-font-mono)',
        fontSize: 'var(--nd-text-10)',
        color: 'var(--nd-text-muted)',
        padding: '8px 0',
        lineHeight: 1.6,
      }}
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
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '9px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--nd-font-mono)',
          fontSize: 'var(--nd-text-11)',
          color: 'var(--nd-text-primary)',
          width: keyWidth,
          flex: `0 0 ${keyWidth}px`,
          paddingTop: 1,
        }}
      >
        {keyText}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title ? (
          <div
            style={{
              fontSize: 'var(--nd-text-12)',
              color: 'var(--nd-text-primary)',
              overflowWrap: 'anywhere',
            }}
          >
            {title}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            color: 'var(--nd-text-muted)',
            lineHeight: 1.6,
            overflowWrap: 'anywhere',
          }}
        >
          {facts}
        </div>
      </div>
      {trailing ? (
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            color: 'var(--nd-text-muted)',
            paddingTop: 2,
            whiteSpace: 'nowrap',
          }}
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
 */
export function PortTable({ rows }: { rows: DevicePort[] }) {
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

  return (
    <>
      <Table density="compact" className="nt-port-table">
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell>Port</Table.HeaderCell>
            <Table.HeaderCell>Neighbour</Table.HeaderCell>
            {shown.map((c) => (
              <Table.HeaderCell key={c.key}>{c.key}</Table.HeaderCell>
            ))}
            <Table.HeaderCell>Health</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {rows.map((p) => (
            <Table.Row key={p.name}>
              <Table.Cell className="nt-cell-mono nt-cell-nowrap">{p.name}</Table.Cell>
              <Table.Cell>
                {p.neighbour ? (
                  <>
                    {p.neighbour}
                    {p.neighbourPort ? (
                      <span className="nt-cell-mono nt-cell-dim"> {p.neighbourPort}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="nt-cell-dim">{p.status || 'No neighbour discovered'}</span>
                )}
              </Table.Cell>
              {shown.map((c) => (
                <PortCell key={c.key} value={c.value(p)} nowrap={c.nowrap} />
              ))}
              <Table.Cell>
                {/* A port someone shut is not a healthy port, whatever the
                    plane's cached verdict on its neighbour still says. That
                    verdict scored a link that is not passing traffic, and left
                    in the Health column it renders GOOD in green on a port
                    that is disabled — the answer to "why is the AP on 1/1/12
                    offline" shown as evidence that nothing is wrong. The admin
                    state takes the badge; the verdict stays, dimmed, so the
                    reading is not lost, only demoted. */}
                {portAdminDown(p) === true ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Badge tone="warning">ADMIN DOWN</Badge>
                    {p.neighbourHealth ? (
                      <span className="nt-cell-dim">{p.neighbourHealth}</span>
                    ) : null}
                  </span>
                ) : (
                  <Badge tone={p.neighbourHealth ? healthTone(p.neighbourHealth) : statusTone(p.status)}>
                    {p.neighbourHealth || p.status || '—'}
                  </Badge>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      <SharedFacts facts={shared} count={rows.length} noun="ports" />
    </>
  );
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
 */
export function ClientTable({ rows }: { rows: DeviceClientRow[] }) {
  const columned = rows.some((r) => r.mac || r.ip || r.where || r.model);
  return (
    <Table density="compact" className="nt-client-table">
      <Table.Head>
        <Table.Row>
          <Table.HeaderCell>Client</Table.HeaderCell>
          {columned ? (
            <>
              <Table.HeaderCell>Model</Table.HeaderCell>
              <Table.HeaderCell>MAC</Table.HeaderCell>
              <Table.HeaderCell>IP</Table.HeaderCell>
              <Table.HeaderCell>Where</Table.HeaderCell>
            </>
          ) : (
            <Table.HeaderCell>Details</Table.HeaderCell>
          )}
          <Table.HeaderCell>State</Table.HeaderCell>
        </Table.Row>
      </Table.Head>
      <Table.Body>
        {rows.map((client) => (
          <Table.Row key={`${client.name}-${client.detail}`}>
            <Table.Cell>
              {/* A client the plane could not name is listed under its MAC.
                  With the MAC in a column of its own, printing it again here
                  is the same value twice on one row. */}
              {sameMac(client.name, client.mac) ? (
                <span className="nt-cell-dim">Not reported</span>
              ) : (
                client.name
              )}
            </Table.Cell>
            {columned ? (
              <>
                <PortCell value={client.model} />
                <PortCell value={client.mac} nowrap />
                <PortCell value={client.ip} nowrap />
                <PortCell value={client.where} />
              </>
            ) : (
              <Table.Cell className="nt-cell-mono nt-cell-dim">{client.detail}</Table.Cell>
            )}
            <Table.Cell>
              <Badge tone={client.tone}>{client.state}</Badge>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
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
