/**
 * web/src/screens/Systems.tsx — connected systems (the live one).
 * High-fidelity port of design/NtSystems.dc.html, with the descriptors from
 * getSystems() MERGED with live per-plane registry state from
 * getSystemsState() (GET /api/systems/state) — but only when the systems
 * section is actually live-sourced (dataSource 'live', or blended): a demo
 * payload is authored data and renders as authored, never stamped with the
 * empty registry ("unlinked / never / 0" beside a fixture device count).
 * On a live section the state Badge shows the registry health
 * (healthy/degraded/warning/unlinked) plus an `unverified` marker when the
 * registry's own age-based `stale` flag is set, the fact strip overrides Last
 * sync / the plane's count fact / Calls today (against the plane's served
 * callBudget) with live values, the throttling Alert is derived from the
 * plane's own 429s, the drawer's Activity tab lists the real recent-call log
 * and names the consecutive-failure/retry state, and Sync history comes from
 * the poller.
 * Backend unreachable → fixture-only plus a small mono "backend offline —
 * fixture state" note. The header carries the envelope's own provenance stamp
 * (DEMO FIXTURE vs LIVE · SYNCED hh:mm) and the Planes meta counts what is
 * actually on screen, never a literal. A drawer site row that names a real
 * site drills into it (closing the drawer first).
 * The connect drawer renders the endpoint variant plus the per-plane
 * credential fields the chosen adapter needs (shared CONNECT_FIELDS) and
 * saves every value under the settings key that adapter's isComplete()
 * reads (CONNECT_ENDPOINT_KEY) — a record under any other key links a plane
 * to a stub that never syncs.
 * Mutations are real: Test connection POSTs the entered credentials to
 * /api/systems/:plane/test and surfaces the server's message verbatim (a 502
 * {ok:false,message} is a normal result); Save and index is gated on a
 * successful test and POSTs /api/systems/:plane/credentials; Retire plane
 * DELETEs /api/systems/:plane after a window.confirm. "Open console" opens
 * the row's own SystemRow.consoleUrl in a new tab and is DISABLED for a plane
 * that records none (the local switch collector has no console) — an inert
 * control, never a toast claiming a hand-off the portal cannot make.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Divider,
  Drawer,
  FormField,
  Input,
  SectionHeader,
  SegmentedControl,
  Select,
  Spinner,
  Switch,
  useToast,
} from '../nightdesk';
import {
  getChatSettings,
  getChatStatus,
  getPortalSettings,
  getSystems,
  getSystemsState,
  retireSystem,
  saveChatSettings,
  savePortalSettings,
  saveSystemCredentials,
  syncSystems,
  testSystem,
} from '../api/client';
import type {
  ChatStatus,
  LivePlaneState,
  LiveSyncEvent,
  PortalSettings,
  SystemsData,
  SystemsState,
} from '../api/client';
import {
  CONNECT_ENDPOINTS,
  CONNECT_ENDPOINT_KEY,
  CONNECT_FIELDS,
  CONNECT_TYPE_OPTIONS,
  SCREEN_SECTIONS,
  type ScreenSection,
} from '../../../shared';
import type { Fact, SyncHistoryRow, SystemRow, SystemTypeKey, Tone } from '../../../shared';
import { useSettings } from '../app/SettingsContext';
import type { Density } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import '../app/app.css';

/** Fixture system name → registry plane id (the seven connectable planes). */
const PLANE_ID_BY_NAME: Record<string, SystemTypeKey> = {
  'HPE Aruba Central': 'central',
  Mist: 'mist',
  'Central Classic': 'classic',
  GreenLake: 'greenlake',
  'AOS-8 mobility master': 'aos8',
  'Local switch collector': 'local',
  ClearPass: 'clearpass',
  UXI: 'uxi',
};

const HEALTH_TONE: Record<LivePlaneState['health'], Tone> = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  unlinked: 'neutral',
};

/**
 * Current Central API-gateway clusters — devhub.arubanetworks.com/new-central
 * ("Getting Started with REST APIs" base-URL table, incl. the internal
 * cluster). The account's own base URL shows under Central → API Gateway →
 * REST API; a gateway not in the list can be typed directly.
 */
const CENTRAL_REGIONS: Array<{ value: string; label: string }> = [
  { value: 'https://us1.api.central.arubanetworks.com', label: 'US-1' },
  { value: 'https://us2.api.central.arubanetworks.com', label: 'US-2' },
  { value: 'https://us6.api.central.arubanetworks.com', label: 'US-East1' },
  { value: 'https://us4.api.central.arubanetworks.com', label: 'US-West4' },
  { value: 'https://us5.api.central.arubanetworks.com', label: 'US-West5' },
  { value: 'https://de1.api.central.arubanetworks.com', label: 'EU-1' },
  { value: 'https://de2.api.central.arubanetworks.com', label: 'EU-Central2' },
  { value: 'https://de3.api.central.arubanetworks.com', label: 'EU-Central3' },
  { value: 'https://gb1.api.central.arubanetworks.com', label: 'UK' },
  { value: 'https://ca1.api.central.arubanetworks.com', label: 'Canada-1' },
  { value: 'https://in1.api.central.arubanetworks.com', label: 'APAC-1' },
  { value: 'https://jp1.api.central.arubanetworks.com', label: 'APAC-East1' },
  { value: 'https://au1.api.central.arubanetworks.com', label: 'APAC-South1' },
  { value: 'https://ae1.api.central.arubanetworks.com', label: 'UAE' },
  { value: 'https://cn1.api.central.arubanetworks.com.cn', label: 'China-1' },
  { value: 'https://internal.api.central.arubanetworks.com', label: 'Internal' },
];

type DetailTab = 'summary' | 'activity' | 'config';

const TAB_OPTIONS: Array<{ value: DetailTab; label: string }> = [
  { value: 'summary', label: 'Summary' },
  { value: 'activity', label: 'Activity' },
  { value: 'config', label: 'Configuration' },
];

interface ScopeFlags {
  inventory: boolean;
  clientsAuth: boolean;
  configLicences: boolean;
  write: boolean;
}

const DEFAULT_SCOPES: ScopeFlags = {
  inventory: true,
  clientsAuth: true,
  configLicences: true,
  write: false,
};

