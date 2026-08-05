/** Compliance screen: evidence checks, per-device coverage and the mix string. */

import { type ReconciledDeviceRow } from '../../services/reconcile';
import { reportedValue } from './context';
import {
  type BaselineProgressRow,
  type ConfigBackupSummary,
  type DeviceCheckRow,
  type DeviceType,
  type FindingRow,
  type Plane,
  type StatDef,
  type Tone,
  countOf,
} from '@hpe/shared';

/** Findings read in severity order, like the alert queue reads in P-order. */
export const FINDING_SEV_RANK: Record<FindingRow['sev'], number> = { high: 0, med: 1, low: 2 };

export interface LiveComplianceData {
  stats: StatDef[];
  findings: FindingRow[];
  baselines: BaselineProgressRow[];
  diff: string;
}

/**
 * One live-evidence predicate. `label` names the check on the estate-wide
 * Compliance screen; `pass`/`fail` are the per-DEVICE verdict lines the
 * device-detail evidence panel renders, so a single device never has to be
 * described with an estate-level sentence ("N of M devices …").
 */
export interface EvidenceCheck {
  label: string;
  rule: string;
  missing: (device: ReconciledDeviceRow) => boolean;
  pass: (device: ReconciledDeviceRow) => string;
  fail: (device: ReconciledDeviceRow) => string;
}

/**
 * The live evidence rules — ONE definition, read by /api/compliance (grouped
 * into findings and baselines) and by /api/devices/:name (one device's own
 * verdicts). Two screens evaluating the same device under differently-worded
 * copies of these predicates is the drift this list exists to prevent.
 */
export const EVIDENCE_CHECKS: EvidenceCheck[] = [
  {
    label: 'Identity evidence',
    rule: 'scan.coverage.identity',
    missing: (device: ReconciledDeviceRow) => !reportedValue(device.model),
    pass: (device) => `Identity reported by ${device.plane} — ${device.model}`,
    fail: (device) => `${device.plane} reported no model for this device`,
  },
  {
    // A device the reconcile step downgraded to 'unverified' is a DIFFERENT
    // fact from a plane that never supplied a state: the plane did answer,
    // the portal declined to trust it because that plane is behind (design
    // rule 1). Folding the two together told the operator a field was
    // missing and never that a plane was stale.
    label: 'Plane freshness',
    rule: 'scan.coverage.freshness',
    missing: (device: ReconciledDeviceRow) => device.state === 'unverified',
    pass: (device) => `${device.plane} is current — this row is verified`,
    fail: (device) => `${device.plane} is behind — this row is unverified, not current`,
  },
  {
    label: 'Reachability evidence',
    rule: 'scan.coverage.reachability',
    missing: (device: ReconciledDeviceRow) =>
      device.state !== 'up' && device.state !== 'down' && device.state !== 'unverified',
    pass: (device) => `Reachability reported — state '${device.state}'`,
    fail: (device) => `No usable reachability state ('${device.state || 'not reported'}')`,
  },
  {
    label: 'Firmware evidence',
    rule: 'scan.coverage.firmware',
    missing: (device: ReconciledDeviceRow) => !reportedValue(device.firmware),
    pass: (device) => `Firmware reported — ${device.firmware}`,
    fail: (device) => `${device.plane} reported no firmware version`,
  },
  {
    // Only a CROSS-PLANE claim is a defect. `reconciliationIssue` also
    // covers "claimed by the local collector alone", which README rule 2
    // calls a first-class device, not drift — flagging those made every
    // legitimately local-only switch a permanent, unfixable finding.
    label: 'Ownership reconciliation',
    rule: 'inventory.reconciliation',
    missing: (device: ReconciledDeviceRow) => (device.claimedBy?.length ?? 0) > 1,
    pass: () => 'One plane claims this device',
    fail: (device) => `Claimed by ${(device.claimedBy ?? [device.plane]).join(' + ')} — needs reconciliation`,
  },
];

/** Fail tone per rule: a contested claim or a stale plane is a warning; an
 *  unreported field is information, not a defect the operator can fix. */
export const EVIDENCE_FAIL_TONE: Record<string, Tone> = {
  'inventory.reconciliation': 'warning',
  'scan.coverage.freshness': 'warning',
};

/**
 * One device's own evidence verdicts — the per-device half of the same engine
 * /api/compliance runs across the estate. Read-only: liveComplianceData's
 * output is untouched, so the Compliance stats the smoke script and the web
 * Compliance tests assert cannot move.
 */
