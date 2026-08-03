/**
 * web/src/screens/Compliance.tsx — one baseline per device class, checked
 * against every plane. High-fidelity port of design/NtCompliance.dc.html:
 * five Stats; header actions (baseline Select filtering the findings table,
 * "Diff selected" toggling the drift panel, "Run scan now" showing a brief
 * Spinner then an honest toast); flair → two columns (1.7fr / 1fr). Left: the
 * Findings open table (Sev Badge + dot, finding + mono detail, mono rule,
 * plane Badge, copper mono device count → device detail, colour-coded fix
 * Badge) with a mono `N of M findings` count. Right: "Pass rate by baseline"
 * (five Progress bars with mono notes), "Config drift — running-config
 * snapshots" (the backup service's roster of drifted devices, each opening a
 * Drawer with the unified diff between its two newest snapshots via
 * getConfigBackupVersions + getConfigBackupDiff; demo snapshots are labelled),
 * and "Drift, as text" (DiffCode with danger/success line colouring; Push fix
 * / Accept as exception are honest hand-off toasts).
 *
 * The Findings table is the nightdesk DataTable: the column manager (View
 * options in the Findings section meta → show/hide/reorder, header-edge
 * resize) persists through SettingsContext under the 'compliance' table id.
 * Sev is the one tinted column — severity is the only value on the row with
 * a threshold vocabulary (the tint fn below documents it). The rows are
 * deliberately NOT a keyboard grid: a finding row has no primary action —
 * the device count is a nested button, already keyboard-reachable on its
 * own — and inventing a row action would put a shortcut overlay up that lies
 * about what Enter does.
 * Data: getCompliance() — live /api/compliance when the server is up, fixtures otherwise.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Divider,
  Drawer,
  EmptyState,
  Progress,
  SectionHeader,
  Select,
  Spinner,
  TableViewOptions,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { getCompliance, getConfigBackups, getConfigBackupDiff, getConfigBackupVersions, syncSystems } from '../api/client';
import type { ComplianceData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { hhmmLocal as hhmm } from '@hpe/shared';
import { findingDevicesPath } from '../app/nav';
import type { ConfigBackupDiff, ConfigBackupListEnvelope, FindingRow, Tone } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { DiffCode } from '../lib/DiffCode';
import { StatRow } from './StatRow';

/**
 * Fix-class colour. Every finding carries a `fixColor` token computed by the
 * side that knows the fix class (design/NtCompliance.dc.html:72 paints the
 * cell with it, and the live route sets it per check), so the payload's token
 * wins here and a server-side fix class can change its own colour. The map
 * below is only the fallback for a row that carries no token, and follows the
 * design's semantics: auto is the only self-healing class (success), manual
 * needs a human (warning), window and ssh scan are deferred (muted/neutral).
 */
const FIX_COLOR_TONES: Record<string, Tone> = {
  'var(--nd-success)': 'success',
  'var(--nd-warning)': 'warning',
  'var(--nd-danger)': 'danger',
  'var(--nd-info)': 'info',
  'var(--nd-text-muted)': 'neutral',
};

const FIX_TONES: Record<FindingRow['fix'], Tone> = {
  auto: 'success',
  manual: 'warning',
  window: 'neutral',
  'ssh scan': 'neutral',
};

function fixTone(f: FindingRow): Tone {
  return FIX_COLOR_TONES[f.fixColor] ?? FIX_TONES[f.fix];
}

/* The Sev tint is the finding's OWN tone — the severity vocabulary the
   payload already computed (high → danger, med → warning, low → info, exactly
   what the fixtures and the live route ship) and the same field the Sev Badge
   renders. Severity is the one value on the row that is itself a threshold
   judgement, and keying the wash on the badge's own field means the two can
   never disagree. */
function sevTint(f: FindingRow): Tone {
  return f.tone;
}

