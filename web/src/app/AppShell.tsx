/**
 * web/src/app/AppShell.tsx — the app-level shell (wraps nightdesk AppShell).
 *
 * Port of design/HpeNetworkTools.dc.html: 224px sidebar (wordmark, three nav
 * groups from the shared NAV_GROUPS fixtures, workspace footer), sticky topbar
 * (breadcrumbs [workspace, group, screen] + drill-down name, global search,
 * identity block), and the routed content area.
 */

import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { AppShell as NightdeskAppShell, Avatar, Breadcrumbs, Button } from '../nightdesk';
import type { Crumb } from '../nightdesk';
import { CRUMBS, NAV_GROUPS, SITE_IDS, SYSTEMS, siteDisplayName } from '../../../shared';
import type { SiteId, View } from '../../../shared';
import { getSystemsState } from '../api/client';
import { useSettings } from './SettingsContext';
import { SearchPanel } from './SearchPanel';
import ChatPanel from '../screens/ChatPanel';
import { pathForView, viewForPath } from './nav';

/** Nav groups stay lit on the drill-down screens. */
function navViewFor(view: View | null): View | null {
  if (view === 'site') return 'sites';
  if (view === 'device') return 'devices';
  return view;
}

function siteNameFor(siteId: string | undefined): string {
  if (!siteId) return '';
  return (SITE_IDS as readonly string[]).includes(siteId)
    ? siteDisplayName(siteId as SiteId)
    : siteId; // router params arrive decoded — decoding again throws on '%'
}

export function AppShellLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceName, settingsError } = useSettings();
  const [chatOpen, setChatOpen] = useState(false);
  // Live linked-plane count for the sidebar footer; fixture story when the
  // backend is offline (same rule the Connected-systems screen applies).
  const [linkedLabel, setLinkedLabel] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getSystemsState().then((s) => {
      if (!live || !s) return;
      if (s.apiError) {
        setLinkedLabel('systems state unavailable');
        return;
      }
      const planes = Object.values(s.planes);
      setLinkedLabel(`${planes.filter((p) => p.linked).length} of ${planes.length} systems linked`);
    });
    return () => {
      live = false;
    };
  }, []);

  // ⌘J / Ctrl+J toggles the assistant drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setChatOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const view = viewForPath(location.pathname);
  const navView = navViewFor(view);
  // useMatch (not useParams) — a pathless layout route owns no params itself.
  // Router param values are already decoded; do not decode again.
  const siteId = useMatch('/sites/:siteId')?.params.siteId;
  const deviceName = useMatch('/devices/:name')?.params.name;

  const crumbs = useMemo<Crumb[]>(() => {
    const base: Crumb[] = [{ label: workspaceName }];
    if (view === 'site') {
      base.push(
        { label: 'Sites', onClick: () => navigate('/sites') },
        { label: siteNameFor(siteId) },
      );
    } else if (view === 'device') {
      base.push(
        { label: 'Devices', onClick: () => navigate('/devices') },
        { label: deviceName ?? '' },
      );
    } else {
      base.push(...(CRUMBS[view ?? 'overview'] ?? [{ label: 'Overview' }]));
    }
    return base;
  }, [view, siteId, deviceName, workspaceName, navigate]);

  const sidebar = (
    <>
      <div style={{ padding: '0 8px' }}>
        <div
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            letterSpacing: '.18em',
            color: 'var(--nd-accent-text)',
            textTransform: 'uppercase',
          }}
        >
          HPE
        </div>
        <div
          style={{
            fontFamily: 'var(--nd-font-display)',
            fontStyle: 'italic',
            fontSize: 19,
            color: 'var(--nd-text-primary)',
            lineHeight: 1.15,
            marginTop: 2,
          }}
        >
          Network Tools
        </div>
      </div>
      {NAV_GROUPS.map((group) => (
        <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="nd-micro-label" style={{ padding: '0 8px 4px' }}>
            {group.label}
          </div>
          {group.items.map((item) => (
            <NightdeskAppShell.NavItem
              key={item.view}
              label={item.label}
              active={item.view === navView}
              onClick={() => navigate(pathForView(item.view))}
            />
          ))}
        </div>
      ))}
      <div
        style={{
          marginTop: 'auto',
          padding: '12px 8px 0',
          borderTop: '1px solid var(--nd-border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <span className="nd-micro-label">Workspace</span>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-secondary)' }}>
            {workspaceName}
          </span>
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              color: 'var(--nd-text-muted)',
            }}
          >
            GLK
          </span>
        </div>
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            color: 'var(--nd-text-muted)',
          }}
        >
          {linkedLabel ?? `${SYSTEMS.length} of ${SYSTEMS.length} systems linked`}
        </span>
      </div>
    </>
  );

  const topbar = (
    <>
      <Breadcrumbs items={crumbs} />
      <SearchPanel />
      {settingsError ? (
        <span
          className="nt-shell-settings-error"
          role="status"
          style={{
            maxWidth: 260,
            color: 'var(--nd-danger)',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
          }}
        >
          {settingsError}
        </span>
      ) : null}
      <Button
        className="nt-shell-assistant"
        variant="ghost"
        size="sm"
        onClick={() => setChatOpen((v) => !v)}
        aria-label="Open the assistant"
      >
        Assistant ⌘J
      </Button>
      <div
        className="nt-shell-identity"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingLeft: 6,
          borderLeft: '1px solid var(--nd-border-subtle)',
        }}
      >
        <div style={{ textAlign: 'right', lineHeight: 1.25 }}>
          <div style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
            R. Okafor
          </div>
          <div
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              color: 'var(--nd-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '.1em',
            }}
          >
            Network engineer
          </div>
        </div>
        <Avatar name="R. Okafor" size="sm" />
      </div>
    </>
  );

  return (
    <NightdeskAppShell sidebar={sidebar} topbar={topbar}>
      <Outlet />
      <ChatPanel open={chatOpen} onOpenChange={setChatOpen} />
    </NightdeskAppShell>
  );
}