export function evidenceChecksFor(device: ReconciledDeviceRow): DeviceCheckRow[] {
  return EVIDENCE_CHECKS.map((check) => {
    const failed = check.missing(device);
    return {
      mark: failed ? 'fail' : 'pass',
      tone: failed ? (EVIDENCE_FAIL_TONE[check.rule] ?? 'info') : 'success',
      label: failed ? check.fail(device) : check.pass(device),
      rule: check.rule,
    };
  });
}

/**
 * The 'Config drift' card, fed by the config-backup service's rollup.
 *
 * Three honest states, in order of what the portal actually knows:
 *   undefined        — the caller does not track config backups (the card's
 *                      original dead state, kept for callers that only want
 *                      the findings engine);
 *   backedUp === 0   — collection is wired but no snapshot has landed yet,
 *                      which is a different fact from "no drift";
 *   otherwise        — real numbers: devices whose latest snapshot differs
 *                      from its predecessor, out of the devices that have one.
 */
export function configDriftStat(summary: ConfigBackupSummary | null | undefined): StatDef {
  if (summary === undefined || summary === null) {
    return { label: 'Config drift', value: '—', delta: 'no running-config baseline source', tone: 'neutral' };
  }
  if (summary.backedUp === 0) {
    return { label: 'Config drift', value: '—', delta: 'no config snapshots collected yet', tone: 'neutral' };
  }
  return {
    label: 'Config drift',
    value: String(summary.drift),
    delta: `of ${countOf(summary.backedUp, 'device')} with config snapshots`,
    tone: summary.drift > 0 ? 'negative' : 'positive',
  };
}

/** The evidence text's drift line — the old "cannot be evaluated" admission
 *  is only true while there are no snapshots to evaluate. */
function configDriftEvidenceLine(summary: ConfigBackupSummary | null | undefined): string {
  if (!summary || summary.backedUp === 0) {
    return '- Running configuration drift cannot be evaluated from inventory-only plane responses';
  }
  return summary.drift > 0
    ? `- Config drift: ${summary.drift} of ${summary.backedUp} devices with config snapshots differ from their previous snapshot`
    : `+ Config drift: none across ${countOf(summary.backedUp, 'device')} with config snapshots`;
}

/**
 * `missingInventories` names linked planes that contributed no device list to
 * this run. The route's only guard was datasetReported('devices'), which is
 * true as soon as ANY plane answers — so a run over the two devices Mist
 * returned, while Central's five hundred went unread, produced a full
 * coverage report and a green "Sites complete 1 / 1".
 *
 * Compliance is the screen whose entire purpose is making a truth claim about
 * the estate. A green scorecard derived from a fraction of it is the worst
 * version of the mistake this codebase keeps guarding against, because it is
 * the screen an operator would screenshot for an audit.
 *
 * `configBackup` is the backup service's rollup (see configDriftStat); omit
 * it only where the findings engine alone is wanted.
 *
 * `partialInventories` is the same argument one step along. A plane whose
 * inventory walk stopped early DID contribute, so planesMissingDataset cannot
 * see it and every number here silently narrows to the rows that arrived --
 * the identical harm the paragraph above describes, from a plane that
 * answered rather than one that did not. It gates the same tones, because a
 * scorecard drawn over part of an estate is no greener for the reason.
 */
