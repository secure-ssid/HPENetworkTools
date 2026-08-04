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
 * a threshold vocabulary (the tint fn below documents it). Multi-select makes
 * the table a keyboard grid for j/k/x/Esc (selection only — Enter has no
 * primary row action; the device count stays a nested button). Header
 * `KeyboardShortcuts` surfaces that map (Loop 199).
 * Export/share polish: **Copy filter link** (`?baseline=` / `?sev=` / `?plane=` /
 * `?fix=` / `?q=`), filter-row write-back so a refresh reopens the same slice,
 * a **Severity** chip row (counts over baseline+plane+fix+q) toggling the same
 * `?sev=` as the header Select, a **Plane** chip row (counts over
 * baseline+sev+fix+q — Loop 143) toggling the same `?plane=`, a **Fix** chip
 * row (counts over baseline+sev+plane+q — Loop 146) toggling the same `?fix=`,
 * a **Baseline** chip row (counts over sev+plane+fix+q — Loop 152) toggling the
 * same `?baseline=` as the header Select,
 * filtered empties offering **Clear filters**, client **Export CSV** of the filtered findings,
 * live **Download server CSV** via `GET /api/compliance/export` with the same
 * baseline/sev/plane/fix/q query (findings only — no full diff bodies; stats
 * stay unfiltered on the list envelope), plus VisualReference +
 * ConfigRecommendations panels. Header **LIVE** stamps pure live and blend feeds
 * alike (Loop 159). Findings multi-select raises a bulk bar: **Export selected**,
 * **Copy rules** (unique newline-joined rule ids for ticket/playbook paste —
 * Devices **Copy serials** pattern; Loop 172), **Copy names** (unique
 * newline-joined finding titles when rule ids are sparse — Devices / Clients
 * pattern; Loop 231), **Copy selection link** (`?rules=` of unique rule ids —
 * Licences `?skus=` pattern; clearable chip while active; Loop 177), and Clear
 * (Loop 165). Selection-empty `?rules=` offers **Clear selection filter**
 * (Loop 213). Device-count
 * drill-down opens every device the finding counted (`findingDevicesPath`).
 * Data: getCompliance() — live /api/compliance when the server is up, fixtures otherwise.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  Divider,
  Drawer,
  EmptyState,
  Input,
  KeyboardShortcuts,
  Progress,
  PageSkeleton,
  SectionHeader,
  Select,
  Skeleton,
  Spinner,
  TableViewOptions,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { getCompliance, getConfigBackups, getConfigBackupDiff, getConfigBackupVersions, syncSystems } from '../api/client';
