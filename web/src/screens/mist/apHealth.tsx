/**
 * web/src/screens/mist/apHealth.tsx — the Mist screen's "AP health" section:
 * what the AP rich-stats walk (radios, power, environment, LLDP uplinks) says
 * across every site at once.
 *
 * Four sub-groups, each worded off what the walk actually reported:
 *  - POWER — the constrained APs (`power_constrained` is Mist's own verdict,
 *    rendered as such); "none constrained" is only said when at least one AP
 *    reported a power state at all.
 *  - RADIO LOAD — the busiest radios by the reported util_all, ranked, never
 *    thresholded: the portal invents no "high utilization" verdict Mist did
 *    not publish.
 *  - ENVIRONMENT — ambient temperatures hottest-first, the same ranking
 *    rule; an AP with no env block is counted as "no sensor", never given a
 *    fabricated reading.
 *  - UPLINKS — every AP's own LLDP report of its wired neighbour, verbatim.
 */

import { Link } from 'react-router-dom';
import { Badge, Button, SectionHeader, useToast } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { MistApStatsRow } from '@hpe/shared';
import { deviceDetailPath } from '../../app/nav';
import { buildMistShareUrl } from './share';

function SubGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="nt-mist-section nt-section-panel nt-stack-2-pt8 nt-ap-health-group nt-ap-health-panel">
      <span className="nd-micro-label nt-micro-label">{label}</span>
      {children}
    </div>
  );
}

/** AP rich-stats carry a reported Mist serial, so this is an exact device
 * hand-off. If a future row omits that identity, leave its name as text rather
 * than pretending a bare name is safe to resolve. */
function ApName({ row, context }: { row: MistApStatsRow; context: string }) {
  if (!row.serial) return <span className="nt-ap-health-name">{row.deviceName}</span>;
  return (
    <Link
      to={deviceDetailPath({ name: row.deviceName, plane: 'MIST', serial: row.serial })}
      aria-label={`Open device ${row.deviceName} — ${context}`}
      className="nt-link-accent nt-ap-health-name"
    >
      {row.deviceName}
    </Link>
  );
}

/** The uplink speed the row can honestly state: exactly one up port with a
 *  reported speed, else null — never a picked one of several (the rule
 *  mistLldpTopology applies to the same rows). */
function uplinkSpeed(row: MistApStatsRow): string | null {
  const upPorts = row.ports.filter((p) => p.up === true);
  if (upPorts.length !== 1 || upPorts[0]!.speedMbps === null) return null;
  const mbps = upPorts[0]!.speedMbps!;
  return mbps >= 1000 ? `${mbps / 1000} Gb` : `${mbps} Mb`;
}

