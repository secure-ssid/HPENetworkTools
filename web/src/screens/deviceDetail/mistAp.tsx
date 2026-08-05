/**
 * The Mist AP health & RF panel — the device page's rendering of the Mist
 * site stats walk (MistApStatsRow), attached to the device payload as
 * `mistAp`.
 *
 * Everything here is a field the stats row actually carried: per-band
 * channel/bandwidth/power/noise floor with the full airtime split (tx, rx
 * in-BSS, rx other-BSS, non-Wi-Fi — the components of `util_all`), CPU and
 * memory, power source with the constrained flag, uplink port stats, and the
 * LLDP uplink neighbour. A reading the row did not carry contributes no
 * number, no bar segment and no legend entry — an AP without env sensors
 * (the AP32 publishes no `env_stat` block) reads "not reported", never a
 * fabricated 21.5 °C.
 */

import { Badge, SectionHeader } from '../../nightdesk';
import { byteText, joinFacts, speedText } from './facts';
import type { MistApPortStats, MistApRadioStats, MistApStatsRow } from '@hpe/shared';

/** Seconds of uptime as an engineer words it: 3945600 → '46 d'. */
export function uptimeText(sec: number): string {
  if (sec >= 86_400) return `${Math.round(sec / 86_400)} d`;
  if (sec >= 3_600) return `${Math.round(sec / 3_600)} h`;
  return `${Math.max(1, Math.round(sec / 60))} min`;
}

/** One small gauge: a label, the value, and (when there is a percentage) the
 *  track bar under it. Value before bar so that all four gauges in a row put
 *  their numbers on the same baseline — with the bar in between, CPU and
 *  Memory printed their readings ~30px below Uptime and Clients, and a row of
 *  metrics you cannot scan across is not a row of metrics. */