import type { ComplianceData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { countOf, hhmmLocal as hhmm } from '@hpe/shared';
import { findingDevicesPath, namesFilterForParam } from '../app/nav';
import type { ConfigBackupDiff, ConfigBackupListEnvelope, FindingRow, Tone } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { DiffCode } from '../lib/DiffCode';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
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

const SEV_OPTIONS = [
  { value: 'all', label: 'All severities' },
  { value: 'high', label: 'High' },
  { value: 'med', label: 'Med' },
  { value: 'low', label: 'Low' },
];

const FIX_OPTIONS = [
  { value: 'all', label: 'All fix classes' },
  { value: 'auto', label: 'Auto' },
  { value: 'manual', label: 'Manual' },
  { value: 'window', label: 'Window' },
  { value: 'ssh scan', label: 'SSH scan' },
];

const SEV_VALUES = new Set(['high', 'med', 'low']);
const FIX_VALUES = new Set(['auto', 'manual', 'window', 'ssh scan']);

function sevFilterForParam(raw: string | null): string {
  const v = raw?.trim().toLowerCase() ?? '';
  return SEV_VALUES.has(v) ? v : 'all';
}

function fixFilterForParam(raw: string | null): string {
  const v = raw?.trim().toLowerCase() ?? '';
  return FIX_VALUES.has(v) ? v : 'all';
}

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
  const [searchParams, setSearchParams] = useSearchParams();
  const { density, showPlatformTags, tableColumns, setTableColumns } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<ComplianceData | null>(null);
  const [baseline, setBaseline] = useState(() => {
    const b = searchParams.get('baseline')?.trim();
    return b && b.length > 0 ? b : 'all';
  });
  const [sev, setSev] = useState(() => sevFilterForParam(searchParams.get('sev')));
  const [plane, setPlane] = useState(() => {
    const p = searchParams.get('plane')?.trim();
    return p && p.length > 0 ? p : 'all';
  });
  const [fix, setFix] = useState(() => fixFilterForParam(searchParams.get('fix')));
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [showDrift, setShowDrift] = useState(true);
  const [scanning, setScanning] = useState(false);
  /** Multi-select for bulk Export selected (x toggles focused row; Esc clears). */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /compliance?rules=a\nb (bulk Copy selection link). Read off the URL
   * like Licences ?skus= — must not drift from the address bar. */
  const rulesFilter = namesFilterForParam(searchParams.get('rules'));
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

  /* Keep ?baseline= / ?sev= / ?plane= / ?fix= / ?q= aligned with the filter row so a
     refresh or shared URL opens the same findings slice (Sites/Devices pattern).
     Selection deep-link `rules=` is URL-owned (Copy selection link) and preserved here. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (baseline !== 'all') next.set('baseline', baseline);
    else next.delete('baseline');
    if (sev !== 'all') next.set('sev', sev);
    else next.delete('sev');
    if (plane !== 'all') next.set('plane', plane);
    else next.delete('plane');
    if (fix !== 'all') next.set('fix', fix);
    else next.delete('fix');
    const qTrim = q.trim();
    if (qTrim) next.set('q', qTrim);
    else next.delete('q');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [baseline, sev, plane, fix, q, searchParams, setSearchParams]);

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const findings = data.findings;
  const qNeedle = q.trim().toLowerCase();
  /* q only — baseline/sev/plane/fix stay out so each chip row can count over
   * the complementary universe while its own filter is active. Selection
   * deep-link `rules=` narrows every universe. */
  const findingMatchesQ = (f: FindingRow): boolean => {
    if (qNeedle) {
      const hay = [f.title, f.detail, f.rule, f.device, f.plane, f.baseline]
        .map((v) => String(v ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(qNeedle)) return false;
    }
    return true;
  };
  const matchesRules = (f: FindingRow) =>
    rulesFilter === null || rulesFilter.includes((f.rule ?? '').trim());
  const matchesBaseline = (f: FindingRow) => baseline === 'all' || f.baseline === baseline;
  const findingMatchesBase = (f: FindingRow): boolean =>
    findingMatchesQ(f) && matchesRules(f) && matchesBaseline(f);
  const matchesSev = (f: FindingRow) => sev === 'all' || f.sev === sev;
  const matchesPlane = (f: FindingRow) => plane === 'all' || f.plane === plane;
  const matchesFix = (f: FindingRow) =>
    fix === 'all' || String(f.fix ?? '').toLowerCase() === fix;
  /* Severity chips: baseline+plane+fix+q+rules (not sev); plane: baseline+sev+fix+q+rules;
   * fix: baseline+sev+plane+q+rules (Loop 146); baseline: sev+plane+fix+q+rules (Loop 152). */
  const sevUniverse = findings.filter(
    (f) => findingMatchesBase(f) && matchesPlane(f) && matchesFix(f),
  );
  const planeUniverse = findings.filter(
    (f) => findingMatchesBase(f) && matchesSev(f) && matchesFix(f),
  );
  const fixUniverse = findings.filter(
    (f) => findingMatchesBase(f) && matchesSev(f) && matchesPlane(f),
  );
  const baselineUniverse = findings.filter(
    (f) =>
      findingMatchesQ(f) && matchesRules(f) && matchesSev(f) && matchesPlane(f) && matchesFix(f),
  );
  const rows = findings.filter(
    (f) => findingMatchesBase(f) && matchesSev(f) && matchesPlane(f) && matchesFix(f),
  );
  const rulesPresent =
    rulesFilter === null
      ? 0
      : rulesFilter.filter((rule) => findings.some((f) => (f.rule ?? '').trim() === rule)).length;
  const SEV_CHIP_META: Array<{ key: 'high' | 'med' | 'low'; label: string; tone: Tone }> = [
    { key: 'high', label: 'High', tone: 'danger' },
    { key: 'med', label: 'Med', tone: 'warning' },
    { key: 'low', label: 'Low', tone: 'info' },
  ];
  const FIX_CHIP_META: Array<{ key: string; label: string; tone: Tone }> = [
    { key: 'auto', label: 'Auto', tone: 'success' },
    { key: 'manual', label: 'Manual', tone: 'warning' },
    { key: 'window', label: 'Window', tone: 'neutral' },
    { key: 'ssh scan', label: 'SSH scan', tone: 'neutral' },
  ];
  const sevChips = SEV_CHIP_META.map((m) => ({
    ...m,
    count: sevUniverse.filter((f) => f.sev === m.key).length,
  })).filter((c) => c.count > 0 || sev === c.key);
  const planeChipKeys = [
    ...new Set(planeUniverse.map((f) => String(f.plane ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (plane !== 'all' && !planeChipKeys.includes(plane)) planeChipKeys.unshift(plane);
  const planeChips = planeChipKeys
    .map((key) => ({
      key,
      label: key,
      count: planeUniverse.filter((f) => f.plane === key).length,
    }))
    .filter((c) => c.count > 0 || plane === c.key);
  const fixChips = FIX_CHIP_META.map((m) => ({
    ...m,
    count: fixUniverse.filter((f) => String(f.fix ?? '').toLowerCase() === m.key).length,
  })).filter((c) => c.count > 0 || fix === c.key);
  const baselineChipKeys = [
    ...new Set(baselineUniverse.map((f) => String(f.baseline ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (baseline !== 'all' && !baselineChipKeys.includes(baseline)) baselineChipKeys.unshift(baseline);
  const baselineChips = baselineChipKeys
    .map((key) => ({
      key,
      label: key,
      count: baselineUniverse.filter((f) => f.baseline === key).length,
    }))
    .filter((c) => c.count > 0 || baseline === c.key);
  const filtersActive =
    baseline !== 'all' ||
    sev !== 'all' ||
    plane !== 'all' ||
    fix !== 'all' ||
    q.trim().length > 0 ||
    rulesFilter !== null;
  const clearComplianceFilters = () => {
    setBaseline('all');
    setSev('all');
    setPlane('all');
    setFix('all');
    setQ('');
    if (rulesFilter !== null) {
      const next = new URLSearchParams(searchParams);
      next.delete('rules');
      setSearchParams(next, { replace: true });
    }
    setSelectedKeys([]);
  };
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
  if (baseline !== 'all' && !baselineOptions.some((o) => o.value === baseline)) {
    baselineOptions.push({ value: baseline, label: `${baseline} (no findings)` });
  }
  const planeOptions = [{ value: 'all', label: 'All planes' }].concat(
    findings
      .map((f) => f.plane)
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((p) => ({ value: p, label: p })),
  );
  if (plane !== 'all' && !planeOptions.some((o) => o.value === plane)) {
    planeOptions.push({ value: plane, label: `${plane} (no findings)` });
  }
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
        <div className="nt-stack-col nt-gap-2">
          <span className="nt-fs-13-primary">{f.title}</span>
          <span
            className="nt-hint-muted"
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
          className="nt-mono-11 nt-text-sec"
        >
          {f.rule}
        </span>
      ),
    },
    {
      key: 'plane',
      title: 'Plane',
      render: (f) => (showPlatformTags ? <Badge plane>{f.plane}</Badge> : null),
    },
    {
      key: 'devices',
      title: 'Devices',
      numeric: true,
      render: (f) => (
        <button
          type="button"
          onClick={() => navigate(findingDevicesPath(f.devices ?? [f.device]))}
          className="nt-mono-link nt-fs-12-pri nt-inherit"
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
    <div className="nt-stack-col nt-gap-20 nt-recon-reveal nt-compliance-shell nt-section-panel">
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
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · baseline
            </span>
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <div className="nt-w-210">
              <Select
                options={baselineOptions}
                value={baseline}
                onValueChange={setBaseline}
                size="sm"
                aria-label="Baseline"
              />
            </div>
            <div className="nt-filter-field nt-filter-field--sm">
              <Select
                options={SEV_OPTIONS}
                value={sev}
                onValueChange={setSev}
                size="sm"
                aria-label="Severity"
              />
            </div>
            <div className="nt-filter-field nt-filter-field--md">
              <Select
                options={planeOptions}
                value={plane}
                onValueChange={setPlane}
                size="sm"
                aria-label="Plane"
              />
            </div>
            <div className="nt-filter-field nt-filter-field--sm">
              <Select
                options={FIX_OPTIONS}
                value={fix}
                onValueChange={setFix}
                size="sm"
                aria-label="Fix class"
              />
            </div>
            <div className="nt-filter-field nt-min-w-160">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search findings"
                size="sm"
                aria-label="Search findings"
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void (async () => {
                  try {
                    const next = new URLSearchParams();
                    if (baseline !== 'all') next.set('baseline', baseline);
                    if (sev !== 'all') next.set('sev', sev);
                    if (plane !== 'all') next.set('plane', plane);
                    if (fix !== 'all') next.set('fix', fix);
                    const qTrim = q.trim();
                    if (qTrim) next.set('q', qTrim);
                    const qs = next.toString();
                    const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                    await navigator.clipboard.writeText(url);
                    toast('Filter link copied', {
                      description: qs || 'unfiltered findings',
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy link', { tone: 'danger' });
                  }
                })();
              }}
            >
              Copy filter link
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={rows.length === 0}
              onClick={() => {
                const n = exportTableCsv(
                  'compliance-findings',
                  ['sev', 'title', 'detail', 'rule', 'plane', 'count', 'fix', 'device', 'baseline'],
                  rows.map((f) => [
                    f.sev,
                    f.title,
                    f.detail,
                    f.rule,
                    f.plane,
                    f.count,
                    f.fix,
                    f.device,
                    f.baseline,
                  ]),
                );
                toast(
                  n === 0 ? 'No findings to export' : `Exported ${countOf(n, 'finding')} (current filters)`,
                  { tone: n === 0 ? 'warning' : 'success' },
                );
              }}
            >
              Export CSV
            </Button>
            {data.dataSource === 'live' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    /* Same baseline/sev/plane/fix/q slice as the filter row — server
                     * export must not dump the full estate while the operator
                     * is looking at one severity or search hit. */
                    const exportQs = new URLSearchParams();
                    if (baseline !== 'all') exportQs.set('baseline', baseline);
                    if (sev !== 'all') exportQs.set('sev', sev);
                    if (plane !== 'all') exportQs.set('plane', plane);
                    if (fix !== 'all') exportQs.set('fix', fix);
                    const qTrim = q.trim();
                    if (qTrim) exportQs.set('q', qTrim);
                    const exportPath = exportQs.toString()
                      ? `/api/compliance/export?${exportQs.toString()}`
                      : '/api/compliance/export';
                    const res = await downloadApiCsv(exportPath, 'compliance-findings.csv');
                    if (res.ok) {
                      toast('Server CSV downloaded', {
                        description: 'compliance-findings.csv — filtered findings (no full diff).',
                        tone: 'success',
                      });
                    } else {
                      toast('Server CSV failed', {
                        description: res.error ?? 'Could not download export',
                        tone: 'warning',
                      });
                    }
                  })();
                }}
              >
                Download server CSV
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => setShowDrift((v) => !v)} disabled={!data.diff}>
              {data.evidenceMode === 'coverage' ? 'Evidence text' : 'Diff selected'}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void runScan()} disabled={scanning}>
              {scanning ? <Spinner size="sm" /> : 'Run scan now'}
            </Button>
            {/* Findings multi-select is a keyboard grid (j/k/x/Esc) — surface the map (Loop 199). */}
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </>
        }
      />
      <div className="nt-plane-theater" role="note">NightDesk · baseline theater · drift owns hue</div>

      <VisualReferencePanel target={{ kind: 'service', id: 'compliance' }} editable={false} />
      <ConfigRecommendationsPanel title="Compliance recommendations" limit={6} />

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

      {sevChips.length > 0 ? (
        <div className="nt-severity-chips nt-chip-row" role="group" aria-label="Finding severity">
          <span className="nt-chip-row__label">Severity</span>
          {sevChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setSev(sev === c.key ? 'all' : c.key)}
              className={sev === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={sev === c.key}
              data-sev={c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {planeChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Finding plane">
          <span className="nt-chip-row__label">Plane</span>
          {planeChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setPlane(plane === c.key ? 'all' : c.key)}
              className={plane === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={plane === c.key}
              data-plane={c.key}
            >
              <Badge plane>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {fixChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Finding fix class">
          <span className="nt-chip-row__label">Fix</span>
          {fixChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFix(fix === c.key ? 'all' : c.key)}
              className={fix === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={fix === c.key}
              data-fix={c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {baselineChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Finding baseline">
          <span className="nt-chip-row__label">Baseline</span>
          {baselineChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setBaseline(baseline === c.key ? 'all' : c.key)}
              className={
                baseline === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={baseline === c.key}
              data-baseline={c.key}
            >
              <Badge tone="info">{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {rulesFilter !== null ? (
        <div className="nt-chip-row" role="group" aria-label="Selection deep link">
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('rules');
              setSearchParams(next, { replace: true });
            }}
            title={rulesFilter.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {rulesPresent === rulesFilter.length
              ? `${rulesFilter.length} selected rule${rulesFilter.length === 1 ? '' : 's'}`
              : `${rulesPresent} of ${rulesFilter.length} selected rules present`}
            {' — clear'}
          </button>
        </div>
      ) : null}

      <div
        className="nt-compliance-grid"
      >
        {/* ---------------- findings ---------------- */}
        <div className="nt-stack-10-min">
          <SectionHeader
            label="Findings"
            meta={
              <span className="nt-row-center nt-gap-10 nt-inline-flex">
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
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            rowTone={(f) => f.tone}
          />
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Compliance finding selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy rule ids or finding titles, or share a selection link for only the findings you marked — full list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((f) => selected.has(findingIds.get(f) ?? f.title));
                    if (picked.length === 0) {
                      toast('No selected findings still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'compliance-findings-selected.csv',
                      ['sev', 'title', 'detail', 'rule', 'plane', 'count', 'fix', 'device', 'baseline'],
                      picked.map((f) => [
                        f.sev,
                        f.title,
                        f.detail,
                        f.rule,
                        f.plane,
                        f.count,
                        f.fix,
                        f.device,
                        f.baseline,
                      ]),
                    );
                    toast(`Exported ${countOf(n, 'selected finding')}`, {
                      description: 'compliance-findings-selected.csv — finding fields only.',
                      tone: 'success',
                    });
                  }}
                >
                  Export selected
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((f) => selected.has(findingIds.get(f) ?? f.title));
                      if (picked.length === 0) {
                        toast('No selected findings still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const rules = [
                        ...new Set(
                          picked
                            .map((f) => (f.rule ?? '').trim())
                            .filter((rule) => rule && rule !== '—'),
                        ),
                      ];
                      if (rules.length === 0) {
                        toast('No rules on the selected findings', {
                          description: 'Those rows did not publish a rule id — use Copy names or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = rules.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(rules.length, 'rule')}`, {
                          description:
                            rules.length < picked.length
                              ? `${picked.length - rules.length} selected without a rule skipped`
                              : 'newline-joined · paste into a ticket or playbook',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy rules', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy rules
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((f) => selected.has(findingIds.get(f) ?? f.title));
                      if (picked.length === 0) {
                        toast('No selected findings still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const names = [
                        ...new Set(
                          picked
                            .map((f) => (f.title ?? '').trim())
                            .filter((name) => name && name !== '—'),
                        ),
                      ];
                      if (names.length === 0) {
                        toast('No names on the selected findings', {
                          description: 'Those rows did not publish a title — export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = names.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(names.length, 'name')}`, {
                          description:
                            names.length < picked.length
                              ? `${picked.length - names.length} selected without a title skipped`
                              : 'newline-joined · paste into a ticket or change window',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy names', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy names
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((f) => selected.has(findingIds.get(f) ?? f.title));
                      if (picked.length === 0) {
                        toast('No selected findings still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const rules = [
                        ...new Set(
                          picked
                            .map((f) => (f.rule ?? '').trim())
                            .filter((rule) => rule && rule !== '—'),
                        ),
                      ];
                      if (rules.length === 0) {
                        toast('No rules on the selected findings', {
                          description: 'Those rows did not publish a rule id — use Copy names or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('rules', rules.join('\n'));
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${rules.length} rule${rules.length === 1 ? '' : 's'} · rules=`,
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy link', { description: url, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy selection link
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                  Clear
                </Button>
              </span>
            </div>
          ) : null}
          {rows.length === 0 ? (
            <EmptyState
              title={
                findings.length === 0
                  ? 'No findings to report'
                  : rulesFilter !== null
                    ? 'No findings match this selection'
                    : 'Nothing matches these filters'
              }
              description={
                findings.length > 0 && rulesFilter !== null
                  ? 'Clear the selection filter to restore findings under the current baseline / severity / plane / fix / search filters.'
                  : findings.length > 0
                    ? 'Widen baseline, severity, plane, fix class, or search to see more of the open findings.'
                    : data.evidenceMode === 'unavailable'
                      ? 'No linked plane returned device inventory, so no evidence check could run.'
                      : 'Every check in this snapshot passed.'
              }
            >
              {findings.length > 0 && rulesFilter !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('rules');
                    setSearchParams(next, { replace: true });
                    setSelectedKeys([]);
                  }}
                >
                  Clear selection filter
                </Button>
              ) : findings.length > 0 && filtersActive ? (
                <Button variant="secondary" size="sm" onClick={clearComplianceFilters}>
                  Clear filters
                </Button>
              ) : null}
            </EmptyState>
          ) : null}
        </div>

        {/* ---------------- right column ---------------- */}
        <div className="nt-stack-26-min">
          <div className="nt-stack-col nt-gap-14">
            <SectionHeader label="Pass rate by baseline" />
            <div className="nt-baseline-bars">
            {data.baselines.map((b) => (
              <div key={b.label} className="nt-baseline-bar nt-stack-col nt-gap-4" style={{ ['--nd-health' as string]: `${b.value}%` }}>
                <div className="nt-baseline-bar__head">
                  <span>{b.label}</span>
                  <span className="nt-mono-11">{b.value}%</span>
                </div>
                <div className="nt-baseline-bar__track" aria-hidden>
                  <div className="nt-baseline-bar__fill" />
                </div>
                <Progress value={b.value} label={b.label} note={`${b.value}%`} />
                <span
                  className="nt-hint-muted"
                >
                  {b.note}
                </span>
              </div>
            ))}
            </div>
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
            <div className="nt-stack-col nt-gap-10">
              <SectionHeader
                label="Config drift — running-config snapshots"
                meta={`${backups.summary.backedUp} backed up · ${backups.summary.drift} drifting`}
              />
              <div className="nt-filter-bar nt-gap-8">
                <Button
                  variant="ghost"
                  size="sm"
                  className="nt-ml-auto"
                  onClick={() => {
                    void (async () => {
                      // Match the visible drifted list (drift=1); full roster via API omit.
                      const res = await downloadApiCsv(
                        '/api/config-backups/export?drift=1',
                        'config-backups.csv',
                      );
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'config-backups.csv — drifted devices only (no config bodies).',
                          tone: 'success',
                        });
                      } else {
                        toast('Server CSV failed', {
                          description: res.error ?? 'Could not download export',
                          tone: 'warning',
                        });
                      }
                    })();
                  }}
                >
                  Download server CSV
                </Button>
              </div>
              {backups.dataSource === 'demo' ? (
                <span
                  className="nt-hint-muted"
                >
                  {backups.note ?? 'Synthesized demo snapshots — no device was contacted.'}
                </span>
              ) : null}
              {drifted.length === 0 ? (
                <span
                  className="nt-hint-muted"
                >
                  {backups.summary.backedUp === 0
                    ? 'No config snapshots collected yet — the first sweep has not landed.'
                    : `No drift across ${backups.summary.backedUp} devices with snapshots.`}
                </span>
              ) : (
                drifted.map((row) => (
                  <div
                    key={row.device}
                    className="nt-drift-card nt-row-between-8"
                  >
                    <div className="nt-stack-col nt-gap-2">
                      <span className="nt-drift-card__title nt-mono-11 nt-fs-12-primary">
                        {row.device}
                      </span>
                      <span
                        className="nt-drift-card__meta nt-hint-muted"
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
            <div className="nt-stack-col nt-gap-10">
              <SectionHeader label={data.evidenceMode === 'coverage' ? 'Evidence coverage, as text' : 'Drift, as text'} />
              <DiffCode text={data.diff} />
              {!sectionLive ? (
                <div className="nt-row nt-gap-8">
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
          <div className="nt-center-pad nt-pad-48" role="status" aria-label="Loading drift">
            <div className="nt-stack nt-gap-8">
              <Skeleton height={14} width="40%" />
              <Skeleton height={36} />
              <Skeleton height={36} />
              <Skeleton height={36} />
            </div>
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
