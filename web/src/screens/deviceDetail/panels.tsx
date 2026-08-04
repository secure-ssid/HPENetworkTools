/** Device detail panels: radios, WLANs, ports, compliance and the config tabs. */

import {
  Badge,
  Button,
  Code,
  EmptyState,
  SectionHeader,
  SegmentedControl,
  useToast,
} from '../../nightdesk';
import {
  CFG_TABS,
  bandRank,
  detailGapSentence,
  healthTone,
  joinFacts,
  pctText,
  airtimeText,
  portAdminDown,
  portIsUp,
  statusTone,
  type CfgTab,
} from './facts';
import {
  DetailRow,
  LiveGapNote,
  PortTable,
} from './tables';
import { DiffCode } from '../../lib/DiffCode';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import { exportTableCsv } from '../../lib/csv';
import {
  detailHasRows,
  detailState,
  hhmmLocal as hhmm,
  type CfgHistoryRow,
  type DeviceCfg,
  type DeviceDetailLive,
  type DeviceEvidence,
  type DevicePort,
  type DeviceRadio,
  type DeviceWlan,
  countOf,
} from '@hpe/shared';
import { type ReactNode } from 'react';

/** Radios on an AP (Central /aps/{serial}/radios). */
export function RadiosPanel({ detail, plane }: { detail: DeviceDetailLive | null; plane: string }) {
  const state = detailState(detail?.source, 'radios');
  const radios: DeviceRadio[] = detailHasRows(detail?.source, 'radios', detail?.radios)
    ? [...(detail?.radios ?? [])].sort(
        (a, b) => bandRank(a.band) - bandRank(b.band) || a.number - b.number,
      )
    : [];
  return (
    <div className="nt-device-section nt-section-panel nt-stack-gap-2">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · device lane · state owns hue</div>
      <SectionHeader
        label="Radios"
        meta={radios.length > 0 ? `${radios.length} ON AIR` : undefined}
      />
      {radios.length === 0 ? (
        <LiveGapNote>
          {detailGapSentence(state, {
            notFetched: 'Per-radio state has not been read for this AP — the portal fetches radios on demand, for the one device being viewed.',
            empty: `${plane} answered with no radios for this AP.`,
            failed: `Per-radio state could not be read from ${plane}`,
          }, detail?.source.note)}
        </LiveGapNote>
      ) : (
        radios.map((r) => (
          <DetailRow
            key={`${r.number}-${r.band}`}
            keyText={r.band || `radio ${r.number}`}
            keyWidth={58}
            title={joinFacts([
              r.channel ? `ch ${r.channel}` : null,
              r.bandwidth || null,
              r.powerDbm == null ? null : `${r.powerDbm} dBm`,
              r.mode || null,
            ])}
            /* non-Wi-Fi interference sits against utilisation because the
               two are one reading. 78% busy with the interference low is the
               estate's own traffic — a capacity or RF-design problem, fixed
               with channels, power or more APs. The same 78% with the
               interference high is an emitter: a microwave, a camera bridge,
               radar. Adding APs makes that one worse. The panel showed the
               78% to both and Central had already told us which it was.

               `drops` was the other omission, and an arbitrary one: it is
               parsed beside `retries`, means something worse than it —
               frames given up on rather than sent again — and `retries` was
               being rendered on its own. */
            facts={joinFacts([
              r.clients == null ? null : `${countOf(r.clients, 'client')}`,
              pctText(r.channelUtilPct, 'util'),
              pctText(r.nonWifiInterference, 'non-Wi-Fi'),
              airtimeText(r.rxUtilPct, r.txUtilPct),
              r.noiseFloorDbm == null ? null : `noise ${r.noiseFloorDbm} dBm`,
              pctText(r.retries, 'retries'),
              pctText(r.drops, 'drops'),
              r.channelQuality == null ? null : `quality ${r.channelQuality}`,
            ]) || 'No per-radio counters in this read.'}
            badge={r.status || undefined}
            badgeTone={statusTone(r.status)}
          />
        ))
      )}
    </div>
  );
}

