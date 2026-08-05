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
 * Header **LIVE** stamps pure live and central blend feeds alike (Loop 166) —
 * demo chrome with live Central sections is not quiet fixture chrome.
 * Header keyboard shortcuts help (`?` / DATATABLE_ROW_SHORTCUTS — Loop 198)
 * covers sites / firmware / WLANs tables that already wire j/k/x/Enter.
 *
 * Data: getCentral() — live /api/central when the server is up, the same
 * shared demo composition otherwise (see web/src/api/screens.ts).
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  PageSkeleton,
  Alert,
  Badge,
  Button,
  DATATABLE_ROW_SHORTCUTS,
  KeyboardShortcuts,
  useToast,
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
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { PlaneHeader } from './central/PlaneHeader';
import { SitesSection } from './central/SitesSection';
import { ApplicationsSection } from './central/ApplicationsSection';
import { FirmwareSection } from './central/FirmwareSection';
import { WlanSection } from './central/WlanSection';
import { AlertsSection } from './central/AlertsSection';

/** In-page Central sections operators can deep-link with `?section=` / `#…`. */
const CENTRAL_SECTIONS = ['sites', 'applications', 'firmware', 'wlans', 'alerts'] as const;
type CentralSectionKey = (typeof CENTRAL_SECTIONS)[number];

function parseCentralSection(raw: string | null | undefined): CentralSectionKey | null {
  if (!raw) return null;
  const key = raw.replace(/^#/, '').trim().toLowerCase();
  return (CENTRAL_SECTIONS as readonly string[]).includes(key) ? (key as CentralSectionKey) : null;
}

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
  const [searchParams] = useSearchParams();
  const sectionParam =
    parseCentralSection(searchParams.get('section')) ??
    parseCentralSection(typeof window !== 'undefined' ? window.location.hash : null);
  const notReported = data.notReported ?? [];
  const devicesReported = !notReported.includes('devices');
  const unlinked = data.dataSource === 'live' && !data.plane.linked;
  /* Pure live or central blend (demo chrome + live Central sections). */
  const sectionLive =
    data.dataSource === 'live' || (data.blended?.includes('central') ?? false);

  useEffect(() => {
    if (!sectionParam) return;
    const t = window.setTimeout(() => {
      document.getElementById(`central-section-${sectionParam}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 80);
    return () => window.clearTimeout(t);
  }, [sectionParam, data]);

  /* The fleet line under the tiles: types then states, both verbatim — the
   * tiles headline, this enumerates. */
  const typeMix = Object.entries(data.fleet.byType)
    .map(([type, n]) => `${n} ${type}`)
    .join(' · ');
  const stateMix = Object.entries(data.fleet.byState)
    .map(([state, n]) => `${n} ${state}`)
    .join(' · ');

  return (
    <div className="nt-stack nt-recon-reveal nt-central-shell nt-section-panel nt-plane-shell">
      <ScreenHeader
        overline="Operate / Central"
        title="HPE Aruba Central"
        subtitle="What the plane manages — fleet, sites, application visibility, firmware and WLANs, read off the poller cache."
        actions={
          <>
            <span className="nt-systems-brand" aria-hidden>
              HPE Network Tools · plane
            </span>
            <Badge plane>Central</Badge>
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(window.location.href).then(
                  () => toast('View link copied', { tone: 'success' }),
                  () => toast('Could not copy link', { tone: 'danger' }),
                );
              }}
            >
              Copy view link
            </Button>
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
            {data.dataSource === 'live' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    /* Deep-linked section picks a dedicated server CSV slice when
                       one exists; otherwise ship the combined devices+sites file. */
                    const part =
                      sectionParam === 'sites'
                        ? 'site'
                        : sectionParam === 'firmware'
                          ? 'firmware'
                          : sectionParam === 'wlans'
                            ? 'wlans'
                            : sectionParam === 'alerts'
                              ? 'alerts'
                              : '';
                    const path = part
                      ? `/api/central/export?part=${part}`
                      : '/api/central/export';
                    const file =
                      part === 'site'
                        ? 'central-sites.csv'
                        : part === 'firmware'
                          ? 'central-firmware.csv'
                          : part === 'wlans'
                            ? 'central-wlans.csv'
                            : part === 'alerts'
                              ? 'central-alerts.csv'
                              : 'central-export.csv';
                    const res = await downloadApiCsv(path, file);
                    if (res.ok) {
                      const description =
                        part === 'site'
                          ? 'central-sites.csv — site summary only.'
                          : part === 'firmware'
                            ? 'central-firmware.csv — behind-train rows only.'
                            : part === 'wlans'
                              ? 'central-wlans.csv — WLAN inventory (no PSKs).'
                              : part === 'alerts'
                                ? 'central-alerts.csv — Central alert queue summary.'
                                : 'central-export.csv — devices + site summary.';
                      toast('Server CSV downloaded', {
                        description,
                        tone: 'success',
                      });
                    } else {
                      toast('Server CSV failed', {
                        description: res.error ?? 'Could not download export',
                        tone: 'warning',
                      });
                    }
                  })();
                }}
              >
                Download server CSV
              </Button>
            ) : null}
            {/* Sites / firmware / WLANs tables are keyboard grids — surface the map (Loop 198). */}
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </>
        }
      />

      <div className="nt-status-ribbon nt-central-ribbon" role="status" aria-label="Central status ribbon">
        <span className="nt-status-ribbon__item">Central ECG · state owns hue</span>
        <span className="nt-status-ribbon__item">sites · WLAN · firmware</span>
        <span className="nt-status-ribbon__item">plane monochrome</span>
      </div>

      <PlaneHeader plane={data.plane} dataSource={data.dataSource} />

      {unlinked ? (
        <Alert tone="warning" title="HPE Aruba Central is not linked — no credentials stored">
          <span className="nt-fs-13">
            Every section below can only report what an unlinked plane manages: nothing the portal
            can see. Link it from Connected systems.
          </span>
          <div className="nt-mt-8">
            <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
              Connected systems
            </Button>
          </div>
        </Alert>
      ) : null}

      <StatRow stats={data.stats} />
      {devicesReported && data.fleet.total > 0 ? (
        <div className="nt-note-mt-neg nt-service-note">
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

      <WlanSection
        wlans={data.wlans}
        wlansReported={!notReported.includes('wlans')}
        density={density}
      />

      <AlertsSection alerts={data.alerts} alertsReported={!notReported.includes('alerts')} />

      {/* Reference material and advisory panels sit below the data they
          describe. Rendered above it they pushed the primary table several
          hundred pixels down the page — on a queue screen the queue is what
          the operator came for, not the suggestions about it. */}
      <VisualReferencePanel target={{ kind: 'connector', id: 'central', plane: 'CENTRAL' }} />
      <ConfigRecommendationsPanel title="Central estate recommendations" category="configuration" limit={6} />
    </div>
  );
}
