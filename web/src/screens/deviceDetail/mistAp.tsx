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

/** One small gauge: a label, a track bar and the value, all nightdesk tokens. */
function Gauge({ label, pct, value }: { label: string; pct: number | null; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span
        style={{
          fontFamily: 'var(--nd-font-mono)',
          fontSize: 'var(--nd-text-10)',
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: 'var(--nd-text-muted)',
        }}
      >
        {label}
      </span>
      {pct !== null ? (
        <span
          aria-hidden
          style={{
            display: 'block',
            height: 4,
            borderRadius: 2,
            background: 'var(--nd-border-subtle)',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'block',
              height: '100%',
              width: `${Math.min(100, Math.max(0, pct))}%`,
              background: 'var(--nd-accent)',
            }}
          />
        </span>
      ) : null}
      <span
        style={{
          fontFamily: 'var(--nd-font-mono)',
          fontSize: 'var(--nd-text-11)',
          color: 'var(--nd-text-primary)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** The airtime split's segment colours. `util_all` decomposes into these four
 *  reported counters; the bar shows the components, the headline names the
 *  total Mist reported beside them — never a re-summed stand-in for it. */
const AIRTIME_SEGMENTS: Array<{
  key: 'utilTxPct' | 'utilRxInBssPct' | 'utilRxOtherBssPct' | 'utilNonWifiPct';
  label: string;
  color: string;
}> = [
  { key: 'utilTxPct', label: 'tx', color: 'var(--nd-accent)' },
  { key: 'utilRxInBssPct', label: 'rx', color: 'var(--nd-info)' },
  { key: 'utilRxOtherBssPct', label: 'other BSS', color: 'var(--nd-warning)' },
  { key: 'utilNonWifiPct', label: 'non-Wi-Fi', color: 'var(--nd-danger)' },
];

/** One radio: band, tuning facts, the stacked airtime bar and its legend. */
function RadioRow({ radio }: { radio: MistApRadioStats }) {
  const segments = AIRTIME_SEGMENTS.filter((s) => radio[s.key] !== null);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '9px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-primary)',
            width: 58,
            flex: '0 0 58px',
          }}
        >
          {radio.band}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            color: 'var(--nd-text-muted)',
            lineHeight: 1.6,
          }}
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
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              color: 'var(--nd-text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            util {radio.utilAllPct}%
          </span>
        ) : null}
      </div>
      {segments.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 68 }}>
          <span
            aria-hidden
            style={{
              display: 'flex',
              flex: '0 1 220px',
              height: 5,
              borderRadius: 2,
              background: 'var(--nd-border-subtle)',
              overflow: 'hidden',
            }}
          >
            {segments.map((s) => (
              <span
                key={s.key}
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.min(100, Math.max(0, radio[s.key] as number))}%`,
                  background: s.color,
                }}
              />
            ))}
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              color: 'var(--nd-text-muted)',
            }}
          >
            {segments.map((s) => (
              <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: 1, background: s.color }} />
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader label="AP health & RF" meta="MIST AP STATS" />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
          gap: 14,
          padding: '10px 0 4px',
        }}
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
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 0',
          borderBottom: '1px solid var(--nd-border-subtle)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: 'var(--nd-text-muted)',
            width: 92,
            flex: '0 0 92px',
          }}
        >
          Power
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-secondary)',
          }}
        >
          {row.powerSrc ?? 'not reported'}
        </span>
        {/* Mist's own flag, verbatim: a constrained AP sheds radios/PoE
            features, which reframes every RF number above it. */}
        {row.powerConstrained === true ? <Badge tone="warning">power constrained</Badge> : null}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 0',
          borderBottom: '1px solid var(--nd-border-subtle)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: 'var(--nd-text-muted)',
            width: 92,
            flex: '0 0 92px',
          }}
        >
          Environment
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-secondary)',
          }}
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
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            color: 'var(--nd-text-muted)',
            padding: '8px 0',
            lineHeight: 1.6,
          }}
        >
          The stats row carried no radio readings for this AP.
        </div>
      ) : (
        row.radios.map((radio) => <RadioRow key={radio.band} radio={radio} />)
      )}

      {row.ports.map((port) => (
        <div
          key={port.name}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 0',
            borderBottom: '1px solid var(--nd-border-subtle)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-primary)',
              width: 92,
              flex: '0 0 92px',
            }}
          >
            {port.name}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              color: 'var(--nd-text-muted)',
              lineHeight: 1.6,
            }}
          >
            {portLine(port) || 'no port counters on this stats row'}
          </span>
        </div>
      ))}

      {lldp !== null ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 0',
            borderBottom: '1px solid var(--nd-border-subtle)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: 'var(--nd-text-muted)',
              width: 92,
              flex: '0 0 92px',
            }}
          >
            LLDP uplink
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              color: 'var(--nd-text-muted)',
              lineHeight: 1.6,
            }}
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