/** WLANs this AP is broadcasting (Central /aps/{serial}/wlans). */
export function WlansPanel({ detail, plane }: { detail: DeviceDetailLive | null; plane: string }) {
  const state = detailState(detail?.source, 'wlans');
  const wlans: DeviceWlan[] = detailHasRows(detail?.source, 'wlans', detail?.wlans)
    ? (detail?.wlans ?? [])
    : [];
  return (
    <div className="nt-stack-gap-2">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · device lane · state owns hue</div>
      <SectionHeader
        label="SSIDs broadcast"
        meta={wlans.length > 0 ? `${wlans.length} WLAN${wlans.length === 1 ? '' : 'S'}` : undefined}
      />
      {wlans.length === 0 ? (
        <LiveGapNote>
          {detailGapSentence(state, {
            notFetched: 'Broadcast SSIDs have not been read for this AP — the portal fetches them on demand, for the one device being viewed.',
            empty: `${plane} reports no WLAN broadcast by this AP.`,
            failed: `Broadcast SSIDs could not be read from ${plane}`,
          }, detail?.source.note)}
        </LiveGapNote>
      ) : (
        wlans.map((w) => (
          <DetailRow
            key={w.name}
            keyText={w.name}
            keyWidth={104}
            facts={joinFacts([
              w.security || w.securityLevel || null,
              w.band || null,
              w.vlan ? `VLAN ${w.vlan}` : null,
            ]) || 'No WLAN attributes in this read.'}
            trailing={
              w.clients == null ? undefined : `${countOf(w.clients, 'client')}`
            }
            badge={w.status || undefined}
            badgeTone={statusTone(w.status)}
          />
        ))
      )}
    </div>
  );
}

/** Interfaces on a switch (Central /switches/{serial}/interfaces).
 *
 *  "Of interest" is not decoration: a 48-port switch with 8 cables in it should
 *  not print 40 identical idle rows. Connected ports (and any port with a
 *  neighbour) are listed, worst far-end health first — the physical link to a
 *  gateway that is down is exactly what this screen has to surface. The header
 *  names the total so the filter can never read as "the switch has 8 ports". */