function ApHealthBody({ rows }: { rows: MistApStatsRow[] }) {
  const constrained = rows.filter((r) => r.powerConstrained === true);
  const powerReported = rows.some((r) => r.powerConstrained !== null);

  const radios = rows
    .flatMap((r) =>
      r.radios
        .filter((radio) => radio.utilAllPct !== null)
        .map((radio) => ({ ap: r, radio, util: radio.utilAllPct! })),
    )
    .sort((a, b) => b.util - a.util)
    .slice(0, 5);

  const withTemp = rows
    .filter((r) => r.env?.ambientTempC != null)
    .sort((a, b) => b.env!.ambientTempC! - a.env!.ambientTempC!);
  const noEnv = rows.length - rows.filter((r) => r.env !== null).length;

  const uplinks = rows.filter((r) => (r.lldpUplink?.systemName ?? '').trim() !== '');

  return (
    <>
      <SubGroup label="Power">
        {!powerReported ? (
          <div className="nt-service-note">No AP in this walk reported a power state.</div>
        ) : constrained.length === 0 ? (
          <div className="nt-service-note">No AP reports a power constraint.</div>
        ) : (
          constrained.map((r) => (
            <div key={r.deviceName} className="nt-ap-health-row nt-card-lift">
              <Badge tone="warning">constrained</Badge>
              <ApName row={r} context="Power" />
              <span className="nt-ap-health-fact">
                {r.powerSrc ?? 'power source not reported'} · {r.siteName}
              </span>
            </div>
          ))
        )}
      </SubGroup>

      <SubGroup label="Radio load — busiest reported">
        {radios.length === 0 ? (
          <div className="nt-service-note">No radio in this walk reported a utilization reading.</div>
        ) : (
          radios.map(({ ap, radio, util }) => (
            <div key={`${ap.deviceName}:${radio.band}`} className="nt-ap-health-row nt-card-lift">
              <span className="nt-ap-health-name">
                <ApName row={ap} context={`Radio load ${radio.band}`} />
                <span className="nt-ml-8-note nt-service-note">
                  {radio.band}
                  {radio.channel !== null ? ` · ch ${radio.channel}` : ''}
                </span>
              </span>
              <span className="nt-ap-health-fact">
                {util}% channel util
                {radio.utilNonWifiPct !== null && radio.utilNonWifiPct > 0 ? ` · ${radio.utilNonWifiPct}% non-Wi-Fi` : ''}
                {` · ${ap.siteName}`}
              </span>
            </div>
          ))
        )}
      </SubGroup>

      <SubGroup label="Environment — hottest reported">
        {withTemp.length === 0 ? (
          <div className="nt-service-note">No AP in this walk reported an environment reading.</div>
        ) : (
          withTemp.map((r) => (
            <div key={r.deviceName} className="nt-ap-health-row nt-card-lift">
              <ApName row={r} context="Environment" />
              <span className="nt-ap-health-fact">
                {r.env!.ambientTempC!.toFixed(1)}°C
                {r.env!.humidityPct !== null ? ` · ${r.env!.humidityPct}% rh` : ''}
                {` · ${r.siteName}`}
              </span>
            </div>
          ))
        )}
        {noEnv > 0 ? (
          <div className="nt-fs-105 nt-hint-muted">
            {countOf(noEnv, 'AP')} carried no environment sensor block — "not reported", never an
            assumed reading.
          </div>
        ) : null}
      </SubGroup>

      <SubGroup label="Uplinks — each AP's own LLDP report">
        {uplinks.length === 0 ? (
          <div className="nt-service-note">No AP in this walk reported an LLDP neighbour.</div>
        ) : (
          uplinks.map((r) => {
            const speed = uplinkSpeed(r);
            return (
              <div key={r.deviceName} className="nt-ap-health-row nt-card-lift">
                <ApName row={r} context="Uplink" />
                <span className="nt-ap-health-fact">
                  {r.lldpUplink!.systemName}
                  {r.lldpUplink!.portId ? ` ${r.lldpUplink!.portId}` : ''}
                  {speed ? ` · ${speed}` : ''}
                  {` · ${r.siteName}`}
                </span>
              </div>
            );
          })
        )}
      </SubGroup>
    </>
  );
}

export function ApHealthSection({ apStats }: { apStats: MistApStatsRow[] | undefined }) {
  const { toast } = useToast();
  const meta =
    apStats === undefined
      ? 'NOT REPORTED'
      : apStats.length === 0
        ? 'NO ROWS'
        : `${countOf(apStats.length, 'AP').toUpperCase()} · MIST AP-STATS`;

  return (
    <div id="mist-section-ap-health" className="nt-stack nt-gap-2 nt-ap-health nt-section-panel">
      <div className="nt-row-between-12">
        <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · Mist AP health · RF owns hue</div>
        <SectionHeader label="AP health" meta={meta} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const url = buildMistShareUrl('ap-health');
            void navigator.clipboard.writeText(url).then(
              () => toast('AP health section link copied', { description: 'section=ap-health', tone: 'success' }),
              () => toast('Could not copy link', { description: url, tone: 'warning' }),
            );
          }}
        >
          Copy section link
        </Button>
      </div>
      {apStats === undefined ? (
        <div className="nt-service-note">
          The AP-stats walk was not reported this cycle — a failed read, or no linked Mist plane.
        </div>
      ) : apStats.length === 0 ? (
        <div className="nt-service-note">
          The AP-stats walk reported no rows this cycle — a real answer from the sites read, not a
          failed walk.
        </div>
      ) : (
        <ApHealthBody rows={apStats} />
      )}
    </div>
  );
}
