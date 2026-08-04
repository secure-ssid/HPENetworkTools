/**
 * web/src/screens/Mist.tsx — the Mist plane's operational dashboard.
 *
 * One payload (getMist() — live /api/mist when the server is up, the same
 * fixtures the server's demo branch serves when it is not) carries the plane
 * status block plus every poll-time Mist dataset: per-site SLE, the
 * rogue/neighbor report, the AP rich-stats walk, licence usages, the WLAN
 * inventory and the Mist-claimed devices. The org audit log and webhook
 * registration status stay on-demand (mist/audit.tsx) — a paged org search
 * is not poll-cheap.
 *
 * This screen OPERATES; it does not configure. WLAN edits link out to
 * Configure's Mist flow, webhook registration to the Systems drawer, and a
 * site row opens the site page's drill-down. Every section keeps the
 * payload's absent/present-empty distinction: "not reported this cycle" and
 * "Mist answered with nothing" are different sentences.
 *
 * Header **LIVE** stamps pure live and mist blend feeds alike (Loop 165) —
 * demo chrome with live Mist sections is not quiet fixture chrome. Firmware
 * behind-train multi-select raises **Export selected** / **Copy serials** /
 * **Copy selection link** (`?serials=` + `section=devices`; Loop 184) / Clear
 * (Loop 180). WLANs multi-select raises **Export selected** / **Copy names** /
 * **Copy selection link** (`?names=` + `section=wlans`; Loop 187) / Clear.
 * WLANs filtered empties offer **Clear filters** for q / enabled (Loop 204).
 * Licence usage multi-select raises **Export selected** / **Copy site ids** /
 * **Copy selection link** (`?siteIds=` + `section=licenses`; Loop 187) / Clear.
 * Header keyboard shortcuts help (`?` / DATATABLE_ROW_SHORTCUTS — Loop 198)
 * covers the estate tables that already wire j/k/x/Enter.
 */

import { useEffect, useMemo, useState } from 'react';
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
import { getMist } from '../api/client';
import type { MistData } from '../api/client';
import { countOf, hhmmLocal, relativeAge } from '@hpe/shared';
import type { MistPlaneStatus, MistSleRow, StatDef, Tone } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { SleAcrossSites } from './mist/sle';
import { EstateRogueAps } from './mist/rogues';
import { ApHealthSection } from './mist/apHealth';
import { WlanSummary } from './mist/wlans';
import { FirmwareSection } from './mist/firmware';
import { LicenseUsageSection } from './mist/licenses';
import { MistOpsSections } from './mist/audit';
import { buildMistShareUrl, parseMistSection } from './mist/share';

export {
  MIST_SECTIONS,
  buildMistShareUrl,
  mistSectionDomId,
  parseMistSection,
  type MistSectionKey,
} from './mist/share';

const HEALTH_TONE: Record<MistPlaneStatus['health'], Tone> = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  unlinked: 'neutral',
};

/** Pure live or mist blend (demo chrome + live Mist sections). */
function mistSectionLive(data: MistData): boolean {
  return data.dataSource === 'live' || (data.blended?.includes('mist') ?? false);
}

/** The header strip's sync phrase. Live is relative to now; the demo world's
 *  fixed stamp is shown as its own clock time and labelled a fixture — a
 *  relative age against the real clock would contradict the authored world.
 *  Blend feeds carry live Mist evidence under demo chrome, so they use the
 *  live relative clock rather than the authored DEMO FIXTURE label. */
function syncPhrase(data: MistData): string {
  const { plane } = data;
  if (!mistSectionLive(data)) {
    return plane.lastSync ? `sync stamp ${hhmmLocal(plane.lastSync)} · DEMO FIXTURE` : 'DEMO FIXTURE';
  }
  if (!plane.linked) return 'not linked';
  return plane.lastSync ? `last sync ${relativeAge(plane.lastSync)} ago` : 'never synced';
}