export function PortsPanel({
  detail,
  plane,
  deviceName,
  devicePlane,
  deviceSerial,
}: {
  detail: DeviceDetailLive | null;
  plane: string;
  /** When set, Export / Download server CSV use this device identity. */
  deviceName?: string;
  devicePlane?: string;
  deviceSerial?: string;
}) {
  const { toast } = useToast();
  const state = detailState(detail?.source, 'ports');
  const all: DevicePort[] = detailHasRows(detail?.source, 'ports', detail?.ports)
    ? (detail?.ports ?? [])
    : [];
  const interesting = all
    .filter((p) => portIsUp(p) || Boolean(p.neighbour))
    .sort((a, b) => {
      // Only a real adverse verdict jumps the queue. Central also answers
      // 'Unknown' on a link it has not scored, and an unscored port is not a
      // problem report — sorting it next to a 'Poor' one would invent urgency.
      const rank = (p: DevicePort) => {
        const tone = healthTone(p.neighbourHealth);
        if (tone === 'warning' || tone === 'danger') return 0;
        return portIsUp(p) ? 1 : 2;
      };
      return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  /* Ports that are down because someone disabled them, counted over every
     interface and not just the listed ones. A shut port with nothing plugged
     into it does not earn a row — that is the whole point of the filter — but
     it must not vanish either. "Why is this port dead" is answered by a
     configuration change far more often than by a fault, and a switch whose
     unused ports are shut by policy looks exactly like one where the wrong
     twenty were shut by mistake unless the number is on the screen. */
  const adminDown = all.filter((p) => portAdminDown(p) === true);
  const hiddenAdminDown = adminDown.filter((p) => !interesting.includes(p)).length;
  return (
    <div className="nt-stack-gap-2">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · device lane · state owns hue</div>
      <SectionHeader
        label="Ports of interest"
        meta={
          all.length > 0
            ? `${interesting.length} OF ${all.length} CONNECTED${adminDown.length > 0 ? ` · ${adminDown.length} ADMIN DOWN` : ''}`
            : undefined
        }
      />
      {all.length > 0 && deviceName ? (
        <div className="nt-filter-bar nt-gap-8">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const n = exportTableCsv(
                `device-ports-${deviceName}.csv`,
                ['port', 'what', 'state', 'neighbour', 'neighbourPort'],
                all.map((p) => [
                  p.name,
                  p.status || p.operStatus || '',
                  p.operStatus || p.status || '',
                  p.neighbour ?? '',
                  p.neighbourPort ?? '',
                ]),
              );
              toast(`Exported ${n} port row${n === 1 ? '' : 's'}`, {
                description: 'Current ports table on this device.',
              });
            }}
          >
            Export ports
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void (async () => {
                const qs = new URLSearchParams();
                if (devicePlane) qs.set('plane', String(devicePlane));
                if (deviceSerial) qs.set('serial', String(deviceSerial));
                const suffix = qs.toString() ? `?${qs}` : '';
                const res = await downloadApiCsv(
                  `/api/devices/${encodeURIComponent(deviceName)}/ports/export${suffix}`,
                  `device-ports-${deviceName}.csv`,
                );
                if (res.ok) {
                  toast('Server CSV downloaded', {
                    description: 'Port/interface rows from the portal inventory.',
                    tone: 'success',
                  });
                } else {
                  toast('Server CSV failed', {
                    description: res.error ?? 'Could not download ports export',
                    tone: 'warning',
                  });
                }
              })();
            }}
          >
            Download server CSV
          </Button>
        </div>
      ) : null}
      {all.length === 0 ? (
        <LiveGapNote>
          {detailGapSentence(state, {
            notFetched: 'Per-port state has not been read for this device — the portal fetches interfaces on demand, for the one device being viewed.',
            empty: `${plane} answered with no interfaces for this device.`,
            failed: `Per-port state could not be read from ${plane}`,
          }, detail?.source.note)}
        </LiveGapNote>
      ) : interesting.length === 0 ? (
        <LiveGapNote>
          {adminDown.length > 0
            ? `None of the ${all.length} interfaces ${plane} reported is connected. ${adminDown.length} ${adminDown.length === 1 ? 'is' : 'are'} administratively down — shut in configuration, not a link fault${adminDown.length === all.length ? '' : ', and the rest are down with no neighbour discovered'}.`
            : `None of the ${all.length} interfaces ${plane} reported is connected — every port is down with no neighbour discovered.`}
        </LiveGapNote>
      ) : (
        /* A table, not a paragraph per port. Every port answers the same
           questions, and most answer them identically — sixteen rows of
           '5 Gb · full · Trunk 5 + 5,200 · PoE …' forced the eye to re-read
           the same words to find the one that differed. In columns the
           repetition collapses and the outlier is the only thing that moves. */
        <PortTable rows={interesting} exportName={deviceName ? `device-ports-${deviceName}` : undefined} />
      )}
      {interesting.length > 0 && hiddenAdminDown > 0 ? (
        <LiveGapNote>
          {`${hiddenAdminDown} further ${hiddenAdminDown === 1 ? 'port is' : 'ports are'} administratively down with no neighbour discovered, and ${hiddenAdminDown === 1 ? 'is' : 'are'} not listed above.`}
        </LiveGapNote>
      ) : null}
    </div>
  );
}

/**
 * The "Compliance" panel, rendered from the ONE evidence block the route
 * serves in every mode (`data.evidence`; getDeviceDetail() normalizes a bare
 * `checks` list into the same shape, so this is the only contract the screen
 * reads). The block exists precisely so an EMPTY verdict list cannot be
 * mistaken for a clean scorecard: `mode: 'unavailable'` — and an absent block,
 * which says even less — renders a named empty state carrying the server's own
 * reason, never a silent pass.
 */
