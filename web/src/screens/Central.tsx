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
import {
  PageSkeleton, Alert, Badge, Button, useToast,
} from '../nightdesk';
import { getCentral } from '../api/client';
import type { CentralData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { exportTableCsv } from '../lib/csv';
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
    return <PageSkeleton variant="list" />;
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
  const { toast } = useToast();
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
    <div className="nt-stack">
      <ScreenHeader
        overline="Operate / Central"
        title="HPE Aruba Central"
        subtitle="What the plane manages — fleet, sites, application visibility, firmware and WLANs, read off the poller cache."
        actions={
          <>
            {data.dataSource === 'live' ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const parts: string[] = [];
                if (data.sites.length > 0) {
                  parts.push(
                    `${exportTableCsv(
                      'central-sites.csv',
                      ['siteId', 'siteName', 'devices', 'clients', 'healthPct', 'openAlerts'],
                      data.sites.map((s) => [
                        s.siteId,
                        s.siteName,
                        s.devices,
                        s.clients ?? '',
                        s.healthPct ?? '',
                        s.openAlerts ?? '',
                      ]),
                    )} sites`,
                  );
                }
                if (data.wlans.length > 0) {
                  parts.push(
                    `${exportTableCsv(
                      'central-wlans.csv',
                      ['name', 'vlan', 'security', 'targets', 'plane', 'enabled'],
                      data.wlans.map((w) => [
                        w.name,
                        w.vlan,
                        w.security,
                        w.targets,
                        w.plane,
                        w.enabled === undefined ? '' : w.enabled ? 'yes' : 'no',
                      ]),
                    )} wlans`,
                  );
                }
                if (data.firmware.length > 0) {
                  parts.push(
                    `${exportTableCsv(
                      'central-firmware.csv',
                      ['name', 'model', 'type', 'site', 'firmware', 'target', 'update'],
                      data.firmware.map((f) => [
                        f.name,
                        f.model,
                        f.type,
                        f.siteName,
                        f.firmware,
                        f.target ?? '',
                        f.update ?? '',
                      ]),
                    )} firmware`,
                  );
                }
                if (data.alerts.length > 0) {
                  parts.push(
                    `${exportTableCsv(
                      'central-alerts.csv',
                      ['sev', 'title', 'site', 'plane', 'age', 'device'],
                      data.alerts.map((a) => [
                        a.sev,
                        a.title,
                        a.siteName,
                        a.plane,
                        a.age,
                        a.device ?? '',
                      ]),
                    )} alerts`,
                  );
                }
                toast(parts.length ? `Exported ${parts.join(' · ')}` : 'Nothing to export', {
                  description: parts.length
                    ? 'Client-side CSV of the current Central payload.'
                    : 'Sites, WLANs, firmware, and alerts are empty.',
                });
              }}
            >
              Export CSV
            </Button>
          </>
        }
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
      <VisualReferencePanel target={{ kind: 'connector', id: 'central', plane: 'CENTRAL' }} />
      <ConfigRecommendationsPanel title="Central estate recommendations" limit={6} />
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
