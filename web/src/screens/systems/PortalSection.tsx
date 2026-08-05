/** Portal settings: polling, density, per-section data source. */

import {
  getPortalSettings,
  savePortalSettings,
  type PortalSettings,
} from '../../api/client';
import {
  type Density,
  useSettings,
} from '../../app/SettingsContext';
import {
  Badge,
  Button,
  FormField,
  Input,
  SectionHeader,
  SegmentedControl,
  Select,
  Switch,
  useToast,
} from '../../nightdesk';
import {
  DENSITY_OPTIONS,
  POLL_OPTIONS,
  SECTION_LABEL,
  SOURCE_OPTIONS,
} from './facts';
import {
  SCREEN_SECTIONS,
  type ScreenSection,
} from '@hpe/shared';
import {
  useEffect,
  useRef,
  useState,
} from 'react';
import { buildSystemsSectionUrl, systemsSectionDomId } from './share';

/**
 * The portal's own controls: demo mode and poll cadence live in the server
 * settings store (PUT /api/settings; the cadence applies without a restart),
 * while workspace identity, table density and platform tags are the shell
 * preferences from SettingsContext (same endpoint, plus a localStorage copy
 * so they survive a backend outage). Demo mode flips every screen between the
 * authored fixtures and values computed from the poller cache.
 */
export function PortalSection() {
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
  const [nocWall, setNocWall] = useState(() => {
    try {
      return localStorage.getItem('hpe-nt.noc-wall') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle('nd-noc-wall', nocWall);
    try {
      localStorage.setItem('hpe-nt.noc-wall', nocWall ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [nocWall]);
  /* The context value can change after mount — the server settings replace
     the localStorage seed when they land (SettingsContext). Re-seed the input
     from it, but never over text the operator typed and has not committed:
     the input only follows the context value while it still shows the
     previous one. */
  const seededNameRef = useRef(workspaceName);
  useEffect(() => {
    if (workspaceName === seededNameRef.current) return;
    setName((current) => (current === seededNameRef.current ? workspaceName : current));
    seededNameRef.current = workspaceName;
  }, [workspaceName]);

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

  const copySectionLink = () => {
    const url = buildSystemsSectionUrl('portal');
    void navigator.clipboard.writeText(url).then(
      () =>
        toast('Portal section link copied', {
          description: 'section=portal',
          tone: 'success',
        }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  return (
    <div id={systemsSectionDomId('portal')} className="nt-systems-section nt-section-panel nt-stack nt-gap-14">
      <div className="nt-filter-bar nt-gap-8">
        <SectionHeader label="Portal" meta="THIS APP · POLLER" />
        <Button variant="ghost" size="sm" className="nt-ml-auto" onClick={copySectionLink}>
          Copy section link
        </Button>
      </div>
      <div className="nt-status-ribbon nt-portal-ribbon" role="status" aria-label="Portal status ribbon">
        <span className="nt-status-ribbon__item">portal · workspace</span>
        <span className="nt-status-ribbon__item">preferences · density</span>
        <span className="nt-status-ribbon__item">theme · midnight</span>
      </div>
      <div className="nt-filter-bar nt-gap-8">
        {portal ? (
          <>
            <Badge tone={portal.demoMode ? 'warning' : 'success'} dot>
              {portal.demoMode ? (portal.blendLive ? 'demo + live blend' : 'demo data') : 'live data'}
            </Badge>
            <Badge tone="neutral">{`poll every ${portal.pollIntervalSec}s`}</Badge>
          </>
        ) : (
          <span
            className="nt-hint-muted"
          >
            {loadError ?? (offline ? 'backend offline — portal settings unavailable' : 'reading portal settings…')}
          </span>
        )}
      </div>

      <div
        className="nt-grid-2-14"
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

      <div className="nt-row nt-wrap-22">
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
          checked={nocWall}
          onCheckedChange={setNocWall}
          label="NOC wall (larger type)"
        />
        <Switch
          checked={showPlatformTags}
          onCheckedChange={setShowPlatformTags}
          label="Show platform tags"
        />
      </div>

      <SectionHeader label="Screen sources" meta="OVERRIDE THE PORTAL DEFAULT PER SCREEN" />
      <div
        className="nt-grid-3-14"
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