export default function Compliance() {
  const navigate = useNavigate();
  const { density, showPlatformTags, tableColumns, setTableColumns } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<ComplianceData | null>(null);
  const [baseline, setBaseline] = useState('all');
  const [showDrift, setShowDrift] = useState(true);
  const [scanning, setScanning] = useState(false);
  /* A scan finishes after the operator can have left. The load effect below
     has always guarded its own late arrival; runScan had nothing, and its two
     branches both act well after they were invoked — the live one across two
     awaits, the demo one across a 900 ms timer that was never even captured,
     so it could not be cancelled.
     A stranded setState is quiet. The toast is not: it is app-level chrome, so
     'Scan complete — 1,842 checks' surfaced on whichever screen the operator
     had moved to, announcing a run of a screen they were no longer looking at.
     Same guard CentralWebhooksPanel documents for the same reason. */
  const mountedRef = useRef(true);
  const scanTimerRef = useRef<number | null>(null);

  /* Versioned config backups: the drift roster is additive to this screen —
     a null envelope (API unreachable or in error) hides the section rather
     than painting backup data the server never claimed. */
  const [backups, setBackups] = useState<ConfigBackupListEnvelope | null>(null);
  const [driftView, setDriftView] = useState<
    | { device: string; state: 'loading' }
    | { device: string; state: 'error'; message: string }
    | { device: string; state: 'ready'; diff: ConfigBackupDiff; source: string }
    | null
  >(null);

  useEffect(() => {
    let live = true;
    void getConfigBackups().then((b) => {
      if (live) setBackups(b);
    });
    return () => {
      live = false;
    };
  }, []);

  /** Open the drift drawer for one device: the diff between its two newest
   *  snapshots. Versions come first because pruning can leave gaps — v9 → v10
   *  is not a safe guess. */
  const openDrift = async (device: string) => {
    setDriftView({ device, state: 'loading' });
    const versions = await getConfigBackupVersions(device);
    if (!versions || versions.versions.length < 2) {
      setDriftView({
        device,
        state: 'error',
        message: 'This device does not have two snapshots to diff yet — drift needs a previous version to compare against.',
      });
      return;
    }
    const [latest, previous] = versions.versions; // newest first
    const diff = await getConfigBackupDiff(device, previous.version, latest.version);
    if (!diff) {
      setDriftView({ device, state: 'error', message: 'The server did not answer with a diff.' });
      return;
    }
    setDriftView({ device, state: 'ready', diff, source: latest.source });
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (scanTimerRef.current !== null) {
        window.clearTimeout(scanTimerRef.current);
        scanTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let live = true;
    void getCompliance().then((d) => {
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

  const findings = data.findings;
  const rows = findings.filter((f) => baseline === 'all' || f.baseline === baseline);
  // Blend mode serves this screen's evidence run from live rows while the rest
  // of the payload stays demo-sourced, so provenance follows the section, not
  // the envelope's overall dataSource (README §blendLive).
  const sectionLive = data.dataSource === 'live' || (data.blended?.includes('compliance') ?? false);
  // 'scanned 09:05' is authored copy about the authored snapshot; a live or
  // blended run reports the freshness the envelope actually carries.
  const scannedNote = sectionLive
    ? `poller snapshot ${data.syncedAt ? hhmm(data.syncedAt) : 'not stamped yet'}`
    : 'scanned 09:05';
  const bases = findings.map((f) => f.baseline).filter((v, i, a) => a.indexOf(v) === i);
  const baselineOptions = [{ value: 'all', label: 'All baselines' }].concat(
    bases.map((b) => ({ value: b, label: b + ' baseline' })),
  );
  const drifted = backups?.devices.filter((d) => d.drift) ?? [];

  /* The findings table as DataTable defs. 'Finding' is the primary
     identifier — always visible, never offered for hiding; the manager
     persists against these keys under the 'compliance' table id, so renaming
     a label never orphans a saved layout. Sev is the only tinted column. */
  const findingColumns: Array<DataTableColumn<FindingRow>> = [
    {
      key: 'sev',
      title: 'Sev',
      tint: sevTint,
      render: (f) => (
        <Badge tone={f.tone} dot>
          {f.sev}
        </Badge>
      ),
    },
    {
      key: 'finding',
      title: 'Finding',
      hideable: false,
      render: (f) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>{f.title}</span>
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 10.5,
              color: 'var(--nd-text-muted)',
            }}
          >
            {f.detail}
          </span>
        </div>
      ),
    },
    {
      key: 'rule',
      title: 'Rule',
      render: (f) => (
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10.5,
            color: 'var(--nd-text-secondary)',
          }}
        >
          {f.rule}
        </span>
      ),
    },
    {
      key: 'plane',
      title: 'Plane',
      render: (f) => (showPlatformTags ? <Badge tone="neutral">{f.plane}</Badge> : null),
    },
    {
      key: 'devices',
      title: 'Devices',
      numeric: true,
      render: (f) => (
        <button
          type="button"
          onClick={() => navigate(findingDevicesPath(f.devices ?? [f.device]))}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-12)',
            color: 'var(--nd-accent-text)',
          }}
        >
          {f.count}
        </button>
      ),
    },
    {
      key: 'fix',
      title: 'Fix',
      render: (f) => <Badge tone={fixTone(f)}>{f.fix}</Badge>,
    },
  ];

  // A live check emits one finding per (rule, plane) pair, so the rule alone
  // is not an identity. DataTable's rowKey sees no index, so the identity the
  // compound Table keyed on — (rule, plane, device) plus the row position —
  // is mapped once here.
  const findingIds = new Map<FindingRow, string>(
    rows.map((f, i) => [f, `${f.rule}|${f.plane}|${f.device}|${i}`] as const),
  );

  const runScan = async () => {
    if (scanning) return;
    // A blended run is live evidence under demo chrome — refresh it through the
    // poller like any other live section, never through the demo stopwatch.
    if (sectionLive) {
      setScanning(true);
      try {
        const result = await syncSystems();
        if (!mountedRef.current) return;
        if (!result.ok) {
          toast('Live evidence refresh failed', { description: result.message, tone: 'warning' });
          return;
        }
        const refreshed = await getCompliance();
        if (!mountedRef.current) return;
        setData(refreshed);
        toast('Live evidence refreshed', { description: result.message, tone: 'success' });
      } catch (err) {
        // Without this the spinner would run forever and the operator would
        // read "still scanning" when nothing is scanning.
        if (!mountedRef.current) return;
        toast('Live evidence refresh failed', {
          description: err instanceof Error ? err.message : String(err),
          tone: 'danger',
        });
      } finally {
        if (mountedRef.current) setScanning(false);
      }
      return;
    }
    setScanning(true);
    scanTimerRef.current = window.setTimeout(() => {
      scanTimerRef.current = null;
      if (!mountedRef.current) return;
      setScanning(false);
      toast('Scan complete — 1,842 checks', {
        description: 'Demo run over the last snapshot — live scans land with the compliance backend.',
      });
    }, 900);
  };

  const pushFix = () => {
    if (sectionLive) {
      toast('Live compliance remediation is not connected', { tone: 'warning' });
      return;
    }
    toast('Demo remediation queued', {
      description: 'This affects the authored demo finding only.',
      tone: 'info',
    });
  };

  const acceptException = () => {
    if (sectionLive) {
      toast('Live compliance exceptions are not connected', { tone: 'warning' });
      return;
    }
    toast('Demo exception recorded locally', {
      description: 'The authored demo finding remains open.',
      tone: 'info',
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Govern / Compliance"
        title="Config compliance"
        subtitle={
          data.evidenceMode === 'coverage'
            ? 'Live inventory evidence coverage across every reporting plane; configuration drift requires a running-config source.'
            : 'One baseline per device class, checked against every plane — including the switches no cloud can see.'
        }
        actions={
          <>
            <div style={{ width: 210 }}>
              <Select
                options={baselineOptions}
                value={baseline}
                onValueChange={setBaseline}
                size="sm"
                aria-label="Baseline"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={() => setShowDrift((v) => !v)} disabled={!data.diff}>
              {data.evidenceMode === 'coverage' ? 'Evidence text' : 'Diff selected'}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void runScan()} disabled={scanning}>
              {scanning ? <Spinner size="sm" /> : 'Run scan now'}
            </Button>
          </>
        }
      />

      {/* The scope warning leads. Everything below it — findings, tiles, the
          evidence text — is a claim about the estate, and this says how much
          of the estate it was derived from. */}
      {(data.missingInventories ?? []).length > 0 ? (
        <Alert
          tone="warning"
          title={`This scan does not cover ${(data.missingInventories ?? []).join(', ')}`}
        >
          <span>
            {(data.missingInventories ?? []).length === 1
              ? 'That plane is linked but contributed no device inventory, so none of its devices were checked.'
              : 'Those planes are linked but contributed no device inventory, so none of their devices were checked.'}{' '}
            A clean result below is a clean result for the planes that answered — it is not a verdict on the estate,
            and should not be reported as one.
          </span>
        </Alert>
      ) : null}

      {/* Page-level status Alerts sit in the body, not in the header action row. */}
      {data.evidenceMode === 'coverage' ? (
        <Alert tone="info" title="Coverage findings are not configuration drift">
          <span>
            These checks use only fields returned by live device inventory: identity, reachability, firmware, and plane
            ownership. The portal does not claim a device is compliant when its running configuration was not reported.
          </span>
        </Alert>
      ) : data.evidenceMode === 'unavailable' ? (
        <Alert tone="warning" title="No live inventory evidence is available">
          <span>
            The portal is in live mode, so authored findings and baseline results are intentionally hidden. Link a plane
            that reports device inventory on Connected systems, then run the scan again.
          </span>
        </Alert>
      ) : null}

      {/* Five tiles on the authored path; an evidence payload that carries none
          skips the grid rather than laying out an empty five-track row. */}
      {data.stats.length > 0 ? (
        <>
          <StatRow stats={data.stats} />

          <Divider variant="flair" />
        </>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.7fr) minmax(0, 1fr)',
          gap: 34,
          alignItems: 'start',
        }}
      >
        {/* ---------------- findings ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <SectionHeader
            label="Findings"
            meta={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                {`${rows.length} of ${findings.length} findings · ${scannedNote}`}
                {/* The column manager for the table below — this screen's
                    filter (the baseline Select) lives in the header, so the
                    control rides the section meta instead. */}
                <TableViewOptions
                  columns={findingColumns}
                  config={tableColumns.compliance ?? {}}
                  onChange={(config) => setTableColumns('compliance', config)}
                />
              </span>
            }
          />
          <DataTable
            ariaLabel="Compliance findings"
            density={density}
            columns={findingColumns}
            rows={rows}
            rowKey={(f) => findingIds.get(f) ?? f.title}
            columnsConfig={tableColumns.compliance}
            onColumnsConfigChange={(config) => setTableColumns('compliance', config)}
          />
          {rows.length === 0 ? (
            <EmptyState
              title={findings.length === 0 ? 'No findings to report' : 'Nothing matches that baseline'}
              description={
                findings.length > 0
                  ? 'Choose All baselines to see the rest of the open findings.'
                  : data.evidenceMode === 'unavailable'
                    ? 'No linked plane returned device inventory, so no evidence check could run.'
                    : 'Every check in this snapshot passed.'
              }
            />
          ) : null}
        </div>

        {/* ---------------- right column ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <SectionHeader label="Pass rate by baseline" />
            {data.baselines.map((b) => (
              <div key={b.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Progress value={b.value} label={b.label} note={`${b.value}%`} />
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-10)',
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {b.note}
                </span>
              </div>
            ))}
            {data.baselines.length === 0 ? (
              <EmptyState
                title="No baseline results"
                description={
                  data.evidenceMode === 'unavailable'
                    ? 'Baselines are scored from live evidence; none was returned by the linked planes.'
                    : 'This payload carries no scored baselines.'
                }
              />
            ) : null}
          </div>

          {/* Versioned running-config snapshots (Oxidized-style): which
              devices drifted against their own previous snapshot, with the
              unified diff one click away. Demo snapshots say so. */}
          {backups ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionHeader
                label="Config drift — running-config snapshots"
                meta={`${backups.summary.backedUp} backed up · ${backups.summary.drift} drifting`}
              />
              {backups.dataSource === 'demo' ? (
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-10)',
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {backups.note ?? 'Synthesized demo snapshots — no device was contacted.'}
                </span>
              ) : null}
              {drifted.length === 0 ? (
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-10)',
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {backups.summary.backedUp === 0
                    ? 'No config snapshots collected yet — the first sweep has not landed.'
                    : `No drift across ${backups.summary.backedUp} devices with snapshots.`}
                </span>
              ) : (
                drifted.map((row) => (
                  <div
                    key={row.device}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 12, color: 'var(--nd-text-primary)' }}>
                        {row.device}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 'var(--nd-text-10)',
                          color: 'var(--nd-text-muted)',
                        }}
                      >
                        {`${row.versions} versions · latest ${row.latest ? hhmm(row.latest.takenAt) : '—'} · ${row.latest?.source ?? 'unknown source'}`}
                      </span>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => void openDrift(row.device)}>
                      View diff
                    </Button>
                  </div>
                ))
              )}
            </div>
          ) : null}

          {showDrift && data.diff ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionHeader label={data.evidenceMode === 'coverage' ? 'Evidence coverage, as text' : 'Drift, as text'} />
              <DiffCode text={data.diff} />
              {!sectionLive ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant="secondary" size="sm" onClick={pushFix}>
                    Push fix to 2 devices
                  </Button>
                  <Button variant="ghost" size="sm" onClick={acceptException}>
                    Accept as exception
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* The unified diff between the device's two newest snapshots. The
          provenance rides in the description so a screenshot of the drawer
          carries whether this is real collection or demo synthesis. */}
      <Drawer
        open={driftView !== null}
        onOpenChange={(open) => {
          if (!open) setDriftView(null);
        }}
        width="lg"
        title={driftView ? `Config drift — ${driftView.device}` : undefined}
        description={
          driftView?.state === 'ready'
            ? `v${driftView.diff.fromVersion} → v${driftView.diff.toVersion} · +${driftView.diff.added} −${driftView.diff.removed} · ${driftView.source}`
            : undefined
        }
      >
        {driftView?.state === 'loading' ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
            <Spinner size="md" />
          </div>
        ) : null}
        {driftView?.state === 'error' ? (
          <Alert tone="warning" title="Diff unavailable">
            <span>{driftView.message}</span>
          </Alert>
        ) : null}
        {driftView?.state === 'ready' ? <DiffCode text={driftView.diff.text} /> : null}
      </Drawer>
    </div>
  );
}
