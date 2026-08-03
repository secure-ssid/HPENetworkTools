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

import { Badge, SectionHeader } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { MistApStatsRow } from '@hpe/shared';
import { noteStyle } from './style';

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '7px 0',
  borderBottom: '1px solid var(--nd-border-subtle)',
} as const;

const nameStyle = {
  flex: 1,
  minWidth: 0,
  fontSize: 'var(--nd-text-12)',
  color: 'var(--nd-text-primary)',
} as const;

const factStyle = { ...noteStyle, fontSize: 'var(--nd-text-10)', textAlign: 'right' } as const;

function SubGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 8 }}>
      <span className="nd-micro-label">{label}</span>
      {children}
    </div>
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
          <div style={noteStyle}>No AP in this walk reported a power state.</div>
        ) : constrained.length === 0 ? (
          <div style={noteStyle}>No AP reports a power constraint.</div>
        ) : (
          constrained.map((r) => (
            <div key={r.deviceName} style={rowStyle}>
              <Badge tone="warning">constrained</Badge>
              <span style={nameStyle}>{r.deviceName}</span>
              <span style={factStyle}>
                {r.powerSrc ?? 'power source not reported'} · {r.siteName}
              </span>
            </div>
          ))
        )}
      </SubGroup>

      <SubGroup label="Radio load — busiest reported">
        {radios.length === 0 ? (
          <div style={noteStyle}>No radio in this walk reported a utilization reading.</div>
        ) : (
          radios.map(({ ap, radio, util }) => (
            <div key={`${ap.deviceName}:${radio.band}`} style={rowStyle}>
              <span style={nameStyle}>
                {ap.deviceName}
                <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', marginLeft: 8 }}>
                  {radio.band}
                  {radio.channel !== null ? ` · ch ${radio.channel}` : ''}
                </span>
              </span>
              <span style={factStyle}>
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
          <div style={noteStyle}>No AP in this walk reported an environment reading.</div>
        ) : (
          withTemp.map((r) => (
            <div key={r.deviceName} style={rowStyle}>
              <span style={nameStyle}>{r.deviceName}</span>
              <span style={factStyle}>
                {r.env!.ambientTempC!.toFixed(1)}°C
                {r.env!.humidityPct !== null ? ` · ${r.env!.humidityPct}% rh` : ''}
                {` · ${r.siteName}`}
              </span>
            </div>
          ))
        )}
        {noEnv > 0 ? (
          <div style={{ ...noteStyle, fontSize: 10.5, paddingTop: 4 }}>
            {countOf(noEnv, 'AP')} carried no environment sensor block — "not reported", never an
            assumed reading.
          </div>
        ) : null}
      </SubGroup>

      <SubGroup label="Uplinks — each AP's own LLDP report">
        {uplinks.length === 0 ? (
          <div style={noteStyle}>No AP in this walk reported an LLDP neighbour.</div>
        ) : (
          uplinks.map((r) => {
            const speed = uplinkSpeed(r);
            return (
              <div key={r.deviceName} style={rowStyle}>
                <span style={nameStyle}>{r.deviceName}</span>
                <span style={factStyle}>
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
  const meta =
    apStats === undefined
      ? 'NOT REPORTED'
      : apStats.length === 0
        ? 'NO ROWS'
        : `${countOf(apStats.length, 'AP').toUpperCase()} · MIST AP-STATS`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader label="AP health" meta={meta} />
      {apStats === undefined ? (
        <div style={noteStyle}>
          The AP-stats walk was not reported this cycle — a failed read, or no linked Mist plane.
        </div>
      ) : apStats.length === 0 ? (
        <div style={noteStyle}>
          The AP-stats walk reported no rows this cycle — a real answer from the sites read, not a
          failed walk.
        </div>
      ) : (
        <ApHealthBody rows={apStats} />
      )}
    </div>
  );
}
