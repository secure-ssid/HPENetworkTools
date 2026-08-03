/**
 * web/src/screens/central/SitesSection.tsx — the Central screen's per-site
 * summary: device/client counts and the worst health PER THE PLANE'S OWN
 * ROWS (never the cross-plane merge — this screen is what Central sees).
 * Rows click through to the site page.
 *
 * Honest states, the screen's standing rule: a dataset the pull did not
 * carry is named ("not reported"), an empty list the pull DID carry is a
 * real answer, and a null count renders '—' rather than a zero the plane
 * never claimed.
 */

import { useNavigate } from 'react-router-dom';
import { Badge, SectionHeader, Table } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { CentralDataset, CentralSiteRow, Tone } from '@hpe/shared';
import { noteStyle } from './style';

/** Health badge tone — the same 90/70 breaks the Sites screen's bar uses. */
function healthTone(healthPct: number): Tone {
  return healthPct >= 90 ? 'success' : healthPct >= 70 ? 'warning' : 'danger';
}

export function SitesSection({
  sites,
  notReported,
  density,
}: {
  sites: CentralSiteRow[];
  notReported: CentralDataset[];
  density: 'comfortable' | 'compact';
}) {
  const navigate = useNavigate();
  const sitesUnreported = notReported.includes('sites');
  const shortInputs = (['devices', 'clients', 'alerts'] as const).filter((k) =>
    notReported.includes(k),
  );
  const meta =
    sitesUnreported && sites.length === 0
      ? 'NOT REPORTED'
      : sites.length === 0
        ? 'NONE'
        : `${countOf(sites.length, 'SITE').toUpperCase()} · CENTRAL`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader label="Sites" meta={meta} />
      {sitesUnreported && sites.length === 0 ? (
        <div style={noteStyle}>
          Central did not report its site list this cycle — a failed read, or no linked plane. No
          site counts can be asserted.
        </div>
      ) : sites.length === 0 ? (
        <div style={noteStyle}>
          Central reported no sites and no devices or clients at any site — a real answer, not a
          failed read.
        </div>
      ) : (
        <>
          {shortInputs.length > 0 ? (
            <div style={{ ...noteStyle, padding: '4px 0' }}>
              {`Short by what the pull did not carry: ${shortInputs.join(', ')} — the counts below cover only what Central reported.`}
            </div>
          ) : null}
          <Table density={density}>
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Site</Table.HeaderCell>
                <Table.HeaderCell>Devices</Table.HeaderCell>
                <Table.HeaderCell>Clients</Table.HeaderCell>
                <Table.HeaderCell>Health</Table.HeaderCell>
                <Table.HeaderCell>Open alerts</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {sites.map((s) => (
                <Table.Row
                  key={s.siteId}
                  onClick={() => navigate(`/sites/${encodeURIComponent(s.siteId)}`)}
                >
                  <Table.Cell>{s.siteName}</Table.Cell>
                  <Table.Cell>{s.devices}</Table.Cell>
                  <Table.Cell>{s.clients === null ? '—' : s.clients}</Table.Cell>
                  <Table.Cell>
                    {s.healthPct === null ? (
                      <span style={noteStyle}>—</span>
                    ) : (
                      <Badge tone={healthTone(s.healthPct)}>{`${s.healthPct}%`}</Badge>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {s.openAlerts === null ? (
                      <span style={noteStyle}>—</span>
                    ) : s.openAlerts === 0 ? (
                      <Badge tone="success">clear</Badge>
                    ) : (
                      <Badge tone="warning">{countOf(s.openAlerts, 'open')}</Badge>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          <div style={{ ...noteStyle, fontSize: 10.5, paddingTop: 6 }}>
            Counts are Central&rsquo;s own rows; health is the share of its known-state devices that
            are up.
          </div>
        </>
      )}
    </div>
  );
}
