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
  Progress,
  SectionHeader,
  Select,
  Spinner,
  Stat,
  Table,
  useToast,
} from '../nightdesk';
import { getCompliance, syncSystems } from '../api/client';
import type { ComplianceData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import type { FindingRow, Tone } from '../../../shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { DiffCode } from '../lib/DiffCode';

/** Fix-class Badge tones: auto=success, manual=neutral, window=warning, ssh scan=info. */
const FIX_TONES: Record<FindingRow['fix'], Tone> = {
  auto: 'success',
  manual: 'neutral',
  window: 'warning',
  'ssh scan': 'info',
};

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
  const bases = findings.map((f) => f.baseline).filter((v, i, a) => a.indexOf(v) === i);
  const baselineOptions = [{ value: 'all', label: 'All baselines' }].concat(
    bases.map((b) => ({ value: b, label: b + ' baseline' })),
  );

  const runScan = async () => {
    if (scanning) return;
    if (data.dataSource === 'live') {
      setScanning(true);
      const result = await syncSystems();
      if (!result.ok) {
        setScanning(false);
        toast('Live evidence refresh failed', { description: result.message, tone: 'warning' });
        return;
      }
      const refreshed = await getCompliance();
      setData(refreshed);
      setScanning(false);
      toast('Live evidence refreshed', { description: result.message, tone: 'success' });
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
    if (data.dataSource === 'live') {
      toast('Live compliance remediation is not connected', { tone: 'warning' });
      return;
    }
    toast('Demo remediation queued', {
      description: 'This affects the authored demo finding only.',
      tone: 'info',
    });
  };

  const acceptException = () => {
    if (data.dataSource === 'live') {
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

              {data.evidenceMode === 'unavailable' ? (
                <Alert tone="warning" title="No live inventory evidence is available">
                  <span>
                    The portal is in live mode, so authored findings and baseline results are intentionally hidden.
                  </span>
                </Alert>
              ) : null}
            </div>
            <Button variant="secondary" size="sm" onClick={() => setShowDrift((v) => !v)} disabled={!data.diff}>
              {data.evidenceMode === 'coverage' ? 'Evidence text' : 'Diff selected'}
            </Button>
            <Button variant="primary" size="sm" onClick={runScan} disabled={scanning}>
              {scanning ? <Spinner size="sm" /> : 'Run scan now'}
            </Button>
          </>
        }
      />

      {data.evidenceMode === 'coverage' ? (
        <Alert tone="info" title="Coverage findings are not configuration drift">
          <span>
            These checks use only fields returned by live device inventory: identity, reachability, firmware, and plane
            ownership. The portal does not claim a device is compliant when its running configuration was not reported.
          </span>
        </Alert>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: 18,
        }}
      >
        {data.stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} deltaTone={s.tone} />
        ))}
      </div>

      <Divider variant="flair" />

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
            meta={`${rows.length} of ${findings.length} findings · ${data.dataSource === 'live' ? 'current poller snapshot' : 'scanned 09:05'}`}
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
              {rows.map((f) => (
                <Table.Row key={f.rule}>
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
                    <Badge tone={FIX_TONES[f.fix]}>{f.fix}</Badge>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
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
          </div>

          {showDrift && data.diff ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionHeader label={data.evidenceMode === 'coverage' ? 'Evidence coverage, as text' : 'Drift, as text'} />
              <DiffCode text={data.diff} />
              {data.dataSource === 'demo' ? (
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