export function CompliancePanel({
  evidence,
  gapNote,
  children,
}: {
  evidence: DeviceEvidence | null;
  /** What the verdicts do NOT cover, printed under a populated list only. */
  gapNote?: ReactNode;
  children?: ReactNode;
}) {
  const scored = evidence !== null && evidence.mode !== 'unavailable' && evidence.checks.length > 0;
  return (
    <div className="nt-stack-gap-10">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · device lane · state owns hue</div>
      <SectionHeader label="Compliance" />
      {scored ? (
        <>
          {evidence.checks.map((c) => (
            <div key={c.rule ?? c.label} className="nt-row-center-10">
              <Badge tone={c.tone}>{c.mark}</Badge>
              <span
                className="nt-fs-12-sec"
              >
                {c.label}
              </span>
            </div>
          ))}
          {gapNote ? <LiveGapNote>{gapNote}</LiveGapNote> : null}
        </>
      ) : (
        <EmptyState
          title="No evidence for this device"
          description={
            evidence?.note ??
            (evidence
              ? 'The evidence block came back with no verdicts in it. An empty list is not a pass — nothing here has been checked.'
              : 'No plane supplied evidence alongside this device, so there is nothing to score. An empty list is not a pass.')
          }
        />
      )}
      {children}
    </div>
  );
}

/**
 * The Running | Drift vs. baseline | History tabs, one component shared by the
 * authored-profile view and the live view (which renders them only when the
 * route joined real config-backup snapshots for the device).
 *
 * A block carrying `provenance` IS a collected snapshot and says so in the
 * caption under the control — channel and collection time named, never
 * implied; a block without it is the authored fixture and keeps its authored
 * labelling alone. Snapshot history rows carry ISO instants the browser
 * stamps in the reader's own clock (hhmm passes through text it cannot
 * parse, so a locally-added row like 'just now' survives the same path);
 * fixture rows render their authored text verbatim.
 */
export function ConfigTabs({
  cfg,
  cfgTab,
  onTabChange,
  historyRows,
}: {
  cfg: DeviceCfg;
  cfgTab: CfgTab;
  onTabChange: (tab: CfgTab) => void;
  historyRows: CfgHistoryRow[];
}) {
  const provenance = cfg.provenance;
  return (
    <>
      <div className="nt-self-start">
        <SegmentedControl
          options={CFG_TABS}
          value={cfgTab}
          onValueChange={(v) => onTabChange(v as CfgTab)}
          ariaLabel="Configuration view"
        />
      </div>
      {provenance ? (
        <span
          className="nt-hint-muted"
        >
          {`snapshot v${provenance.version} · ${provenance.source} · ${hhmm(provenance.takenAt)}`}
        </span>
      ) : null}
      {cfgTab === 'running' ? <Code block>{cfg.running}</Code> : null}
      {cfgTab === 'diff' ? (
        cfg.diff === '' ? (
          // One snapshot is a fact, not a comparison — an empty diff pane
          // would read as "no drift" when nothing has been compared yet.
          <LiveGapNote>Only one snapshot on file — drift appears once a second collection lands.</LiveGapNote>
        ) : (
          <DiffCode text={cfg.diff} />
        )
      ) : null}
      {cfgTab === 'history' ? (
        <div className="nt-stack-gap-0">
          {historyRows.map((h, i) => (
            <div
              key={`${h.when}-${i}`}
              className="nt-session-row"
            >
              <span
                className="nt-hint-muted nt-w-88"
              >
                {provenance ? hhmm(h.when) : h.when}
              </span>
              <div className="nt-flex-1">
                <div
                  className="nt-fs-12-pri"
                >
                  {h.what}
                </div>
                <div
                  className="nt-hint-muted"
                >
                  {h.who}
                </div>
              </div>
              <Badge tone={h.tone}>{h.tag}</Badge>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
