/**
 * web/src/app/AppShell.tsx — the app-level shell (wraps nightdesk AppShell).
 *
 * Sidebar (wordmark, the three NAV_GROUPS workflow groups, workspace footer),
 * sticky topbar (breadcrumbs [workspace, group, screen] + drill-down name,
 * global search, identity block), and the routed content area.
 *
 * The sidebar carries workflow links only. It used to also mount a compact
 * copy of the inventory tree, which on /inventory painted the same tree twice
 * on one screen and, everywhere else, spent a third of the sidebar's height on
 * a browser nobody navigated from. Browsing the estate lives on /inventory.
 *
 * Twelve links do not fill a full-height column, so the sidebar collapses to a
 * 52px icon rail and gives the ~185px back to the content. The choice is a
 * pure display preference with no estate data in it, so it is the one thing
 * here that is allowed into localStorage.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { Alert, AppShell as NightdeskAppShell, Avatar, Breadcrumbs, Button, Drawer, Spinner } from '../nightdesk';
import type { Crumb } from '../nightdesk';
import { CRUMBS, NAV_GROUPS, SITE_IDS, SYSTEMS, siteDisplayName } from '@hpe/shared';
import type { NotificationCenterEntry, NotificationCenterSeverity, NotificationCenterView, SiteId, View } from '@hpe/shared';
import { getSystemsState } from '../api/client';
import { getNotificationCenter, markNotificationCenterRead } from '../api/notificationCenter';
import { isBackendReachable, onBackendReachabilityChange } from '../api/core';
import { useSettings } from './SettingsContext';
import { SearchPanel } from './SearchPanel';
import ChatPanel from '../screens/ChatPanel';
import { pathForView, viewForPath } from './nav';
import { NAV_ICONS } from './navIcons';
import { useAuth } from './AuthGate';
import { logout } from '../api/auth';

const RAIL_KEY = 'hpe-nt.nav-rail';

/**
 * What a lazy screen chunk shows while it loads: the portal's ordinary
 * spinner, centred in the content area. The shell itself (sidebar, topbar)
 * is eager and stays put — only the screen is ever pending.
 */
export function RouteFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
      <Spinner />
    </div>
  );
}

function readRailPref(): boolean {
  try {
    return window.localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false; // private mode / disabled storage is not an error worth showing
  }
}

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

/**
 * Who is signed in, and a way out.
 *
 * When no identity provider is configured this says so rather than rendering
 * nothing: "anyone who can reach this port may use it" is a fact the operator
 * should be able to see, not one they have to infer from the absence of a
 * login screen.
 */
function SignedInAs() {
  const auth = useAuth();
  if (!auth) return null;
  if (!auth.configured) {
    return (
      <span className="nt-shell-workspace__linked" title="No identity provider is configured, so the portal is open and changes are recorded as 'operator'.">
        No sign-in required
      </span>
    );
  }
  if (!auth.principal) return null;
  return (
    <div className="nt-shell-workspace__row" style={{ marginTop: 6 }}>
      <span className="nt-shell-workspace__linked" title={auth.principal.email ?? auth.principal.name}>
        {auth.principal.name}
      </span>
      <Button variant="ghost" size="sm" onClick={() => void logout()}>
        Sign out
      </Button>
    </div>
  );
}

/**
 * Says out loud that the backend stopped answering.
 *
 * Every screen getter substitutes the authored demo fixtures when no backend
 * answers, and the resulting payload is indistinguishable from the one a
 * portal deliberately running in demo mode serves. Without this banner a tab
 * left open on live data re-renders, on the next poll after a crash or a
 * restart, as a complete and plausible estate that does not exist — under a
 * "SYNCED 09:41" stamp that reads like an ordinary timestamp.
 *
 * It sits in the shell rather than on each screen because the substitution is
 * global: the operator may be looking at any of them when the backend goes.
 */
function BackendUnreachableBanner() {
  const [reachable, setReachable] = useState(isBackendReachable);
  useEffect(() => onBackendReachabilityChange(setReachable), []);
  if (reachable) return null;
  return (
    <div style={{ padding: '12px 0 0' }}>
      <Alert tone="danger" title="The portal backend is not answering">
        <span style={{ fontSize: 13 }}>
          Nothing below is your estate. The screens fall back to built-in sample data when no
          backend answers, so the sites, alerts and devices shown are fixtures — not a reading of
          your network, and not a statement that it is healthy. This clears by itself as soon as
          the portal responds again.
        </span>
      </Alert>
    </div>
  );
}

