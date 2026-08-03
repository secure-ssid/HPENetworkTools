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
 */

import { Link } from 'react-router-dom';
import { Badge, SectionHeader, Table } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { CentralFirmwareRow } from '@hpe/shared';
import { deviceDetailPath } from '../../app/nav';
import { noteStyle } from './style';

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
  const meta = !devicesReported
    ? 'NOT REPORTED'
    : rows.length === 0
      ? 'ALL ON APPROVED TRAINS'
      : `${countOf(rows.length, 'DEVICE').toUpperCase()} BEHIND`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader label="Firmware" meta={meta} />
      {!devicesReported ? (
        <div style={noteStyle}>
          Central did not report its device inventory this cycle, so no firmware verdict can be
          asserted — this is an unread estate, not a compliant one.
        </div>
      ) : rows.length === 0 ? (
        <div style={noteStyle}>
          {fleetTotal > 0
            ? `Every one of the ${countOf(fleetTotal, 'device')} Central manages is on its approved firmware train.`
            : 'Central reported no devices — no firmware verdicts to give.'}
        </div>
      ) : (
        <>
          <Table density={density}>
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Device</Table.HeaderCell>
                <Table.HeaderCell>Site</Table.HeaderCell>
                <Table.HeaderCell>Installed</Table.HeaderCell>
                <Table.HeaderCell>Recommended</Table.HeaderCell>
                <Table.HeaderCell>Upgrade state</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {rows.map((row) => (
                <Table.Row key={`${row.name}|${row.serial ?? ''}`}>
                  <Table.Cell>
                    <Link
                      to={deviceDetailPath({ name: row.name, plane: 'CENTRAL', serial: row.serial })}
                      style={{ color: 'var(--nd-text-primary)' }}
                    >
                      {row.name}
                    </Link>
                    <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', marginLeft: 8 }}>
                      {row.model}
                    </span>
                  </Table.Cell>
                  <Table.Cell>{row.siteName}</Table.Cell>
                  <Table.Cell>
                    <Badge tone="warning">{row.firmware}</Badge>
                  </Table.Cell>
                  <Table.Cell>
                    {row.target ?? <span style={noteStyle}>approved-train verdict</span>}
                  </Table.Cell>
                  <Table.Cell>
                    {row.update ?? <span style={noteStyle}>—</span>}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          <div style={{ ...noteStyle, fontSize: 10.5, paddingTop: 6 }}>
            The verdict is the plane&rsquo;s own approved-train check; upgrades are scheduled in
            Central, not from here.
          </div>
        </>
      )}
    </div>
  );
}