export default function Mist() {
  const navigate = useNavigate();
  const [data, setData] = useState<MistData | null>(null);

  useEffect(() => {
    let live = true;
    void getMist().then((d) => {
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

  return <MistView data={data} navigate={navigate} />;
}

function MistView({ data, navigate }: { data: MistData; navigate: ReturnType<typeof useNavigate> }) {
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const sectionParam =
    parseMistSection(searchParams.get('section')) ??
    parseMistSection(typeof window !== 'undefined' ? window.location.hash : null);
  const sectionLive = mistSectionLive(data);
  const { plane } = data;
  const sleRows = useMemo(
    () => Object.values(data.sleBySiteId ?? {}).filter((row): row is MistSleRow => row !== undefined),
    [data.sleBySiteId],
  );
  const onWire = useMemo(() => (data.rogues ?? []).filter((r) => r.seenOnLan === true), [data.rogues]);

  useEffect(() => {
    if (!sectionParam) return;
    const t = window.setTimeout(() => {
      document.getElementById(`mist-section-${sectionParam}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 80);
    return () => window.clearTimeout(t);
  }, [sectionParam, data]);

  const stats = useMemo<StatDef[]>(() => {
    const worst = sleRows.reduce<number | null>(
      (acc, row) => (row.overall === null ? acc : acc === null || row.overall < acc ? row.overall : acc),
      null,
    );
    return [
      {
        label: 'Devices',
        value: plane.deviceCount !== null ? String(plane.deviceCount) : '—',
        delta: plane.deviceCount !== null ? 'claimed by Mist' : 'not reported',
        tone: 'neutral',
      },
      {
        label: 'Clients',
        value: plane.clientCount !== null ? String(plane.clientCount) : '—',
        delta: plane.clientCount !== null ? 'reported by Mist' : 'not reported',
        tone: 'neutral',
      },
      {
        label: 'Sites scored',
        value: data.sleBySiteId === undefined ? '—' : String(sleRows.length),
        delta:
          data.sleBySiteId === undefined
            ? 'SLE not reported this cycle'
            : worst !== null
              ? `worst ${Math.round(worst * 100)}%`
              : 'no scores this window',
        tone: worst !== null && worst < 0.7 ? 'negative' : 'neutral',
      },
      {
        label: 'On your wire',
        value: data.rogues === undefined ? '—' : String(onWire.length),
        delta:
          data.rogues === undefined
            ? 'rogue report not read this cycle'
            : onWire.length > 0
              ? `${countOf(onWire.length, 'rogue BSSID')} on your infrastructure`
              : 'no rogues on the wire',
        tone: onWire.length > 0 ? 'negative' : 'neutral',
      },
    ];
  }, [plane, data.sleBySiteId, data.rogues, sleRows, onWire]);

  return (
    <div className="nt-stack nt-gap-24 nt-recon-reveal nt-mist-shell nt-section-panel nt-plane-shell">
      <ScreenHeader
        overline="Operate / Mist"
        title="Mist"
        subtitle="Wireless operations across the Mist estate — SLE, rogues, AP health, WLANs, firmware and licences."
        actions={
          <>
            <span className="nt-systems-brand" aria-hidden>
              NightDesk · wireless
            </span>
            <Badge plane>Mist</Badge>
            <Badge tone={HEALTH_TONE[plane.health]} dot>
              {plane.linked ? plane.health : 'not linked'}
            </Badge>
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const url = buildMistShareUrl(sectionParam);
                void navigator.clipboard.writeText(url).then(
                  () =>
                    toast('View link copied', {
                      description: sectionParam ? `section=${sectionParam}` : 'Mist workspace',
                      tone: 'success',
                    }),
                  () => toast('Could not copy link', { tone: 'danger' }),
                );
              }}
            >
              Copy view link
            </Button>
            {(data.rogues && data.rogues.length > 0) ||
            (data.apStats && data.apStats.length > 0) ||
            data.devices.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const parts: string[] = [];
                  if (data.devices.length > 0) {
                    const n = exportTableCsv(
                      'mist-devices.csv',
                      ['name', 'type', 'model', 'site', 'state', 'firmware', 'serial', 'firmwareTarget', 'firmwareApproved'],
                      data.devices.map((d) => [
                        d.name,
                        d.type,
                        d.model,
                        d.siteName,
                        d.state,
                        d.firmware,
                        d.serial ?? '',
                        d.firmwareTarget ?? '',
                        d.firmwareApproved === undefined ? '' : d.firmwareApproved ? 'yes' : 'no',
                      ]),
                    );
                    parts.push(`${n} devices`);
                  }
                  if (data.rogues && data.rogues.length > 0) {
                    const n = exportTableCsv(
                      'mist-rogues.csv',
                      ['site', 'bssid', 'ssid', 'channel', 'avgRssi', 'numAps', 'seenOnLan'],
                      data.rogues.map((r) => [
                        r.siteName,
                        r.bssid,
                        r.ssid ?? '',
                        r.channel ?? '',
                        r.avgRssi ?? '',
                        r.numAps ?? '',
                        r.seenOnLan === true ? 'yes' : r.seenOnLan === false ? 'no' : '',
                      ]),
                    );
                    parts.push(`${n} rogues`);
                  }
                  if (data.apStats && data.apStats.length > 0) {
                    const n = exportTableCsv(
                      'mist-ap-health.csv',
                      ['device', 'site', 'mac', 'serial', 'clients', 'cpuPct', 'extIp'],
                      data.apStats.map((a) => [
                        a.deviceName,
                        a.siteName,
                        a.mac ?? '',
                        a.serial ?? '',
                        a.numClients ?? '',
                        a.cpuUtilPct ?? '',
                        a.extIp ?? '',
                      ]),
                    );
                    parts.push(`${n} APs`);
                  }
                  toast(`Exported ${parts.join(' · ')}`, {
                    description: 'Client-side CSV of the current Mist payload.',
                  });
                }}
              >
                Export CSV
              </Button>
            ) : null}
            {sectionLive ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const res = await downloadApiCsv('/api/mist/export?part=devices', 'mist-devices.csv');
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'mist-devices.csv — Mist-claimed inventory.',
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const res = await downloadApiCsv('/api/mist/export?part=rogues', 'mist-rogues.csv');
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'mist-rogues.csv — rogue/neighbor BSSIDs.',
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
                  Download rogues CSV
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const res = await downloadApiCsv('/api/mist/export?part=ap-stats', 'mist-ap-health.csv');
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'mist-ap-health.csv — AP rich-stats walk.',
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
                  Download AP health CSV
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const res = await downloadApiCsv('/api/mist/export?part=sle', 'mist-sle.csv');
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'mist-sle.csv — per-site SLE headlines.',
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
                  Download SLE CSV
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      /* Forward WLAN strip filters (q/enabled) when present so the
                         header download matches the WlanSummary view (Loop 115). */
                      const qs = new URLSearchParams({ part: 'wlans' });
                      const q = searchParams.get('q')?.trim();
                      if (q) qs.set('q', q);
                      const en = searchParams.get('enabled')?.trim();
                      if (en) qs.set('enabled', en);
                      const res = await downloadApiCsv(
                        `/api/mist/export?${qs.toString()}`,
                        'mist-wlans.csv',
                      );
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'mist-wlans.csv — Mist WLAN inventory (no PSKs).',
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
                  Download WLANs CSV
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const res = await downloadApiCsv(
                        '/api/mist/export?part=licenses',
                        'mist-licenses.csv',
                      );
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'mist-licenses.csv — per-site licence usage tallies.',
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
                  Download licences CSV
                </Button>
              </>
            ) : null}
            {/* Estate tables (rogues / WLANs / firmware / licences / audit) are keyboard grids — surface the map (Loop 198). */}
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </>
        }
      />

      <div className="nt-plane-theater" role="note">NightDesk · Mist ECG · SLE / rogues / AP cinema</div>

      <div className="nt-service-note nt-note-10">
        {`MIST PLANE · ${syncPhrase(data)}`}
        {plane.deviceCount !== null ? ` · ${countOf(plane.deviceCount, 'device').toUpperCase()} CLAIMED` : ''}
        {plane.note ? ` · ${plane.note}` : ''}
      </div>

      {!plane.linked && sectionLive ? (
        <Alert tone="info" title="Mist is not linked">
          The sections below report what a linked Mist plane carries. Link it on Connected systems
          and they fill in on the next poll.
          <div className="nt-mt-8">
            <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
              Connected systems
            </Button>
          </div>
        </Alert>
      ) : null}

      <StatRow
        stats={stats}
        linkForStat={(label) =>
          label === 'Devices' ? '/devices?plane=mist' : label === 'Clients' ? '/clients?plane=mist' : null
        }
      />

      <VisualReferencePanel target={{ kind: 'connector', id: 'mist', plane: 'MIST' }} />
      <ConfigRecommendationsPanel title="Mist estate recommendations" limit={6} />

      <SleAcrossSites sleBySiteId={data.sleBySiteId} />
      <EstateRogueAps rogues={data.rogues} />
      <ApHealthSection apStats={data.apStats} />
      <WlanSummary wlans={data.wlans} live={sectionLive} />
      <FirmwareSection devices={data.devices} />
      <LicenseUsageSection licenseUsages={data.licenseUsages} live={sectionLive} />
      <MistOpsSections />
    </div>
  );
}