// -- formatting helpers -------------------------------------------------------

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function msFmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Status-Badge tone for a live call code: 2xx/ok success, 429 warning, 5xx/fail danger. */
function codeTone(code: string): Tone {
  if (code === 'ok' || /^2\d\d$/.test(code)) return 'success';
  if (code === '429') return 'warning';
  if (code === 'fail' || /^5\d\d$/.test(code)) return 'danger';
  return 'neutral';
}

// -- fixture ⇄ live merge ------------------------------------------------------

/** Fact keys that carry a plane's indexed-object count — GreenLake counts
 *  subscriptions and ClearPass endpoints, so keying the live override off
 *  'Devices' alone would never reach them. */
const COUNT_FACT_KEYS = ['Devices', 'Subscriptions', 'Endpoints'];

/**
 * "Calls today" against the plane's own daily budget — the denominator the
 * registry serves (LivePlaneState.callBudget) and the only thing that makes
 * the count mean anything (Mist allows 20k/day). A plane whose tier the
 * portal does not know renders the bare count rather than inventing a limit,
 * exactly as the server formats the same fact (screens.ts liveSystemRow).
 */
function callsFactValue(live: LivePlaneState): string {
  const budget = live.callBudget;
  if (budget === undefined || budget === null) return String(live.callsToday);
  return `${live.callsToday.toLocaleString('en-US')} / ${budget.toLocaleString('en-US')}`;
}

/**
 * README honesty rule: a plane whose last good sync has aged past the
 * registry's staleness window is behind, so what it reports is `unverified`
 * rather than current — the same word Alerts and Clients use for a row
 * sourced from such a plane. The flag is the registry's own age-based
 * `stale` (shared/logic.ts planeStaleness), never re-derived here.
 */
function staleTitle(live: LivePlaneState): string {
  const age = live.ageSec == null ? 'never' : relTime(live.lastSync);
  return `last good sync ${age} — past the registry's staleness window, so this plane's rows are unverified, not current`;
}

/** Retry state for a plane the poller keeps failing on — served facts, not a
 *  guess: how many consecutive polls failed and when the next one is due. */
function retryNote(live: LivePlaneState): string | null {
  const fails = live.consecutiveFailures ?? 0;
  if (fails <= 0) return null;
  const next = live.nextAttemptAt ? ` · next attempt ${hhmm(live.nextAttemptAt)}` : '';
  return `${fails} consecutive failed poll${fails === 1 ? '' : 's'}${next}`;
}

/** Fact strip: live values override the matching facts when present. Only
 *  called for a live-sourced row — a demo row keeps its authored facts. */
function mergedFacts(s: SystemRow, live: LivePlaneState | null): Fact[] {
  if (!live) return s.facts;
  let counted = false;
  const facts = s.facts.map((f) => {
    if (f.k === 'Last sync') return { ...f, v: relTime(live.lastSync) };
    if (f.k === 'Calls today') return { ...f, v: callsFactValue(live) };
    if (COUNT_FACT_KEYS.includes(f.k) && live.deviceCount != null) {
      counted = true;
      return { ...f, v: String(live.deviceCount) };
    }
    return f;
  });
  // A plane whose row has no count fact at all still gets one appended.
  if (!counted && live.deviceCount != null) facts.push({ k: 'Devices', v: String(live.deviceCount) });
  return facts;
}

/**
 * The throttling banner (README §13) derived from the registry rather than
 * authored: a linked plane whose recent-call ring buffer holds 429s really is
 * being rate-limited, so name it and quote its own count. Everything else —
 * including an unlinked Classic that the portal has never called — gets no
 * banner at all.
 */
interface ThrottleBanner {
  title: string;
  body: string;
}

function throttleBanner(views: Array<{ row: SystemRow; live: LivePlaneState | null }>): ThrottleBanner | null {
  for (const v of views) {
    if (!v.live?.linked) continue;
    const total = v.live.recentCalls.length;
    const rate = v.live.recentCalls.filter((c) => c.code === '429').length;
    if (rate === 0) continue;
    return {
      title: `${v.row.name} is throttling us`,
      body: `${rate} of the last ${total} calls to this plane came back 429, so inventory from it falls behind.${v.live.note ? ` Registry note: ${v.live.note}.` : ''}`,
    };
  }
  return null;
}

interface CallRow {
  time: string;
  path: string;
  ms: string;
  code: string;
  tone: Tone;
}

/** Activity-tab calls: the live registry log when the backend is up, else fixture. */
function callsFor(s: SystemRow, live: LivePlaneState | null): CallRow[] {
  if (live) {
    return live.recentCalls.map((c) => ({
      time: hhmm(c.time),
      path: c.path,
      ms: msFmt(c.ms),
      code: c.code,
      tone: codeTone(c.code),
    }));
  }
  return s.calls;
}

interface HistoryRow {
  time: string;
  system: string;
  what: string;
  result: string;
  tone: Tone;
}

/** A drawer section that clears to zero rows says so — README §Interactions:
 *  zero results show an empty state, never a heading over nothing. */
function NothingReported({ label }: { label: string }) {
  return (
    <div
      style={{
        fontFamily: 'var(--nd-font-mono)',
        fontSize: 10.5,
        color: 'var(--nd-text-muted)',
        padding: '8px 0',
      }}
    >
      {label}
    </div>
  );
}

/** Sync history: the live poller log when present, else the fixture rows. */
function historyRows(live: LiveSyncEvent[] | null, fixture: SyncHistoryRow[]): HistoryRow[] {
  if (live) {
    return live.slice(0, 10).map((h) => ({
      time: hhmm(h.time),
      system: h.plane,
      what: h.what,
      result: h.result,
      tone: h.result === 'ok' ? 'success' : 'danger',
    }));
  }
  return fixture;
}

// -- portal (this app) section -------------------------------------------------

const POLL_OPTIONS = [
  { value: '30', label: 'every 30 seconds' },
  { value: '60', label: 'every 60 seconds' },
  { value: '120', label: 'every 2 minutes' },
  { value: '300', label: 'every 5 minutes' },
];

const DENSITY_OPTIONS = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

/** Per-screen source override: Portal = follow the portal-wide demoMode. */
const SOURCE_OPTIONS = [
  { value: 'auto', label: 'Portal' },
  { value: 'demo', label: 'Demo' },
  { value: 'live', label: 'Live' },
];

