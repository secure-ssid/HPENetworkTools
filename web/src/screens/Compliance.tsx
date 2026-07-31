/**
 * web/src/screens/Compliance.tsx — one baseline per device class, checked
 * against every plane. High-fidelity port of design/NtCompliance.dc.html:
 * five Stats; header actions (baseline Select filtering the findings table,
 * "Diff selected" toggling the drift panel, "Run scan now" showing a brief
 * Spinner then an honest toast); flair → two columns (1.7fr / 1fr). Left: the
 * Findings open table (Sev Badge + dot, finding + mono detail, mono rule,
 * plane Badge, copper mono device count → device detail, colour-coded fix
 * Badge) with a mono `N of M findings` count. Right: "Pass rate by baseline"
 * (five Progress bars with mono notes) and "Drift, as text" (DiffCode with
 * danger/success line colouring; Push fix / Accept as exception are honest
 * hand-off toasts).
 * Data: getCompliance() — live /api/compliance when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Divider,
  EmptyState,
  Progress,
  SectionHeader,
  Select,
  Spinner,
  Table,
  useToast,
} from '../nightdesk';
import { getCompliance, syncSystems } from '../api/client';
import type { ComplianceData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import type { FindingRow, Tone } from '@hpe/shared';
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

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function Compliance() {
  const navigate = useNavigate();
  const { density, showPlatformTags } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<ComplianceData | null>(null);
  const [baseline, setBaseline] = useState('all');
  const [showDrift, setShowDrift] = useState(true);
  const [scanning, setScanning] = useState(false);

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

  const runScan = async () => {
    if (scanning) return;
    // A blended run is live evidence under demo chrome — refresh it through the
    // poller like any other live section, never through the demo stopwatch.
    if (sectionLive) {
      setScanning(true);
      try {
        const result = await syncSystems();
        if (!result.ok) {
          toast('Live evidence refresh failed', { description: result.message, tone: 'warning' });
          return;
        }
        const refreshed = await getCompliance();
        setData(refreshed);
        toast('Live evidence refreshed', { description: result.message, tone: 'success' });
      } catch (err) {
        // Without this the spinner would run forever and the operator would
        // read "still scanning" when nothing is scanning.
        toast('Live evidence refresh failed', {
          description: err instanceof Error ? err.message : String(err),
          tone: 'danger',
        });
      } finally {
        setScanning(false);
      }
      return;
    }
    setScanning(true);
    window.setTimeout(() => {
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
            meta={`${rows.length} of ${findings.length} findings · ${scannedNote}`}
          />
          <Table density={density}>
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Sev</Table.HeaderCell>
                <Table.HeaderCell>Finding</Table.HeaderCell>
                <Table.HeaderCell>Rule</Table.HeaderCell>
                <Table.HeaderCell>Plane</Table.HeaderCell>
                <Table.HeaderCell numeric>Devices</Table.HeaderCell>
                <Table.HeaderCell>Fix</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {rows.map((f, i) => (
                // A live check emits one finding per (rule, plane) pair, so the
                // rule alone is not an identity — key on the pair plus the row
                // position rather than letting React reuse the wrong <tr>.
                <Table.Row key={`${f.rule}|${f.plane}|${f.device}|${i}`}>
                  <Table.Cell>
                    <Badge tone={f.tone} dot>
                      {f.sev}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
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
                  </Table.Cell>
                  <Table.Cell>
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 10.5,
                        color: 'var(--nd-text-secondary)',
                      }}
                    >
                      {f.rule}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    {showPlatformTags ? <Badge tone="neutral">{f.plane}</Badge> : null}
                  </Table.Cell>
                  <Table.Cell numeric>
                    <button
                      type="button"
                      onClick={() => navigate(`/devices/${encodeURIComponent(f.device)}`)}
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
                  </Table.Cell>
                  <Table.Cell>
                    <Badge tone={fixTone(f)}>{f.fix}</Badge>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
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
    </div>
  );
}