/** The tone dot a bell entry's severity maps to. */
function notificationTone(severity: NotificationCenterSeverity): string {
  switch (severity) {
    case 'danger':
      return 'var(--nd-danger)';
    case 'warning':
      return 'var(--nd-warning)';
    case 'success':
      return 'var(--nd-success)';
    default:
      return 'var(--nd-info)';
  }
}

/**
 * The notification center's topbar presence: a bell with the unread count,
 * opening the newest entries. Polls on the same cadence as the engine's
 * evaluation (60s) and refreshes again when opened.
 *
 * The failure states are stated, not hidden: a backend that does not answer
 * leaves the bell badge-less (no fabricated zero) and the dropdown says why,
 * and a demo entry is labelled demo — the showcase must never read as the
 * estate. Clicking an entry marks it read and follows its url; the unread
 * count is always the server's own answer, never a client-side guess.
 */
function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<NotificationCenterView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const result = await getNotificationCenter();
      if (!live) return;
      if ('error' in result) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      setView(result);
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  // A fresh read when the dropdown opens — the badge may be a minute stale.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void getNotificationCenter().then((result) => {
      if (!live || 'error' in result) return;
      setUnavailable(false);
      setView(result);
    });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openEntry = (entry: NotificationCenterEntry) => {
    setOpen(false);
    if (!entry.read) {
      void markNotificationCenterRead({ ids: [entry.id] }).then((result) => {
        if ('error' in result) return;
        setView((current) =>
          current
            ? {
                entries: current.entries.map((e) => (e.id === entry.id ? { ...e, read: true } : e)),
                unread: result.unread,
              }
            : current,
        );
      });
    }
    if (entry.url) navigate(entry.url);
  };

  const markAll = () => {
    void markNotificationCenterRead({ all: true }).then((result) => {
      if ('error' in result) return;
      setView((current) =>
        current
          ? { entries: current.entries.map((e) => ({ ...e, read: true })), unread: result.unread }
          : current,
      );
    });
  };

  const unread = view?.unread ?? 0;
  return (
    <div ref={rootRef} style={{ position: 'relative', flex: '0 0 auto' }}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
          <path d="M8 2.25a4.25 4.25 0 0 0-4.25 4.25v2.5l-1.5 3h11.5l-1.5-3v-2.5A4.25 4.25 0 0 0 8 2.25Z" />
          <path d="M6.25 12.75a1.75 1.75 0 0 0 3.5 0" />
        </svg>
        {unread > 0 ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: -4,
              right: -6,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 8,
              background: 'var(--nd-danger)',
              color: 'var(--nd-text-inverse, #fff)',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 10,
              lineHeight: '16px',
              textAlign: 'center',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position: 'absolute',
            top: 38,
            right: 0,
            width: 360,
            maxWidth: '90vw',
            background: 'var(--nd-bg-raised)',
            border: '1px solid var(--nd-border-default)',
            borderRadius: 'var(--nd-radius-md)',
            boxShadow: 'var(--nd-shadow-overlay)',
            padding: 6,
            zIndex: 30,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px' }}>
            <span className="nd-micro-label">Notifications</span>
            <Button variant="ghost" size="sm" onClick={markAll} disabled={unread === 0}>
              Mark all read
            </Button>
          </div>
          {unavailable ? (
            <div style={{ padding: '12px 8px', fontSize: 13, color: 'var(--nd-text-muted)' }}>
              Notifications are unavailable — the portal backend is not answering. The badge returns
              when it does; nothing here is a statement about your estate.
            </div>
          ) : view === null ? (
            <div style={{ padding: '12px 8px', fontSize: 13, color: 'var(--nd-text-muted)' }}>Checking…</div>
          ) : view.entries.length === 0 ? (
            <div style={{ padding: '12px 8px', fontSize: 13, color: 'var(--nd-text-muted)' }}>
              No notifications yet — device-down alerts and their recoveries land here.
            </div>
          ) : (
            <div style={{ maxHeight: 380, overflow: 'auto' }}>
              {view.entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => openEntry(entry)}
                  style={{
                    display: 'flex',
                    gap: 8,
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 6px',
                    border: 'none',
                    borderRadius: 'var(--nd-radius-sm)',
                    background: 'transparent',
                    color: 'var(--nd-text-primary)',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      flex: '0 0 auto',
                      width: 8,
                      height: 8,
                      marginTop: 5,
                      borderRadius: '50%',
                      background: notificationTone(entry.severity),
                    }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: entry.read ? 400 : 600 }}>
                      {entry.title}
                      {entry.demo ? (
                        <span style={{ marginLeft: 6, fontFamily: 'var(--nd-font-mono)', fontSize: 10, color: 'var(--nd-text-muted)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                          demo
                        </span>
                      ) : null}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--nd-text-muted)', overflowWrap: 'anywhere' }}>
                      {entry.body}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function AppShellLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceName, settingsError } = useSettings();
  const auth = useAuth();
  const [chatOpen, setChatOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [rail, setRail] = useState(readRailPref);

  const toggleRail = () => {
    setRail((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(RAIL_KEY, next ? '1' : '0');
      } catch {
        /* the preference simply will not survive a reload */
      }
      return next;
    });
  };
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
      if (s.demoMode) {
        setLinkedLabel(`${SYSTEMS.length} demo systems`);
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

  const renderSidebar = (onNavigate?: () => void, collapsible = true) => (
    <>
      <div className="nt-shell-brand">
        <div className="nt-shell-brand__copy">
          <div className="nt-shell-brand__kicker">HPE</div>
          <div className="nt-shell-brand__name">Network Tools</div>
        </div>
        {collapsible ? (
        <button
          type="button"
          className="nt-shell-rail-toggle"
          onClick={toggleRail}
          title={rail ? 'Expand navigation' : 'Collapse navigation'}
          aria-label={rail ? 'Expand navigation' : 'Collapse navigation'}
          aria-pressed={rail}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
            <path d="M6.25 2.75v10.5" />
          </svg>
        </button>
        ) : null}
      </div>
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="nt-shell-navgroup">
          <div className="nd-micro-label nt-shell-navgroup__label">{group.label}</div>
          {group.items.map((item) => (
            <NightdeskAppShell.NavItem
              key={item.view}
              label={item.label}
              icon={NAV_ICONS[item.view]}
              active={item.view === navView}
              onClick={() => {
                navigate(pathForView(item.view));
                onNavigate?.();
              }}
            />
          ))}
        </div>
      ))}
      <div className="nt-shell-workspace">
        <span className="nd-micro-label">Workspace</span>
        <div className="nt-shell-workspace__row">
          <span className="nt-shell-workspace__name">{workspaceName}</span>
          <span className="nt-shell-workspace__tag">GLK</span>
        </div>
        <span className="nt-shell-workspace__linked">
          {linkedLabel ?? 'checking linked systems…'}
        </span>
        <SignedInAs />
      </div>
    </>
  );
  const sidebar = renderSidebar();

  const topbar = (
    <>
      <Button
        className="nt-shell-menu"
        variant="ghost"
        size="sm"
        onClick={() => setNavOpen(true)}
        aria-label="Open navigation"
      >
        ☰ Menu
      </Button>
      <Breadcrumbs items={crumbs} />
      <SearchPanel />
      <NotificationBell />
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
        <span className="nt-shell-assistant__label">Assistant</span>
        <span className="nt-shell-assistant__shortcut">⌘J</span>
        <span className="nt-shell-assistant__compact" aria-hidden="true">AI</span>
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
            {auth?.principal?.name ?? 'Operator'}
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
            {auth?.principal?.email ?? (auth?.configured ? '' : 'no sign-in required')}
          </div>
        </div>
        <Avatar name={auth?.principal?.name ?? 'Operator'} size="sm" />
      </div>
    </>
  );

  return (
    <NightdeskAppShell sidebar={sidebar} topbar={topbar} className={rail ? 'nd-shell--rail' : undefined}>
      <BackendUnreachableBanner />
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
      <ChatPanel open={chatOpen} onOpenChange={setChatOpen} />
      <Drawer
        open={navOpen}
        onOpenChange={setNavOpen}
        width={320}
        side="left"
        title="Navigation"
        description={workspaceName}
      >
        <nav className="nt-mobile-nav" aria-label="Primary navigation">
          {renderSidebar(() => setNavOpen(false), false)}
        </nav>
      </Drawer>
    </NightdeskAppShell>
  );
}