const SECTION_LABEL: Record<ScreenSection, string> = {
  overview: 'Overview',
  alerts: 'Alerts',
  clients: 'Clients',
  authEvents: 'Auth events',
  sites: 'Sites',
  devices: 'Devices',
  licenses: 'Licenses',
  configure: 'Configure',
  compliance: 'Compliance',
  systems: 'Systems',
};

/**
 * The portal's own controls: demo mode and poll cadence live in the server
 * settings store (PUT /api/settings; the cadence applies without a restart),
 * while workspace identity, table density and platform tags are the shell
 * preferences from SettingsContext (same endpoint, plus a localStorage copy
 * so they survive a backend outage). Demo mode flips every screen between the
 * authored fixtures and values computed from the poller cache.
 */
function PortalSection() {
  const { toast } = useToast();
  const {
    density,
    setDensity,
    showPlatformTags,
    setShowPlatformTags,
    workspaceName,
    setWorkspaceName,
    setPollIntervalSec,
  } = useSettings();
  const [portal, setPortal] = useState<PortalSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(workspaceName);

  useEffect(() => {
    let live = true;
    void getPortalSettings()
      .then((p) => {
        if (live) setPortal(p);
      })
      .catch((err: Error) => {
        if (live) setLoadError(`Portal settings could not be loaded: ${err.message}`);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const offline = loaded && portal === null;

  const toggleDemo = async (next: boolean) => {
    const prev = portal?.demoMode ?? true;
    setPortal((p) => (p ? { ...p, demoMode: next } : p));
    const res = await savePortalSettings({ demoMode: next });
    if (!res.ok) {
      setPortal((p) => (p ? { ...p, demoMode: prev } : p));
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(next ? 'Demo mode on' : 'Live mode on', {
      description: next
        ? 'screens read the authored fixture set — no plane credentials needed.'
        : 'screens compute from the poller cache; unlinked planes answer empty.',
      tone: next ? 'warning' : 'success',
    });
  };

  /**
   * Lab config mode. This estate is a lab used to show what the portal can do,
   * so a write does not need the brokered-change ceremony — with this on, the
   * broker stops demanding a raised ticket reference.
   */
  const toggleConfigMode = async (next: boolean) => {
    const prev = portal?.configMode ?? false;
    setPortal((p) => (p ? { ...p, configMode: next } : p));
    const res = await savePortalSettings({ configMode: next });
    if (!res.ok) {
      setPortal((p) => (p ? { ...p, configMode: prev } : p));
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(next ? 'Config mode on' : 'Config mode off', {
      description: next
        ? 'writes push without a ticket reference.'
        : 'writes reference a raised ticket again.',
      tone: 'success',
    });
  };

  const toggleBlend = async (next: boolean) => {
    const prev = portal?.blendLive ?? false;
    setPortal((p) => (p ? { ...p, blendLive: next } : p));
    const res = await savePortalSettings({ blendLive: next });
    if (!res.ok) {
      setPortal((p) => (p ? { ...p, blendLive: prev } : p));
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(next ? 'Live blend on' : 'Live blend off', {
      description: next
        ? 'demo screens swap a section to real rows as soon as a linked plane reports them.'
        : 'demo screens read fixtures only.',
      tone: next ? 'success' : 'info',
    });
  };

  const setSectionSource = async (section: ScreenSection, v: string) => {
    const prev = portal?.sectionMode ?? {};
    const nextMode = { ...prev };
    if (v === 'auto') delete nextMode[section];
    else nextMode[section] = v as 'demo' | 'live';
    setPortal((p) => (p ? { ...p, sectionMode: nextMode } : p));
    const res = await savePortalSettings({ sectionMode: nextMode });
    if (!res.ok) {
      setPortal((p) => (p ? { ...p, sectionMode: prev } : p));
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(
      v === 'auto'
        ? `${SECTION_LABEL[section]} follows the portal default`
        : `${SECTION_LABEL[section]} pinned to ${v}`,
      {
        description:
          v === 'live'
            ? 'that screen computes from the poller cache — empty until a linked plane reports.'
            : undefined,
        tone: v === 'live' ? 'success' : 'info',
      },
    );
  };

  const changeInterval = async (v: string) => {
    const secs = Number(v);
    const prev = portal?.pollIntervalSec ?? 60;
    if (secs === prev) return;
    setPortal((p) => (p ? { ...p, pollIntervalSec: secs } : p));
    const res = await savePortalSettings({ pollIntervalSec: secs });
    if (!res.ok) {
      setPortal((p) => (p ? { ...p, pollIntervalSec: prev } : p));
      toast(res.message, { tone: 'danger' });
      return;
    }
    setPollIntervalSec(secs);
    toast(`Poller cadence ${secs}s`, {
      description: 'applies immediately — no restart needed.',
      tone: 'success',
    });
  };

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== workspaceName) {
      setWorkspaceName(trimmed);
      toast('Workspace renamed', { tone: 'success' });
    } else {
      setName(workspaceName);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader label="Portal" meta="THIS APP · POLLER" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {portal ? (
          <>
            <Badge tone={portal.demoMode ? 'warning' : 'success'} dot>
              {portal.demoMode ? (portal.blendLive ? 'demo + live blend' : 'demo data') : 'live data'}
            </Badge>
            <Badge tone="neutral">{`poll every ${portal.pollIntervalSec}s`}</Badge>
          </>
        ) : (
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 10.5,
              color: 'var(--nd-text-muted)',
            }}
          >
            {loadError ?? (offline ? 'backend offline — portal settings unavailable' : 'reading portal settings…')}
          </span>
        )}
      </div>

      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
      >
        <FormField label="Workspace name" help="Shown in the sidebar, footer and breadcrumbs.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </FormField>
        <FormField
          label="Poll interval"
          help="How often each linked plane is re-polled for live mode."
        >
          <Select
            options={POLL_OPTIONS}
            value={String(portal?.pollIntervalSec ?? 60)}
            onValueChange={(v) => void changeInterval(v)}
            disabled={offline}
            aria-label="Poll interval"
          />
        </FormField>
        <FormField label="Table density" help="Row height across every inventory table.">
          <SegmentedControl
            options={DENSITY_OPTIONS}
            value={density}
            onValueChange={(v) => setDensity(v as Density)}
          />
        </FormField>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
        <Switch
          checked={portal?.demoMode ?? true}
          onCheckedChange={(v) => void toggleDemo(v)}
          disabled={offline}
          label="Demo mode (fixture data)"
        />
        <Switch
          checked={portal?.blendLive ?? false}
          onCheckedChange={(v) => void toggleBlend(v)}
          disabled={offline || !(portal?.demoMode ?? true)}
          label="Blend live sections into demo"
        />
        <Switch
          checked={portal?.configMode ?? false}
          onCheckedChange={(v) => void toggleConfigMode(v)}
          disabled={offline}
          label="Config mode (writes need no ticket)"
        />
        <Switch
          checked={showPlatformTags}
          onCheckedChange={setShowPlatformTags}
          label="Show platform tags"
        />
      </div>

      <SectionHeader label="Screen sources" meta="OVERRIDE THE PORTAL DEFAULT PER SCREEN" />
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}
      >
        {SCREEN_SECTIONS.map((s) => (
          <FormField key={s} label={SECTION_LABEL[s]}>
            <SegmentedControl
              options={SOURCE_OPTIONS}
              value={portal?.sectionMode?.[s] ?? 'auto'}
              onValueChange={(v) => void setSectionSource(s, v)}
              ariaLabel={`${SECTION_LABEL[s]} data source`}
            />
          </FormField>
        ))}
      </div>
    </div>
  );
}

// -- assistant (chat) section ---------------------------------------------------

/**
 * The assistant's configuration surface: centralmcp endpoint + bearer and the
 * OpenAI-compatible LLM triple, saved through PUT /api/settings (deep-merged;
 * masked '••••••…' secrets written back unchanged are ignored, so prefilled
 * masked values preserve the stored secrets). Status comes from
 * GET /api/chat/status. The write-mode Switch saves chatWriteMode directly.
 */
function AssistantSection() {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [mcpUrl, setMcpUrl] = useState('');
  const [bearer, setBearer] = useState('');
  const [llmBase, setLlmBase] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [writeMode, setWriteMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshStatus = async () => {
    try {
      setStatus(await getChatStatus());
      setLoadError(null);
    } catch (err) {
      setStatus(null);
      setLoadError(`Assistant status could not be loaded: ${(err as Error).message}`);
    }
  };

  useEffect(() => {
    let live = true;
    void Promise.all([getChatStatus(), getChatSettings()])
      .then(([st, cfg]) => {
        if (!live) return;
        setStatus(st);
        if (cfg) {
          setMcpUrl(cfg.mcp?.url ?? '');
          setBearer(cfg.mcp?.bearerToken ?? '');
          setLlmBase(cfg.llm?.baseUrl ?? '');
          setLlmKey(cfg.llm?.apiKey ?? '');
          setLlmModel(cfg.llm?.model ?? '');
          setWriteMode(cfg.chatWriteMode);
        }
      })
      .catch((err: Error) => {
        if (live) setLoadError(`Assistant settings could not be loaded: ${err.message}`);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const offline = loaded && status === null;

  const save = async () => {
    setSaving(true);
    const res = await saveChatSettings({
      mcp: mcpUrl.trim() ? { url: mcpUrl.trim(), bearerToken: bearer.trim() || null } : null,
      llm:
        llmBase.trim() && llmModel.trim()
          ? { baseUrl: llmBase.trim(), apiKey: llmKey, model: llmModel.trim() }
          : null,
      chatWriteMode: writeMode,
    });
    setSaving(false);
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast('Assistant settings saved', { tone: 'success' });
    await refreshStatus();
  };

  const toggleWriteMode = async (next: boolean) => {
    const prev = writeMode;
    setWriteMode(next);
    const res = await saveChatSettings({ chatWriteMode: next });
    if (!res.ok) {
      setWriteMode(prev);
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(next ? 'Write tools enabled' : 'Write tools disabled', {
      description: next
        ? 'invoke_tool is offered to the model — each chat session still opts in separately.'
        : 'the assistant is read-only again.',
      tone: next ? 'warning' : 'success',
    });
    await refreshStatus();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader label="Assistant" meta="CENTRALMCP · LLM" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {status ? (
          <>
            {status.configured.mcp ? (
              <Badge tone={status.mcpReachable ? 'success' : 'warning'} dot>
                {status.mcpReachable ? 'mcp reachable' : 'mcp unreachable'}
              </Badge>
            ) : (
              <Badge tone="neutral" dot>
                mcp not configured
              </Badge>
            )}
            <Badge tone={status.configured.llm ? 'success' : 'neutral'} dot>
              {status.configured.llm ? 'llm configured' : 'llm not configured'}
            </Badge>
            <Badge tone={status.writeMode ? 'warning' : 'neutral'}>
              {status.writeMode ? 'write mode on' : 'read-only'}
            </Badge>
            {status.mcpUrl ? (
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10.5,
                  color: 'var(--nd-text-muted)',
                }}
              >
                {status.mcpUrl}
              </span>
            ) : null}
          </>
        ) : (
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 10.5,
              color: 'var(--nd-text-muted)',
            }}
          >
            {loadError ?? (offline ? 'backend offline — assistant settings unavailable' : 'checking chat status…')}
          </span>
        )}
      </div>

      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
      >
        <FormField label="MCP server URL" help="centralmcp streamable HTTP endpoint.">
          <Input
            mono
            placeholder="http://127.0.0.1:8010/mcp"
            value={mcpUrl}
            disabled={offline}
            onChange={(e) => setMcpUrl(e.target.value)}
          />
        </FormField>
        <FormField label="MCP bearer token" help="Optional. A masked value is kept as stored.">
          <Input
            mono
            type="password"
            placeholder="••••••••••••"
            value={bearer}
            disabled={offline}
            onChange={(e) => setBearer(e.target.value)}
          />
        </FormField>
        <FormField label="LLM base URL" help="OpenAI-compatible; /chat/completions is appended.">
          <Input
            mono
            placeholder="http://127.0.0.1:11434/v1"
            value={llmBase}
            disabled={offline}
            onChange={(e) => setLlmBase(e.target.value)}
          />
        </FormField>
        <FormField label="LLM API key" help="A masked value is kept as stored.">
          <Input
            mono
            type="password"
            placeholder="••••••••••••"
            value={llmKey}
            disabled={offline}
            onChange={(e) => setLlmKey(e.target.value)}
          />
        </FormField>
        <FormField label="LLM model">
          <Input
            mono
            placeholder="qwen2.5:7b"
            value={llmModel}
            disabled={offline}
            onChange={(e) => setLlmModel(e.target.value)}
          />
        </FormField>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Switch
          checked={writeMode}
          onCheckedChange={(v) => void toggleWriteMode(v)}
          disabled={offline}
          label="Allow write tools (invoke_tool)"
        />
        <Button
          variant="primary"
          size="sm"
          disabled={saving || offline}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save assistant settings'}
        </Button>
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10,
            color: 'var(--nd-text-muted)',
          }}
        >
          saved server-side · secrets never leave the portal unmasked
        </span>
      </div>
    </div>
  );
}

export default function Systems() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [data, setData] = useState<SystemsData | null>(null);
  const [liveState, setLiveState] = useState<SystemsState | null>(null);

  const [detailName, setDetailName] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('summary');

  const [addOpen, setAddOpen] = useState(false);
  const [newType, setNewType] = useState<SystemTypeKey>('central');
  const [displayName, setDisplayName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  // The per-plane credential fields CONNECT_FIELDS declares, keyed by the
  // settings key the adapter's isComplete() actually reads.
  const [extraCreds, setExtraCreds] = useState<Record<string, string>>({});
  const [scopes, setScopes] = useState<ScopeFlags>(DEFAULT_SCOPES);
  const [testing, setTesting] = useState(false);
  const [testedOk, setTestedOk] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Set when a field change invalidates a PASSED test — surfaced as a warning
  // so a green-then-edited drawer never looks saved when it cannot be.
  const [retestNeeded, setRetestNeeded] = useState(false);

  const refresh = async () => {
    const [d, s] = await Promise.all([getSystems(), getSystemsState()]);
    setData(d);
    setLiveState(s);
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      const [d, s] = await Promise.all([getSystems(), getSystemsState()]);
      if (live) {
        setData(d);
        setLiveState(s);
      }
    })();
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
  if (liveState?.apiError) return <ApiErrorState message={liveState.apiError} />;

  // -- merged per-plane view ---------------------------------------------------
  // The server decides demo-vs-live per section: a demo payload is the
  // authored SYSTEMS rows and must render as authored. Overlaying the registry
  // on them stamps every row 'unlinked / never / 0' next to a fixture device
  // count on a stock demo install, which reads as a broken screen.
  const systemsLive = data.dataSource === 'live' || (data.blended?.includes('systems') ?? false);
  const views = data.systems.map((row) => {
    // Live rows carry the registry planeId — trust it over the name reverse-
    // lookup, which breaks the moment an operator renames a plane.
    const planeId = (row.planeId as SystemTypeKey | undefined) ?? PLANE_ID_BY_NAME[row.name] ?? null;
    const live = (systemsLive && planeId && liveState?.planes[planeId]) || null;
    return {
      row,
      planeId,
      live,
      stateLabel: live ? live.health : row.state,
      stateTone: live ? HEALTH_TONE[live.health] : row.tone,
      facts: mergedFacts(row, live),
    };
  });
  const linkedCount = views.filter((v) => v.live?.linked).length;
  const throttle = systemsLive ? throttleBanner(views) : null;

  const cur = data.systems.find((s) => s.name === detailName) ?? null;
  const curView = views.find((v) => v.row.name === detailName) ?? null;
  const curCalls = cur && curView ? callsFor(cur, curView.live) : [];
  // Same rule as the rows: the poller log belongs to a live section, the
  // authored log to a demo one — never the two spliced together.
  const history = historyRows(systemsLive ? (liveState?.history ?? null) : null, data.syncHistory);

  // -- header / drawer actions --------------------------------------------------
  const syncAll = async () => {
    if (syncing) return;
    setSyncing(true);
    const result = await syncSystems();
    if (!result.ok) {
      toast(result.message, { tone: 'danger' });
      setSyncing(false);
      return;
    }
    await refresh();
    setSyncing(false);
    toast('sync complete', { description: result.message, tone: 'success' });
  };

  const openConnect = (prefill?: { type: SystemTypeKey; name: string }) => {
    setNewType(prefill?.type ?? 'central');
    setDisplayName(prefill?.name ?? '');
    setEndpoint('');
    setClientId('');
    setClientSecret('');
    setExtraCreds({});
    setScopes(DEFAULT_SCOPES);
    setTesting(false);
    setTestedOk(false);
    setTestResult(null);
    setRetestNeeded(false);
    setDetailName(null);
    setAddOpen(true);
  };

  /**
   * Hand off to the plane's own console. The button is disabled without a
   * URL, so this is only reachable with one — but a browser that refuses the
   * popup returns null, and that is a hand-off that did NOT happen: say so
   * and show the URL rather than let the click look successful.
   */
  const openConsole = (row: SystemRow) => {
    if (!row.consoleUrl) return;
    const opened = window.open(row.consoleUrl, '_blank', 'noopener');
    if (!opened) {
      toast(`Could not open the ${row.name} console`, {
        description: `The browser blocked the new tab — open ${row.consoleUrl} directly.`,
        tone: 'warning',
      });
    }
  };

  const retire = async () => {
    if (!cur || !curView?.planeId) {
      toast('cannot retire — this plane is not in the registry', { tone: 'danger' });
      return;
    }
    const ok = window.confirm(
      `Retire ${cur.name}? Stored credentials are cleared and the plane becomes unlinked.`,
    );
    if (!ok) return;
    const res = await retireSystem(curView.planeId);
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(`${cur.name} retired`, { description: res.message, tone: 'success' });
    setDetailName(null);
    await refresh();
  };

  // -- connect form ---------------------------------------------------------------
  const invalidate = () => {
    if (testedOk) setRetestNeeded(true);
    setTestedOk(false);
    setTestResult(null);
  };

  const selectedScopes = (): string[] => {
    const out: string[] = [];
    if (scopes.inventory) out.push('read:inventory');
    if (scopes.clientsAuth) out.push('read:clients-auth');
    if (scopes.configLicences) out.push('read:config-licences');
    if (scopes.write) out.push('write:brokered');
    return out;
  };

  /* Saved under the exact keys each adapter's isComplete() reads (shared
   * CONNECT_ENDPOINT_KEY / CONNECT_FIELDS) — a record written under any other
   * key links the plane to a stub that never syncs. */
  const credPayload = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (displayName.trim()) out.displayName = displayName.trim();
    if (endpoint.trim()) out[CONNECT_ENDPOINT_KEY[newType]] = endpoint.trim();
    if (clientId.trim()) out.clientId = clientId.trim();
    if (clientSecret.trim()) out.clientSecret = clientSecret.trim();
    CONNECT_FIELDS[newType].forEach((f) => {
      const v = (extraCreds[f.key] ?? '').trim();
      if (v) out[f.key] = v;
    });
    const sc = selectedScopes();
    if (sc.length > 0) out.scopes = sc.join(',');
    return out;
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setTestedOk(false);
    setRetestNeeded(false);
    const res = await testSystem(newType, credPayload());
    setTesting(false);
    setTestResult(res);
    setTestedOk(res.ok);
  };

  const saveAndIndex = async () => {
    if (!testedOk) return;
    const res = await saveSystemCredentials(newType, credPayload());
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast('Saved and indexing', { description: res.message, tone: 'success' });
    setAddOpen(false);
    await refresh();
  };

  const endpointVariant = CONNECT_ENDPOINTS[newType];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Govern / Connected systems"
        title="Connected systems"
        subtitle="Every plane the portal speaks to, what it is allowed to do there, and when it last succeeded."
        actions={
          <>
            {/* Design rule 1: the screen says which source answered and how
                fresh it is. Same vocabulary as SiteDetail so the portal does
                not invent a third phrasing for one state. */}
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-10)',
                color: 'var(--nd-text-muted)',
                letterSpacing: '.08em',
              }}
            >
              {systemsLive
                ? `LIVE · SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : 'NEVER'}`
                : 'DEMO FIXTURE'}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void syncAll()} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync all'}
            </Button>
            <Button variant="primary" size="sm" onClick={() => openConnect()}>
              Connect a system
            </Button>
          </>
        }
      />

      {/* Authored on the demo section; derived from the registry's own 429s on
          a live one — never an incident on a plane that was never configured. */}
      {!systemsLive ? (
        <Alert tone="danger" title="Central Classic is throttling us" dismissible>
          <span style={{ fontSize: 13 }}>
            Two API clients share one token quota on the Classic tenant, so every third poll returns
            429 and inventory falls behind. Re-key the portal client, or retire the legacy scripts
            still using it.
          </span>
        </Alert>
      ) : throttle ? (
        <Alert tone="danger" title={throttle.title} dismissible>
          <span style={{ fontSize: 13 }}>{throttle.body}</span>
        </Alert>
      ) : null}

      {liveState === null ? (
        <div
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10.5,
            color: 'var(--nd-text-muted)',
          }}
        >
          backend offline — fixture state
        </div>
      ) : null}

      {/* ---------------- plane rows ---------------- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <SectionHeader
          label="Planes"
          meta={
            /* The meta line counts what is on screen. On a live section that
               is the genuinely linked planes; on an authored one it is the
               rows themselves — never a literal that goes stale the moment a
               fixture plane is added (the authored set is eight, not seven). */
            systemsLive && liveState
              ? `${linkedCount} LINKED · SELECT ONE FOR DETAIL`
              : `${data.systems.length} LINKED · SELECT ONE FOR DETAIL`
          }
        />
        {views.map((v) => (
          <button
            key={v.row.name}
            type="button"
            className="nt-rowlink"
            onClick={() => {
              setDetailName(v.row.name);
              setTab('summary');
            }}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 20,
              width: '100%',
              textAlign: 'left',
              background: 'none',
              border: 'none',
              borderBottom: '1px solid var(--nd-border-subtle)',
              borderLeft: '2px solid transparent',
              padding: '15px 10px 15px 12px',
              cursor: 'pointer',
            }}
          >
            <div
              style={{ width: 230, flex: '0 0 230px', display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              <span
                style={{
                  fontFamily: 'var(--nd-font-display)',
                  fontSize: 16,
                  color: 'var(--nd-text-primary)',
                }}
              >
                {v.row.name}
              </span>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  color: 'var(--nd-text-muted)',
                }}
              >
                {v.row.kind}
              </span>
            </div>
            <div
              style={{
                width: 96,
                flex: '0 0 96px',
                paddingTop: 2,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                alignItems: 'flex-start',
              }}
            >
              <Badge tone={v.stateTone} dot>
                {v.stateLabel}
              </Badge>
              {/* The registry's own age-based flag, not a second opinion: a
                  plane that is behind is marked here so its counts opposite
                  are read as last-good, never as current. */}
              {v.live?.stale ? (
                <span title={staleTitle(v.live)}>
                  <Badge tone="warning">unverified</Badge>
                </span>
              ) : null}
            </div>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                gap: 26,
                flexWrap: 'wrap',
                paddingTop: 1,
              }}
            >
              {v.facts.map((f) => (
                <div
                  key={f.k}
                  style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 96 }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 9.5,
                      letterSpacing: '.12em',
                      textTransform: 'uppercase',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {f.k}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 11.5,
                      color: 'var(--nd-text-secondary)',
                    }}
                  >
                    {f.v}
                  </span>
                </div>
              ))}
            </div>
            <div
              style={{
                width: 180,
                flex: '0 0 180px',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                alignItems: 'flex-end',
              }}
            >
              <Badge tone={v.row.scopeTone}>{v.row.scope}</Badge>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10,
                  color: 'var(--nd-text-muted)',
                  textAlign: 'right',
                }}
              >
                {v.row.scopeNote}
              </span>
            </div>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 11,
                color: 'var(--nd-accent-text)',
                paddingTop: 3,
              }}
            >
              Detail ▸
            </span>
          </button>
        ))}
      </div>

      <Divider variant="flair" />

      {/* ---------------- sync history + permissions ---------------- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: 34,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader label="Sync history" meta="LAST 2 HOURS" />
          {history.map((h, i) => (
            <div
              key={`${h.time}-${h.system}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '9px 0',
                borderBottom: '1px solid var(--nd-border-subtle)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10.5,
                  color: 'var(--nd-text-muted)',
                  width: 44,
                  flex: '0 0 44px',
                }}
              >
                {h.time}
              </span>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10.5,
                  color: 'var(--nd-text-secondary)',
                  width: 88,
                  flex: '0 0 88px',
                }}
              >
                {h.system}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  color: 'var(--nd-text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {h.what}
              </span>
              <Badge tone={h.tone}>{h.result}</Badge>
            </div>
          ))}
          {history.length === 0 ? (
            <div
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 10.5,
                color: 'var(--nd-text-muted)',
                padding: '9px 0',
              }}
            >
              no sync events recorded yet
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionHeader label="Permissions model" />
          <div style={{ fontSize: 13, color: 'var(--nd-text-secondary)', lineHeight: 1.6 }}>
            The portal never holds standing write access. Read scopes are permanent; write is
            brokered per change, expires in fifteen minutes, and is stamped with the ticket that
            authorised it.
          </div>
          {data.permissions.map((p) => (
            <div
              key={p.mode}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--nd-border-subtle)',
              }}
            >
              <Badge tone={p.tone}>{p.mode}</Badge>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-secondary)' }}>
                {p.what}
              </span>
            </div>
          ))}
        </div>
      </div>

      <Divider variant="flair" />

      {/* ---------------- portal (this app) ---------------- */}
      <PortalSection />

      <Divider variant="flair" />

      {/* ---------------- assistant (chat) ---------------- */}
      <AssistantSection />

      {/* ---------------- plane detail drawer ---------------- */}
      <Drawer
        open={cur !== null}
        onOpenChange={(v) => {
          if (!v) setDetailName(null);
        }}
        width="lg"
        title={cur?.name ?? ''}
        description={cur?.kind ?? ''}
      >
        {cur && curView ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Badge tone={curView.stateTone} dot>
                {curView.stateLabel}
              </Badge>
              {curView.live?.stale ? (
                <span title={staleTitle(curView.live)}>
                  <Badge tone="warning">unverified</Badge>
                </span>
              ) : null}
              <Badge tone={cur.scopeTone}>{cur.scope}</Badge>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 11,
                  color: 'var(--nd-text-muted)',
                }}
              >
                {curView.live?.note ?? cur.scopeNote}
              </span>
              {/* Why the plane is behind, when the registry knows: failed
                  polls record no error on the row itself, so without this the
                  drawer shows a stale plane with nothing to explain it. */}
              {curView.live && retryNote(curView.live) ? (
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 11,
                    color: 'var(--nd-warning)',
                  }}
                >
                  {retryNote(curView.live)}
                </span>
              ) : null}
            </div>

            <SegmentedControl options={TAB_OPTIONS} value={tab} onValueChange={(v) => setTab(v as DetailTab)} />

            {tab === 'summary' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: '8px 18px',
                  }}
                >
                  {curView.facts.map((f) => (
                    <div
                      key={f.k}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        padding: '7px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 9.5,
                          letterSpacing: '.12em',
                          textTransform: 'uppercase',
                          color: 'var(--nd-text-muted)',
                        }}
                      >
                        {f.k}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 11.5,
                          color: 'var(--nd-text-secondary)',
                        }}
                      >
                        {f.v}
                      </span>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="Sites on this plane" />
                  {cur.sites.map((x) => {
                    const siteId = x.siteId;
                    return (
                      <div
                        key={x.name}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 0',
                          borderBottom: '1px solid var(--nd-border-subtle)',
                        }}
                      >
                        {/* A row that names a real site drills into it, closing
                            the drawer first (README navigation rules). The
                            'Workspace-wide' row carries siteId null and stays
                            plain text — there is no page to open. */}
                        {siteId ? (
                          <button
                            type="button"
                            onClick={() => {
                              setDetailName(null);
                              navigate(`/sites/${encodeURIComponent(siteId)}`);
                            }}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontSize: 12.5,
                              color: 'var(--nd-accent-text)',
                            }}
                          >
                            {x.name}
                          </button>
                        ) : (
                          <span
                            style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-primary)' }}
                          >
                            {x.name}
                          </span>
                        )}
                        <span
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 10.5,
                            color: 'var(--nd-text-muted)',
                          }}
                        >
                          {x.detail}
                        </span>
                      </div>
                    );
                  })}
                  {cur.sites.length === 0 ? (
                    <NothingReported label="no sites reported by this plane yet" />
                  ) : null}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="Live on this plane" />
                  {cur.live.map((l) => (
                    <div
                      key={l.label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 12,
                          color: 'var(--nd-text-primary)',
                          width: 80,
                          flex: '0 0 80px',
                        }}
                      >
                        {l.value}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-secondary)' }}>
                        {l.label}
                      </span>
                    </div>
                  ))}
                  {cur.live.length === 0 ? (
                    <NothingReported label="no sessions, devices or alerts sourced here yet" />
                  ) : null}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 12 }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/devices?plane=${curView.planeId ?? ''}`)}
                    >
                      Devices →
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/clients?plane=${curView.planeId ?? ''}`)}
                    >
                      Clients →
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/auth-events?plane=${curView.planeId ?? ''}`)}
                    >
                      Auth events →
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {tab === 'activity' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="API calls" meta="LAST 20 MINUTES" />
                  {curCalls.map((c, i) => (
                    <div
                      key={`${c.time}-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '7px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                          width: 44,
                          flex: '0 0 44px',
                        }}
                      >
                        {c.time}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 11,
                          color: 'var(--nd-text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.path}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                          width: 56,
                          textAlign: 'right',
                        }}
                      >
                        {c.ms}
                      </span>
                      <Badge tone={c.tone}>{c.code}</Badge>
                    </div>
                  ))}
                  {curCalls.length === 0 ? (
                    <div
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 10.5,
                        color: 'var(--nd-text-muted)',
                        padding: '7px 0',
                      }}
                    >
                      no calls recorded yet
                    </div>
                  ) : null}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="Recent events" />
                  {cur.events.map((e, i) => (
                    <div
                      key={`${e.time}-${i}`}
                      style={{
                        display: 'flex',
                        gap: 12,
                        padding: '9px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                          width: 44,
                          flex: '0 0 44px',
                        }}
                      >
                        {e.time}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, color: 'var(--nd-text-primary)', lineHeight: 1.4 }}>
                          {e.what}
                        </div>
                        <div
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 10,
                            color: 'var(--nd-text-muted)',
                          }}
                        >
                          {e.who}
                        </div>
                      </div>
                    </div>
                  ))}
                  {cur.events.length === 0 ? (
                    <NothingReported label="no brokered writes, token rotations or cluster changes recorded" />
                  ) : null}
                </div>
              </div>
            ) : null}

            {tab === 'config' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <SectionHeader label="What the portal pulls" />
                  {cur.pulls.map((p) => (
                    <div
                      key={p.what}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 0',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-primary)' }}>
                        {p.what}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                          width: 96,
                          textAlign: 'right',
                        }}
                      >
                        {p.every}
                      </span>
                      <Badge tone={p.tone}>{p.mode}</Badge>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <SectionHeader label="Credential & connection" />
                  <Code block>{cur.configText}</Code>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <SectionHeader label="Actions" />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button variant="secondary" size="sm" onClick={syncAll}>
                      Sync now
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        curView.planeId
                          ? openConnect({ type: curView.planeId, name: cur.name })
                          : undefined
                      }
                    >
                      Re-key credentials
                    </Button>
                    {/* The hand-off is real when the row carries a console
                        URL (SystemRow.consoleUrl). The local switch collector
                        deliberately carries none — it has no console — so the
                        control is DISABLED there rather than toasting about a
                        hand-off it cannot make or inventing a URL for it. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!cur.consoleUrl}
                      title={cur.consoleUrl ?? `${cur.name} has no console to open`}
                      onClick={() => openConsole(cur)}
                    >
                      Open console ↗
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void retire()}>
                      Retire plane
                    </Button>
                  </div>
                  {!cur.consoleUrl ? (
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 10.5,
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      no console URL recorded for {cur.name} — nothing to hand off to
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      {/* ---------------- connect a system drawer ---------------- */}
      <Drawer
        open={addOpen}
        onOpenChange={setAddOpen}
        width="lg"
        title="Connect a system"
        description="The portal needs read scope to index devices, and an optional brokered write scope for changes."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <FormField label="System type" help="Pick the plane this credential belongs to.">
            <Select
              options={CONNECT_TYPE_OPTIONS}
              value={newType}
              onValueChange={(v) => {
                setNewType(v as SystemTypeKey);
                // Another plane's fields would be saved under keys this one
                // never reads — start its credential record clean.
                setExtraCreds({});
                invalidate();
              }}
            />
          </FormField>

          <FormField label="Display name">
            <Input
              placeholder="Central — Meridian production"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                invalidate();
              }}
            />
          </FormField>

          {newType === 'central' && (
            <FormField label="Region" help="Fills the gateway URL; choose Custom to paste your own.">
              <Select
                aria-label="Central region"
                size="md"
                options={[...CENTRAL_REGIONS, { value: 'custom', label: 'Custom gateway…' }]}
                value={CENTRAL_REGIONS.some((r) => r.value === endpoint) ? endpoint : 'custom'}
                onValueChange={(v) => {
                  if (v !== 'custom') setEndpoint(v);
                  invalidate();
                }}
              />
            </FormField>
          )}

          <FormField label={endpointVariant.label} help={endpointVariant.help}>
            <Input
              mono
              placeholder={endpointVariant.hint}
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value);
                invalidate();
              }}
            />
          </FormField>

          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
          >
            <FormField label="Client ID">
              <Input
                mono
                placeholder="a41f…"
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  invalidate();
                }}
              />
            </FormField>
            <FormField label="Client secret" help="Stored in the workspace vault, never shown again.">
              <Input
                mono
                type="password"
                placeholder="••••••••••••"
                value={clientSecret}
                onChange={(e) => {
                  setClientSecret(e.target.value);
                  invalidate();
                }}
              />
            </FormField>
          </div>

          {/* What this plane's adapter needs beyond the endpoint and the
              client pair — without these the record saves, the plane links,
              and the poller runs a stub that never returns a row. */}
          {CONNECT_FIELDS[newType].map((f) => (
            <FormField
              key={f.key}
              label={f.optional ? `${f.label} — optional` : f.label}
              help={f.help}
            >
              <Input
                mono
                type={f.secret ? 'password' : undefined}
                placeholder={f.secret ? '••••••••••••' : f.key}
                value={extraCreds[f.key] ?? ''}
                onChange={(e) => {
                  setExtraCreds({ ...extraCreds, [f.key]: e.target.value });
                  invalidate();
                }}
              />
            </FormField>
          ))}

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '14px 0',
              borderTop: '1px solid var(--nd-border-subtle)',
              borderBottom: '1px solid var(--nd-border-subtle)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 10,
                letterSpacing: '.12em',
                textTransform: 'uppercase',
                color: 'var(--nd-text-muted)',
              }}
            >
              Scopes
            </span>
            <Checkbox
              label="Read inventory, sites and topology"
              checked={scopes.inventory}
              onChange={(e) => {
                setScopes({ ...scopes, inventory: e.target.checked });
                invalidate();
              }}
            />
            <Checkbox
              label="Read clients, sessions and auth events"
              checked={scopes.clientsAuth}
              onChange={(e) => {
                setScopes({ ...scopes, clientsAuth: e.target.checked });
                invalidate();
              }}
            />
            <Checkbox
              label="Read configuration and licences"
              checked={scopes.configLicences}
              onChange={(e) => {
                setScopes({ ...scopes, configLicences: e.target.checked });
                invalidate();
              }}
            />
            <Checkbox
              label="Brokered write — config push, requires a ticket reference"
              checked={scopes.write}
              onChange={(e) => {
                setScopes({ ...scopes, write: e.target.checked });
                invalidate();
              }}
            />
          </div>

          {testResult ? (
            <Alert
              tone={testResult.ok ? 'success' : 'danger'}
              title={testResult.ok ? 'Connection succeeded' : 'Connection failed'}
            >
              <span style={{ fontSize: 13 }}>{testResult.message}</span>
            </Alert>
          ) : null}

          {retestNeeded && !testResult ? (
            <Alert tone="warning" title="Re-test required">
              <span style={{ fontSize: 13 }}>
                The credentials changed after the successful test — nothing is saved yet. Run Test
                connection again, then Save and index.
              </span>
            </Alert>
          ) : null}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button
              variant="secondary"
              size="md"
              disabled={testing}
              onClick={() => void testConnection()}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={!testedOk}
              onClick={() => void saveAndIndex()}
            >
              Save and index
            </Button>
            <Button variant="ghost" size="md" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
          </div>

          <div
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 10.5,
              color: 'var(--nd-text-muted)',
              lineHeight: 1.6,
            }}
          >
            Indexing a new plane takes 2–6 minutes. Devices already claimed elsewhere are flagged as
            double-claimed rather than duplicated.
          </div>
        </div>
      </Drawer>
    </div>
  );
}