export function liveComplianceData(
  devices: ReconciledDeviceRow[],
  missingInventories: readonly string[] = [],
  configBackup?: ConfigBackupSummary | null,
  partialInventories: readonly string[] = [],
): LiveComplianceData {
  if (devices.length === 0) return { stats: [], findings: [], baselines: [], diff: '' };

  const checks = EVIDENCE_CHECKS;

  const findings: FindingRow[] = [];
  const baselines: BaselineProgressRow[] = [];
  for (const check of checks) {
    const missing = devices.filter(check.missing);
    const pass = devices.length - missing.length;
    const value = Math.round((pass / devices.length) * 100);
    baselines.push({
      label: check.label,
      value,
      note: `${pass} of ${devices.length} devices have usable live evidence`,
    });
    const byPlane = new Map<Plane, ReconciledDeviceRow[]>();
    for (const device of missing) {
      const rows = byPlane.get(device.plane);
      if (rows) rows.push(device);
      else byPlane.set(device.plane, [device]);
    }
    for (const [plane, rows] of byPlane) {
      const reconciliation = check.rule === 'inventory.reconciliation';
      const freshness = check.rule === 'scan.coverage.freshness';
      findings.push({
        sev: reconciliation || freshness ? 'med' : 'low',
        tone: reconciliation ? 'warning' : freshness ? 'warning' : 'info',
        title: reconciliation
          ? 'Device ownership needs reconciliation'
          : freshness
            ? 'Device state unverified — plane is stale'
            : `${check.label} not reported`,
        detail: reconciliation
          ? 'Two planes claim this device identity'
          : freshness
            ? `${countOf(rows.length, 'device')} cannot be verified while ${plane} is behind`
            : 'The linked plane did not supply this field in its current inventory response',
        rule: check.rule,
        plane,
        count: String(rows.length),
        fix: reconciliation ? 'manual' : 'ssh scan',
        fixColor: reconciliation || freshness ? 'var(--nd-warning)' : 'var(--nd-text-muted)',
        // `device` is the first of `rows`, and was for a long time the only
        // one anything downstream could see — while `count` said 12. The
        // Compliance table makes that count a link, so the whole set has to
        // travel with it or the link quietly means "one of these, chosen by
        // iteration order".
        device: rows[0]!.name,
        devices: rows.map((row) => row.name),
        baseline: 'Live evidence coverage',
      });
    }
  }
  // The table leads with the Sev column, so it is the read order (the design
  // lists high → med → low). Emitting in check order buried every med-severity
  // row under the low-severity coverage ones.
  findings.sort((a, b) => FINDING_SEV_RANK[a.sev] - FINDING_SEV_RANK[b.sev] || a.rule.localeCompare(b.rule));

  const sites = new Set(devices.map((device) => device.siteId));
  const affectedSites = new Set(
    devices
      .filter((device) => checks.some((check) => check.missing(device)))
      .map((device) => device.siteId),
  );
  const cleanSites = sites.size - affectedSites.size;
  const unread = missingInventories.length > 0;
  const cutShort = partialInventories.length > 0;
  // Every tone below asks one question -- was this run over the whole estate?
  // -- and both causes answer it the same way.
  const partial = unread || cutShort;
  const clause = (...parts: (string | null)[]): string =>
    parts.filter((part): part is string => part !== null).join(' · ');
  const totalChecks = devices.length * checks.length;
  const failedChecks = checks.reduce((sum, check) => sum + devices.filter(check.missing).length, 0);

  return {
    stats: [
      { label: 'Evidence checks', value: String(totalChecks), delta: 'current poller snapshot', tone: 'neutral' },
      {
        label: 'Devices in scope',
        value: String(devices.length),
        // "from live inventory" implies the whole of it. Say which part.
        delta:
          clause(
            unread
              ? `from ${missingInventories.length} unread inventor${missingInventories.length === 1 ? 'y' : 'ies'} short of the estate`
              : null,
            cutShort ? `${partialInventories.join(', ')} read stopped early` : null,
          ) || 'from live inventory',
        tone: 'neutral',
      },
      {
        label: 'Coverage findings',
        value: String(failedChecks),
        delta: countOf(findings.length, 'grouped finding'),
        // Zero findings over a partial estate is not a clean result, so it
        // does not get the colour of one. Neutral rather than negative:
        // nothing has actually failed a check — the run is just incomplete.
        tone: failedChecks > 0 ? 'negative' : partial ? 'neutral' : 'positive',
      },
      {
        label: 'Sites complete',
        value: `${cleanSites} / ${sites.size}`,
        delta:
          clause(
            unread ? `${missingInventories.join(', ')} not in this run` : null,
            cutShort ? `${partialInventories.join(', ')} only partly in this run` : null,
          ) || 'for available evidence fields',
        tone: cleanSites === sites.size && !partial ? 'positive' : 'neutral',
      },
      configDriftStat(configBackup),
    ],
    findings,
    baselines,
    diff: [
      'Live evidence coverage',
      // The evidence text is the copy-pasteable artifact. Its scope belongs
      // in it, at the top, not only in a banner that does not survive a copy.
      ...(unread
        ? [`! Scope: ${missingInventories.join(', ')} contributed no inventory — this run does not cover them`]
        : []),
      ...(cutShort
        ? [
            `! Scope: ${partialInventories.join(', ')} stopped short of a full inventory — this run covers only the devices that were read`,
          ]
        : []),
      ...baselines.map((baseline) => `${baseline.value === 100 ? '+' : '-'} ${baseline.label}: ${baseline.note}`),
      configDriftEvidenceLine(configBackup),
    ].join('\n'),
  };
}

export const MIX_ABBR: Record<DeviceType, string> = {
  ap: 'ap',
  switch: 'sw',
  gateway: 'gw',
  controller: 'mc',
  sensor: 'uxi',
  policy: 'cppm',
};

/** '96 ap · 42 sw · 6 gw' — derived from the reconciled inventory, never authored. */
export function mixString(devices: ReconciledDeviceRow[]): string {
  const counts = new Map<DeviceType, number>();
  for (const d of devices) counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
  if (counts.size === 0) return '—';
  return [...counts.entries()].map(([t, n]) => `${n} ${MIX_ABBR[t]}`).join(' · ');
}
