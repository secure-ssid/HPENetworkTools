/**
 * web/src/screens/Central.tsx — the HPE Aruba Central plane screen.
 *
 * The plane's own operational dashboard: what Central manages, read off the
 * poller cache — plane status and freshness, the fleet by type and state,
 * the per-site summary, firmware behind the recommended train, the WLAN
 * inventory and the plane's recent alert queue. The two reads that cost a
 * plane call stay on-demand: DPI application visibility (site picker below)
 * and the per-device hardware trends (the device page). Configuration,
 * scope, credentials and webhook MANAGEMENT live in Connected systems —
 * this screen reads.
 *
 * Honesty contract with the payload: every section knows the difference
 * between "the pull did not carry this dataset" (says so), "the pull
 * carried an empty answer" (says THAT), and rows. `notReported` names the
 * first; the stats tiles over those datasets already read '—' server-side.
 *
 * Data: getCentral() — live /api/central when the server is up, the same
 * shared demo composition otherwise (see web/src/api/screens.ts).
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Spinner } from '../nightdesk';
import { getCentral } from '../api/client';
import type { CentralData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { PlaneHeader } from './central/PlaneHeader';
import { SitesSection } from './central/SitesSection';
import { ApplicationsSection } from './central/ApplicationsSection';
import { FirmwareSection } from './central/FirmwareSection';
import { WlanSection } from './central/WlanSection';
import { AlertsSection } from './central/AlertsSection';
import { noteStyle } from './central/style';

export default function Central() {
  const { density } = useSettings();
  const [data, setData] = useState<CentralData | null>(null);

  useEffect(() => {
    let live = true;
    void getCentral().then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  return <CentralView data={data} density={density} />;
}

function CentralView({
  data,
  density,
}: {
  data: CentralData;
  density: 'comfortable' | 'compact';
}) {
  const navigate = useNavigate();
  const notReported = data.notReported ?? [];
  const devicesReported = !notReported.includes('devices');
  const unlinked = data.dataSource === 'live' && !data.plane.linked;

  /* The fleet line under the tiles: types then states, both verbatim — the
   * tiles headline, this enumerates. */
  const typeMix = Object.entries(data.fleet.byType)
    .map(([type, n]) => `${n} ${type}`)
    .join(' · ');
  const stateMix = Object.entries(data.fleet.byState)
    .map(([state, n]) => `${n} ${state}`)
    .join(' · ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Operate / Central"
        title="HPE Aruba Central"
        subtitle="What the plane manages — fleet, sites, application visibility, firmware and WLANs, read off the poller cache."
        actions={data.dataSource === 'live' ? <Badge tone="info">LIVE</Badge> : null}
      />

      <PlaneHeader plane={data.plane} dataSource={data.dataSource} />

      {unlinked ? (
        <Alert tone="warning" title="HPE Aruba Central is not linked — no credentials stored">
          <span style={{ fontSize: 13 }}>
            Every section below can only report what an unlinked plane manages: nothing the portal
            can see. Link it from Connected systems.
          </span>
          <div style={{ marginTop: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
              Connected systems
            </Button>
          </div>
        </Alert>
      ) : null}

      <StatRow stats={data.stats} />
      {devicesReported && data.fleet.total > 0 ? (
        <div style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', marginTop: -12 }}>
          {`${typeMix}${stateMix ? ` — ${stateMix}` : ''}`}
        </div>
      ) : null}

      <SitesSection sites={data.sites} notReported={notReported} density={density} />

      <ApplicationsSection sites={data.sites} sitesReported={!notReported.includes('sites')} />

      <FirmwareSection
        rows={data.firmware}
        devicesReported={devicesReported}
        fleetTotal={data.fleet.total}
        density={density}
      />

      <WlanSection wlans={data.wlans} wlansReported={!notReported.includes('wlans')} />

      <AlertsSection alerts={data.alerts} alertsReported={!notReported.includes('alerts')} />
    </div>
  );
}