function Gauge({ label, pct, value }: { label: string; pct: number | null; value: string }) {
  return (
    <div className="nt-mist-section nt-section-panel nt-stack nt-gap-5 nt-min-w-0">
      <span
        className="nt-mono-label"
      >
        {label}
      </span>
      <span
        className="nt-configure-row__name-primary"
      >
        {value}
      </span>
      {pct !== null ? (
        <span
          aria-hidden
          className="nt-bar-track"
        >
          <span
            className="nt-bar-fill" style={{ ["--nd-health" as string]: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}

/** The airtime split's segment colours. `util_all` decomposes into these four
 *  reported counters; the bar shows the components, the headline names the
 *  total Mist reported beside them — never a re-summed stand-in for it. */
const AIRTIME_SEGMENTS: Array<{
  key: 'utilTxPct' | 'utilRxInBssPct' | 'utilRxOtherBssPct' | 'utilNonWifiPct';
  label: string;
  seg: 'tx' | 'rx' | 'other' | 'nonwifi';
}> = [
  { key: 'utilTxPct', label: 'tx', seg: 'tx' },
  { key: 'utilRxInBssPct', label: 'rx', seg: 'rx' },
  { key: 'utilRxOtherBssPct', label: 'other BSS', seg: 'other' },
  { key: 'utilNonWifiPct', label: 'non-Wi-Fi', seg: 'nonwifi' },
];

/** One radio: band, tuning facts, the stacked airtime bar and its legend. */
function RadioRow({ radio }: { radio: MistApRadioStats }) {
  const segments = AIRTIME_SEGMENTS.filter((s) => radio[s.key] !== null);
  return (
    <div
      className="nt-stack nt-gap-5 nt-rule-row"
    >
      <div className="nt-row-baseline nt-gap-10">
        <span
          className="nt-mono-11 nt-w-58 nt-text-pri-12 nt-lh-inherit"
        >
          {radio.band}
        </span>
        <span
          className="nt-hint-muted nt-flex-1 nt-lh-16"
        >
          {joinFacts([
            radio.channel !== null ? `ch ${radio.channel}` : null,
            radio.bandwidthMHz !== null ? `${radio.bandwidthMHz} MHz` : null,
            radio.powerDbm !== null ? `${radio.powerDbm} dBm` : null,
            radio.noiseFloorDbm !== null ? `noise ${radio.noiseFloorDbm} dBm` : null,
            radio.numClients !== null ? `${radio.numClients} client${radio.numClients === 1 ? '' : 's'}` : null,
          ]) || 'No per-radio counters on this stats row.'}
        </span>
        {radio.utilAllPct !== null ? (
          <span
            className="nt-mono-11 nt-hint-muted nt-text-sec nt-nowrap"
          >
            util {radio.utilAllPct}%
          </span>
        ) : null}
      </div>
      {segments.length > 0 ? (
        <div className="nt-indent-68">
          <span
            aria-hidden
            className="nt-bar-track--lg"
          >
            {segments.map((s) => (
              <span
                key={s.key}
                className="nt-bar-fill"
                data-seg={s.seg}
                style={{ ["--nd-health" as string]: `${Math.min(100, Math.max(0, radio[s.key] as number))}%` }}
              />
            ))}
          </span>
          <span
            className="nt-row nt-hint-muted nt-gap-10"
          >
            {segments.map((s) => (
              <span key={s.key} className="nt-row-center nt-gap-4 nt-inline-flex">
                <span aria-hidden className="nt-swatch" data-seg={s.seg} />
                {`${s.label} ${radio[s.key]}%`}
              </span>
            ))}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The uplink half of a port row: link facts, counters, peak. */
function portLine(port: MistApPortStats): string {
  return joinFacts([
    port.up === null ? null : port.up ? 'up' : 'down',
    port.speedMbps !== null ? speedText(port.speedMbps * 1_000_000) : null,
    port.fullDuplex === null ? null : port.fullDuplex ? 'full' : 'half',
    port.rxBytes !== null ? `rx ${byteText(port.rxBytes)}` : null,
    port.txBytes !== null ? `tx ${byteText(port.txBytes)}` : null,
    port.rxErrors !== null && port.txErrors !== null ? `${port.rxErrors + port.txErrors} err` : null,
    port.peakBps !== null ? `peak ${speedText(port.peakBps)}` : null,
  ]);
}

export function MistApPanel({ row }: { row: MistApStatsRow }) {
  const memPct =
    row.memUsedKb !== null && row.memTotalKb !== null && row.memTotalKb > 0
      ? Math.round((row.memUsedKb / row.memTotalKb) * 100)
      : null;
  const lldp = row.lldpUplink;
  return (
    <div className="nt-stack nt-gap-2">
      <SectionHeader label="AP health & RF" meta="MIST AP STATS" />

      <div
        className="nt-metric-grid-auto"
      >
        {row.cpuUtilPct !== null ? <Gauge label="CPU" pct={row.cpuUtilPct} value={`${row.cpuUtilPct}%`} /> : null}
        {memPct !== null ? (
          <Gauge
            label="Memory"
            pct={memPct}
            value={`${Math.round((row.memUsedKb ?? 0) / 1024)} of ${Math.round((row.memTotalKb ?? 1) / 1024)} MB`}
          />
        ) : null}
        {row.uptimeSec !== null ? <Gauge label="Uptime" pct={null} value={uptimeText(row.uptimeSec)} /> : null}
        {row.numClients !== null ? <Gauge label="Clients" pct={null} value={String(row.numClients)} /> : null}
      </div>

      <div
        className="nt-row-center nt-gap-10 nt-rule-row"
      >
        <span
          className="nt-mono-label nt-w-92"
        >
          Power
        </span>
        <span
          className="nt-mono-11 nt-flex-1 nt-text-sec"
        >
          {row.powerSrc ?? 'not reported'}
        </span>
        {/* Mist's own flag, verbatim: a constrained AP sheds radios/PoE
            features, which reframes every RF number above it. */}
        {row.powerConstrained === true ? <Badge tone="warning">power constrained</Badge> : null}
      </div>

      <div
        className="nt-row-center nt-gap-10 nt-rule-row"
      >
        <span
          className="nt-mono-label nt-w-92"
        >
          Environment
        </span>
        <span
          className="nt-mono-11 nt-flex-1 nt-text-sec"
        >
          {row.env === null
            ? // The AP32 class carries no env sensor block — "not reported"
              // is the whole sentence, never a fabricated comfortable number.
              'not reported — this AP published no env sensor readings'
            : joinFacts([
                row.env.ambientTempC !== null ? `${row.env.ambientTempC} °C` : null,
                row.env.humidityPct !== null ? `${row.env.humidityPct}% RH` : null,
              ]) || 'env sensors present, no readings on this row'}
        </span>
      </div>

      {row.radios.length === 0 ? (
        <div
          className="nt-hint-muted nt-service-note nt-pad-y-8"
        >
          The stats row carried no radio readings for this AP.
        </div>
      ) : (
        row.radios.map((radio) => <RadioRow key={radio.band} radio={radio} />)
      )}

      {row.ports.map((port) => (
        <div
          key={port.name}
          className="nt-row-center nt-gap-10 nt-rule-row"
        >
          <span
            className="nt-fact-row__k nt-mono-11 nt-text-pri-12 nt-lh-inherit"
          >
            {port.name}
          </span>
          <span
            className="nt-hint-muted nt-flex-1 nt-lh-16"
          >
            {portLine(port) || 'no port counters on this stats row'}
          </span>
        </div>
      ))}

      {lldp !== null ? (
        <div
          className="nt-row-center nt-gap-10 nt-rule-row"
        >
          <span
            className="nt-mono-label nt-w-92"
          >
            LLDP uplink
          </span>
          <span
            className="nt-hint-muted nt-flex-1 nt-lh-16"
          >
            {joinFacts([
              lldp.systemName !== null
                ? `${lldp.systemName}${lldp.portId !== null ? ` ${lldp.portId}` : ''}`
                : lldp.portId,
              lldp.systemDesc,
              lldp.mgmtAddr,
            ]) || ' neighbour heard, unnamed'}
            {' — reported by this AP via LLDP'}
          </span>
        </div>
      ) : null}
    </div>
  );
}
