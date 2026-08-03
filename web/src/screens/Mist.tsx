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
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Spinner } from '../nightdesk';
import { getMist } from '../api/client';
import type { MistData } from '../api/client';
import { countOf, hhmmLocal, relativeAge } from '@hpe/shared';
import type { MistPlaneStatus, MistSleRow, StatDef, Tone } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { SleAcrossSites } from './mist/sle';
import { EstateRogueAps } from './mist/rogues';
import { ApHealthSection } from './mist/apHealth';
import { WlanSummary } from './mist/wlans';
import { FirmwareSection } from './mist/firmware';
import { LicenseUsageSection } from './mist/licenses';
import { MistOpsSections } from './mist/audit';

const HEALTH_TONE: Record<MistPlaneStatus['health'], Tone> = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  unlinked: 'neutral',
};

const noteStyle = {
  fontFamily: 'var(--nd-font-mono)',
  fontSize: 'var(--nd-text-11)',
  color: 'var(--nd-text-muted)',
  lineHeight: 1.6,
} as const;

/** The header strip's sync phrase. Live is relative to now; the demo world's
 *  fixed stamp is shown as its own clock time and labelled a fixture — a
 *  relative age against the real clock would contradict the authored world. */
function syncPhrase(data: MistData): string {
  const { plane } = data;
  if (data.dataSource === 'demo') {
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
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  return <MistView data={data} navigate={navigate} />;
}

function MistView({ data, navigate }: { data: MistData; navigate: ReturnType<typeof useNavigate> }) {
  const { plane } = data;
  const sleRows = useMemo(
    () => Object.values(data.sleBySiteId ?? {}).filter((row): row is MistSleRow => row !== undefined),
    [data.sleBySiteId],
  );
  const onWire = useMemo(() => (data.rogues ?? []).filter((r) => r.seenOnLan === true), [data.rogues]);

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <ScreenHeader
        overline="Operate / Mist"
        title="Mist"
        subtitle="Wireless operations across the Mist estate — SLE, rogues, AP health, WLANs, firmware and licences."
        actions={
          <>
            <Badge tone={HEALTH_TONE[plane.health]} dot>
              {plane.linked ? plane.health : 'not linked'}
            </Badge>
            {data.dataSource === 'live' ? <Badge tone="info">LIVE</Badge> : null}
          </>
        }
      />

      <div style={{ ...noteStyle, fontSize: 'var(--nd-text-10)' }}>
        {`MIST PLANE · ${syncPhrase(data)}`}
        {plane.deviceCount !== null ? ` · ${countOf(plane.deviceCount, 'device').toUpperCase()} CLAIMED` : ''}
        {plane.note ? ` · ${plane.note}` : ''}
      </div>

      {!plane.linked && data.dataSource === 'live' ? (
        <Alert tone="info" title="Mist is not linked">
          The sections below report what a linked Mist plane carries. Link it on Connected systems
          and they fill in on the next poll.
          <div style={{ marginTop: 8 }}>
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

      <SleAcrossSites sleBySiteId={data.sleBySiteId} />
      <EstateRogueAps rogues={data.rogues} />
      <ApHealthSection apStats={data.apStats} />
      <WlanSummary wlans={data.wlans} />
      <FirmwareSection devices={data.devices} />
      <LicenseUsageSection licenseUsages={data.licenseUsages} />
      <MistOpsSections />
    </div>
  );
}
