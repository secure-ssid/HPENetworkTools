/**
 * web/src/screens/GreenLake.tsx — the HPE GreenLake workspace surface.
 *
 * The one screen that treats GreenLake as a platform rather than as a licence
 * feed: workspace members, locations and role grants, plus the reviewed writes
 * the workspace credential is allowed to perform (invite/remove a user, create
 * /delete a location, add a device, submit a subscription key, grant/revoke a
 * role). Subscriptions themselves stay on Licences — that screen reconciles
 * them against racked hardware and this one does not duplicate it.
 *
 * Workspace `q=` / member `status=` write back for share links; a **Status**
 * chip row (counts over the q universe) toggles the same `?status=` as the
 * Member status Select. Members multi-select raises **Export selected**,
 * **Copy emails** (unique newline-joined usernames — Devices **Copy serials**
 * pattern; Loop 172), **Copy names** (unique newline-joined first+last display
 * names when emails are sparse — Devices / Clients pattern; Loop 231), **Copy
 * selection link** (`?ids=` of marked member ids — Sites `?ids=` pattern;
 * clearable chip while active; Loop 177), and **Clear**. Role grants multi-select
 * raises **Export selected**, **Copy principals** (unique newline-joined
 * principal ids/names), **Copy names** (unique newline-joined role labels when
 * principals alone are sparse for a handoff — Devices **Copy names** pattern;
 * Loop 235), **Copy selection link** (`?roleIds=` of marked grant ids with
 * `section=roles`; clearable chip — Loop 196), and **Clear**. Locations
 * multi-select raises **Export selected**, **Copy names**, **Copy selection
 * link** (`?locationIds=` with `section=locations`; clearable chip — Loop 196),
 * and **Clear**. Header **LIVE** stamps a successful plane inventory read
 * (Loop 168) — this screen never serves authored fixtures; null is an explicit
 * failure, not demo chrome. Members table carries keyboard shortcuts help
 * (`?` / DATATABLE_ROW_SHORTCUTS — Loop 195). Filtered empties offer **Clear
 * filters** (Loop 195). Selection-empty `?ids=` / `?roleIds=` / `?locationIds=`
 * offer **Clear selection filter** (Loop 216).
 *
 * HONESTY RULES THIS SCREEN ENFORCES:
 *  - A section listed in `unavailable` renders as an explicit failure with its
 *    read status, never as an empty table. "No users" and "the users feed was
 *    denied" must never look alike.
 *  - `accepted` (HTTP 202) is reported as submitted-for-validation, never as
 *    applied: the subscription endpoints validate the key asynchronously.
 *  - There is no role PICKER. GreenLake withdrew the role catalogue endpoint
 *    from its public API, so the portal cannot enumerate assignable roles and
 *    asks for the role GRN rather than pretending to offer a complete list.
 *  - Device removal is absent because GreenLake answers 405 to it; the screen
 *    does not offer an action the plane cannot perform.
 *
 * Every write is gated server-side on the declared write scope AND an explicit
 * review confirmation; `canWrite` only decides whether the controls render.
 * In hardened (non-lab) mode the UI also requires the operator to tick
 * "I have reviewed this write" before any action sends `reviewConfirmed:true`
 * — the badge says "reviewed writes", so the checkbox is the review, never a
 * silent auto-confirm. Lab mode keeps direct writes without the checkbox.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  PageSkeleton,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  SectionHeader,
  Select,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  KeyboardShortcuts,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { getGreenLakeInventory, runGreenLakeAction } from '../api/client';
import type { GreenLakeInventoryResponse } from '../api/client';
import type { GreenLakeSectionKey, GreenLakeWriteAction } from '@hpe/shared';
import { countOf, shortDateLocal } from '@hpe/shared';
import { useSettings } from '../app/SettingsContext';
import { namesFilterForParam } from '../app/nav';
import { useLabConfigMode } from '../hooks/useLabConfigMode';
import { ScreenHeader } from './ScreenHeader';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ApiErrorState } from './ApiErrorState';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';

/** Parse `?section=` (users | locations | roles | roleAssignments). */
export function sectionFromParam(raw: string | null): GreenLakeSectionKey | null {
  if (!raw) return null;
  if (raw === 'roles' || raw === 'roleAssignments') return 'roleAssignments';
  if (raw === 'users' || raw === 'locations') return raw;
  return null;
}

/** Canonical share token for a section (`roles` is the short form of roleAssignments). */
export function sectionToParam(section: GreenLakeSectionKey): string {
  return section === 'roleAssignments' ? 'roles' : section;
}

/** DOM id targeted by `?section=` scroll + share hash. */
export function sectionDomId(section: GreenLakeSectionKey): string {
  return `greenlake-section-${section === 'roleAssignments' ? 'roles' : section}`;
}

/** Build a clipboard URL that reopens one GreenLake section (or the whole page). */
export function buildGreenLakeShareUrl(
  section: GreenLakeSectionKey | null,
  origin = typeof window !== 'undefined' ? window.location.origin : '',
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/greenlake',
  q = '',
  status = '',
): string {
  const next = new URLSearchParams();
  if (section) next.set('section', sectionToParam(section));
  const qTrim = q.trim();
  if (qTrim) next.set('q', qTrim);
  const statusTrim = status.trim();
  if (statusTrim && statusTrim.toLowerCase() !== 'all') next.set('status', statusTrim);
  const qs = next.toString();
  const hash = section ? `#${sectionDomId(section)}` : '';
  return `${origin}${pathname}${qs ? `?${qs}` : ''}${hash}`;
}

/** Exact case-insensitive user status match (mirrors server export status=). */
export function matchesGreenLakeUserStatus(
  status: string | null | undefined,
  want: string,
): boolean {
  const needle = want.trim().toLowerCase();
  if (!needle || needle === 'all') return true;
  return String(status ?? '')
    .trim()
    .toLowerCase() === needle;
}

/** Case-insensitive substring over stringified fields (mirrors server export q=). */
export function matchesGreenLakeQ(
  parts: Array<string | number | null | undefined>,
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return parts
    .map((p) => String(p ?? ''))
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

/**
 * Map the focused GreenLake section onto `GET /api/greenlake/export?part=`.
 * No focus → users (server default). Role grants use the short `roles` token.
 */
export function sectionToExportPart(
  section: GreenLakeSectionKey | null,
): 'users' | 'locations' | 'roles' {
  if (section === 'locations') return 'locations';
  if (section === 'roleAssignments') return 'roles';
  return 'users';
}

/** Human label per section, used by both the headers and the failure notes. */
const SECTION_LABEL: Record<GreenLakeSectionKey, string> = {
  users: 'Workspace members',
  locations: 'Locations',
  roleAssignments: 'Role grants',
};

/** A failed section states what happened and why — never an empty table. */
function SectionFailure({
  data,
  section,
}: {
  data: GreenLakeInventoryResponse;
  section: GreenLakeSectionKey;
}) {
  const status = data.readStatus[section];
  const message =
    status && status.state === 'failed'
      ? status.message
      : 'This section has not been read yet; run a sync to obtain its current status.';
  return (
    <Alert tone="warning" title={`${SECTION_LABEL[section]} could not be read`}>
      <span className="nt-body-sm">{message}</span>
    </Alert>
  );
}

/** A labelled inline field for the small write forms. */
function Field({
  label,
  value,
  onChange,
  placeholder,
  width = 190,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number;
}) {
  return (
    <label className="nt-stack nt-gap-4">
      <span
        className="nt-kicker"
      >
        {label}
      </span>
      <Input
        size="sm"
        value={value}
        placeholder={placeholder}
        style={{ ['--nd-field-w' as string]: `${width}px` }}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </label>
  );
}

export default function GreenLake() {
  const { density } = useSettings();
  const { lab } = useLabConfigMode();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const focusSection = sectionFromParam(searchParams.get('section'));
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [userStatus, setUserStatus] = useState(() => {
    const s = searchParams.get('status')?.trim();
    return s && s.length > 0 ? s : 'all';
  });
  const [data, setData] = useState<GreenLakeInventoryResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Hardened-mode review gate — must be true before reviewConfirmed is sent. */
  const [reviewed, setReviewed] = useState(false);
  /* Keyboard multi-select on workspace members raises Export selected /
   * Copy emails / Copy names / Copy selection link. */
  const [selectedMemberKeys, setSelectedMemberKeys] = useState<string[]>([]);
  /* Role grants / locations multi-select (Loop 196) — separate mark sets so a
   * members bulk never collides with grant/location selection. */
  const [selectedRoleKeys, setSelectedRoleKeys] = useState<string[]>([]);
  const [selectedLocationKeys, setSelectedLocationKeys] = useState<string[]>([]);
  /* Deep link: /greenlake?ids=a\nb (bulk Copy selection link). Read off the URL
   * like Sites ?ids= — must not drift from the address bar. */
  const idsFilter = namesFilterForParam(searchParams.get('ids'));
  /* Deep link: /greenlake?section=roles&roleIds=a\nb (role grants bulk). */
  const roleIdsFilter = namesFilterForParam(searchParams.get('roleIds'));
  /* Deep link: /greenlake?section=locations&locationIds=a\nb (locations bulk). */
  const locationIdsFilter = namesFilterForParam(searchParams.get('locationIds'));

  /* Keep ?q= / ?status= aligned so Copy view/section link and refresh reopen the same filter.
   * Selection deep-link `ids=` is URL-owned (Copy selection link) and preserved here. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const qTrim = q.trim();
    if (qTrim) next.set('q', qTrim);
    else next.delete('q');
    if (userStatus !== 'all') next.set('status', userStatus);
    else next.delete('status');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [q, userStatus, searchParams, setSearchParams]);

  useEffect(() => {
    if (!focusSection) return;
    const el = document.getElementById(sectionDomId(focusSection));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusSection, data]);

  const copySectionLink = useCallback(
    (section: GreenLakeSectionKey | null) => {
      const url = buildGreenLakeShareUrl(section, undefined, undefined, q, userStatus);
      const bits = [
        section ? `section=${sectionToParam(section)}` : null,
        q.trim() ? `q=${q.trim()}` : null,
        userStatus !== 'all' ? `status=${userStatus}` : null,
      ].filter(Boolean);
      const qs = bits.length > 0 ? bits.join('&') : 'GreenLake workspace';
      void navigator.clipboard.writeText(url).then(
        () =>
          toast(section ? 'Section link copied' : 'View link copied', {
            description: qs,
            tone: 'success',
          }),
        () => toast('Could not copy link', { description: url, tone: 'danger' }),
      );
    },
    [toast, q, userStatus],
  );
  // Write form state — one flat bag keeps the small inline forms simple.
  const [inviteEmail, setInviteEmail] = useState('');
  const [locName, setLocName] = useState('');
  const [locStreet, setLocStreet] = useState('');
  const [locCity, setLocCity] = useState('');
  const [locPostal, setLocPostal] = useState('');
  const [locCountry, setLocCountry] = useState('');
  const [locContact, setLocContact] = useState('');
  const [locPhone, setLocPhone] = useState('');
  const [devSerial, setDevSerial] = useState('');
  const [devMac, setDevMac] = useState('');
  const [subKey, setSubKey] = useState('');
  const [rolePrincipal, setRolePrincipal] = useState('');
  const [roleGrn, setRoleGrn] = useState('');

  const load = useCallback(async () => {
    const d = await getGreenLakeInventory();
    if (d === null) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setData(d);
  }, []);

  /* The mount read is written out rather than routed through `load`: the
     compiler's effect rule cannot see across load's await and flags the call,
     and the live-guard is the house idiom for a one-shot fetch anyway. */
  useEffect(() => {
    let live = true;
    void getGreenLakeInventory().then((d) => {
      if (!live) return;
      if (d === null) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setData(d);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Run one reviewed action, then reload. The toast distinguishes `applied`
   * from `accepted` so a 202 is never reported as a completed change.
   * Hardened mode refuses to call the API until the review checkbox is ticked
   * — never auto-sends `reviewConfirmed:true` behind a "reviewed writes" badge.
   */
  const run = async (
    action: GreenLakeWriteAction,
    fields: Record<string, unknown>,
    onDone?: () => void,
  ) => {
    if (!lab && !reviewed) {
      toast('Review the change before it applies', {
        description: 'Tick “I have reviewed this write” first — the portal will not auto-confirm.',
        tone: 'warning',
      });
      return;
    }
    setBusy(true);
    const r = await runGreenLakeAction(action, fields, lab ? undefined : true);
    setBusy(false);
    if (!r.ok) {
      toast('GreenLake refused the change', { description: r.message, tone: 'danger' });
      return;
    }
    setReviewed(false);
    if (r.outcome === 'accepted') {
      // The handle is the whole value of telling someone a change is pending:
      // without it "the workspace validates this asynchronously" is a fact the
      // operator can do nothing with. It is also in the change log, because a
      // toast is gone in seconds and this outcome is settled elsewhere.
      toast('Submitted to GreenLake', {
        description:
          `${r.message}. The workspace validates this asynchronously — it is not applied yet. ` +
          (r.transactionId
            ? `Workspace transaction ${r.transactionId} — recorded in the change log.`
            : 'GreenLake returned no transaction id, so there is no handle to track it by.'),
      });
    } else if (r.cacheRefresh && !r.cacheRefresh.ok) {
      // The change landed but the lists below still show the state from before
      // it. Saying only "Applied" here would leave the operator staring at an
      // unchanged table, and the obvious response to that is to do it again.
      toast('Applied in GreenLake — the lists below are behind', {
        description:
          `${r.message}. The workspace inventory could not be re-read (${
            r.cacheRefresh.message ?? 'reason not reported'
          }), so this change is not shown yet. Do not repeat it; sync again in a moment.` +
          // The lists cannot show the object, so its id is the only thing the
          // operator can check the change against in the meantime.
          (r.id ? ` GreenLake id ${r.id}.` : ''),
        tone: 'warning',
      });
    } else {
      toast('Applied in GreenLake', { description: r.message });
    }
    onDone?.();
    await load();
  };

  if (failed) {
    return (
      <ApiErrorState message="The GreenLake workspace could not be read. It may not be linked — connect it from Connected systems." />
    );
  }
  if (!data) {
    return <PageSkeleton variant="list" />;
  }

  const has = (s: GreenLakeSectionKey) => !data.unavailable.includes(s);
  const readOnly = !data.canWrite;
  /** Write controls stay disabled until lab mode or an explicit review tick. */
  const writesArmed = lab || reviewed;

  /* Status chips count over q+ids (not status) so operators see the full member
   * status mix while a chip is active. Selection deep-link `ids=` narrows every universe. */
  const matchesIds = (u: (typeof data.users)[number]) =>
    idsFilter === null || idsFilter.includes(u.id);
  const userStatusUniverse = data.users.filter(
    (u) =>
      matchesIds(u) &&
      matchesGreenLakeQ([u.id, u.username, u.firstName, u.lastName, u.status, u.lastLogin], q),
  );
  const filteredUsers = userStatusUniverse.filter((u) =>
    matchesGreenLakeUserStatus(u.status, userStatus),
  );
  const idsPresent =
    idsFilter === null ? 0 : idsFilter.filter((id) => data.users.some((u) => u.id === id)).length;
  const statusOptions = [{ value: 'all', label: 'All statuses' }].concat(
    Array.from(
      new Set(
        data.users
          .map((u) => String(u.status ?? '').trim())
          .filter((s) => s.length > 0),
      ),
    )
      .sort((a, b) => a.localeCompare(b))
      .map((s) => ({ value: s, label: s })),
  );
  if (userStatus !== 'all' && !statusOptions.some((o) => o.value === userStatus)) {
    statusOptions.push({ value: userStatus, label: `${userStatus} (no members)` });
  }
  const statusChipKeys = Array.from(
    new Set(
      userStatusUniverse
        .map((u) => String(u.status ?? '').trim())
        .filter((s) => s.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));
  if (userStatus !== 'all' && !statusChipKeys.some((k) => k.toLowerCase() === userStatus.toLowerCase())) {
    statusChipKeys.unshift(userStatus);
  }
  const statusChips = statusChipKeys.map((key) => ({
    key,
    label: key,
    tone: (key.toUpperCase() === 'VERIFIED' ? 'success' : 'warning') as 'success' | 'warning',
    count: userStatusUniverse.filter((u) => matchesGreenLakeUserStatus(u.status, key)).length,
  }));
  const filteredLocations = data.locations.filter(
    (l) =>
      (locationIdsFilter === null || locationIdsFilter.includes(l.id)) &&
      matchesGreenLakeQ([l.id, l.name, l.type, l.address, l.country, l.deviceCount], q),
  );
  const locationIdsPresent =
    locationIdsFilter === null
      ? 0
      : locationIdsFilter.filter((id) => data.locations.some((l) => l.id === id)).length;
  const filteredRoles = data.roleAssignments.filter(
    (r) =>
      (roleIdsFilter === null || roleIdsFilter.includes(r.id)) &&
      matchesGreenLakeQ(
        [r.id, r.principal, r.principalType, r.principalName, r.role, r.roleGrn, r.scope.join(' '), r.source],
        q,
      ),
  );
  const roleIdsPresent =
    roleIdsFilter === null
      ? 0
      : roleIdsFilter.filter((id) => data.roleAssignments.some((r) => r.id === id)).length;

  const memberColumns: Array<DataTableColumn<(typeof data.users)[number]>> = [
    {
      key: 'member',
      title: 'Member',
      hideable: false,
      render: (u) => <span className="nt-mono-11 nt-fs-12">{u.username}</span>,
    },
    {
      key: 'name',
      title: 'Name',
      render: (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || '—',
    },
    {
      key: 'status',
      title: 'Status',
      render: (u) => (
        <Badge tone={u.status === 'VERIFIED' ? 'success' : 'warning'}>{u.status ?? 'unknown'}</Badge>
      ),
    },
    {
      key: 'lastLogin',
      title: 'Last login',
      numeric: true,
      render: (u) => <span className="nt-mono-11 nt-fs-12">{shortDateLocal(u.lastLogin)}</span>,
    },
    ...(readOnly
      ? []
      : [
          {
            key: 'actions',
            title: '',
            hideable: false as const,
            render: (u: (typeof data.users)[number]) => (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !writesArmed}
                onClick={() => void run('deleteUser', { id: u.id })}
              >
                Remove
              </Button>
            ),
          },
        ]),
  ];

  const roleColumns: Array<DataTableColumn<(typeof data.roleAssignments)[number]>> = [
    {
      key: 'principal',
      title: 'Principal',
      hideable: false,
      render: (a) => (
        <>
          {a.principalName ?? <span className="nt-mono-11 nt-fs-12">{a.principal}</span>}
          {a.principalName ? null : <Badge tone="neutral">{a.principalType}</Badge>}
        </>
      ),
    },
    {
      key: 'role',
      title: 'Role',
      render: (a) => <span className="nt-mono-11 nt-fs-12">{a.role}</span>,
    },
    {
      key: 'scope',
      title: 'Scope',
      render: (a) => (
        <span className="nt-body-sm nt-hint-muted">
          {a.scope.length === 1 && a.scope[0].includes('/workspaces/')
            ? 'this workspace'
            : countOf(a.scope.length, 'scope')}
        </span>
      ),
    },
    ...(readOnly
      ? []
      : [
          {
            key: 'actions',
            title: '',
            hideable: false as const,
            render: (a: (typeof data.roleAssignments)[number]) => (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !writesArmed}
                onClick={() => void run('removeRoleAssignment', { id: a.id })}
              >
                Revoke
              </Button>
            ),
          },
        ]),
  ];

  const locationColumns: Array<DataTableColumn<(typeof data.locations)[number]>> = [
    { key: 'name', title: 'Location', hideable: false, render: (l) => l.name },
    {
      key: 'address',
      title: 'Address',
      render: (l) => <span className="nt-body-sm nt-hint-muted">{l.address ?? '—'}</span>,
    },
    { key: 'country', title: 'Country', render: (l) => l.country ?? '—' },
    ...(readOnly
      ? []
      : [
          {
            key: 'actions',
            title: '',
            hideable: false as const,
            render: (l: (typeof data.locations)[number]) => (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !writesArmed}
                onClick={() => void run('deleteLocation', { id: l.id })}
              >
                Delete
              </Button>
            ),
          },
        ]),
  ];

  return (
    <div className="nt-stack nt-recon-reveal nt-greenlake-shell nt-section-panel nt-plane-shell">
      <ScreenHeader
        overline="Govern / GreenLake"
        title="GreenLake workspace"
        subtitle={`Workspace members, locations and role grants, plus the ${lab ? 'direct' : 'reviewed'} changes this credential may make. Subscriptions are reconciled on Licences.`}
        actions={
          <>
            <Badge plane>GreenLake</Badge>
            {/* Inventory only lands from the linked plane — never fixtures. */}
            <Badge tone="info">LIVE</Badge>
            <span
              className="nt-mono-label"
            >
              {data.source.toUpperCase()}
            </span>
            <Badge tone={readOnly ? 'neutral' : lab ? 'warning' : 'accent'}>
              {readOnly ? 'read only — no write scope' : lab ? 'direct writes' : 'reviewed writes'}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => copySectionLink(focusSection)}>
              Copy view link
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!has('users') || filteredUsers.length === 0}
              onClick={() => {
                const n = exportTableCsv(
                  'greenlake-users.csv',
                  ['id', 'username', 'firstName', 'lastName', 'status', 'lastLogin'],
                  filteredUsers.map((u) => [
                    u.id,
                    u.username,
                    u.firstName ?? '',
                    u.lastName ?? '',
                    u.status ?? '',
                    u.lastLogin ?? '',
                  ]),
                );
                toast(`Exported ${n} member${n === 1 ? '' : 's'}`, { tone: 'success' });
              }}
            >
              Export CSV
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!has('locations') || filteredLocations.length === 0}
              onClick={() => {
                const n = exportTableCsv(
                  'greenlake-locations.csv',
                  ['id', 'name', 'type', 'address', 'country', 'deviceCount'],
                  filteredLocations.map((l) => [
                    l.id,
                    l.name,
                    l.type ?? '',
                    l.address ?? '',
                    l.country ?? '',
                    l.deviceCount == null ? '' : String(l.deviceCount),
                  ]),
                );
                toast(`Exported ${n} location${n === 1 ? '' : 's'}`, { tone: 'success' });
              }}
            >
              Export locations
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!has('roleAssignments') || filteredRoles.length === 0}
              onClick={() => {
                const n = exportTableCsv(
                  'greenlake-role-assignments.csv',
                  ['id', 'principal', 'principalType', 'principalName', 'role', 'roleGrn', 'scope', 'source'],
                  filteredRoles.map((r) => [
                    r.id,
                    r.principal,
                    r.principalType,
                    r.principalName ?? '',
                    r.role,
                    r.roleGrn,
                    r.scope.join('; '),
                    r.source ?? '',
                  ]),
                );
                toast(`Exported ${n} role assignment${n === 1 ? '' : 's'}`, { tone: 'success' });
              }}
            >
              Export roles
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!has('users') && !has('locations') && !has('roleAssignments')}
              onClick={() => {
                void (async () => {
                  const part = sectionToExportPart(focusSection);
                  const filename =
                    part === 'locations'
                      ? 'greenlake-locations.csv'
                      : part === 'roles'
                        ? 'greenlake-roles.csv'
                        : 'greenlake-users.csv';
                  const qs = new URLSearchParams({ part });
                  if (q.trim()) qs.set('q', q.trim());
                  if (part === 'users' && userStatus !== 'all') qs.set('status', userStatus);
                  const res = await downloadApiCsv(
                    `/api/greenlake/export?${qs.toString()}`,
                    filename,
                  );
                  if (res.ok) {
                    const filterBits = [
                      q.trim() ? `q=${q.trim()}` : null,
                      part === 'users' && userStatus !== 'all' ? `status=${userStatus}` : null,
                    ].filter(Boolean);
                    toast('Server CSV downloaded', {
                      description: `${filename} — cached GreenLake ${part} slice${
                        filterBits.length ? ` (${filterBits.join(', ')})` : ''
                      }.`,
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
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Refresh
            </Button>
          </>
}
      />

      <div className="nt-status-ribbon nt-greenlake-ribbon" role="status" aria-label="GreenLake status ribbon">
        <span className="nt-status-ribbon__item">cloud · ECG live</span>
        <span className="nt-status-ribbon__item">write ritual armed</span>
        <span className="nt-status-ribbon__item">planes monochrome</span>
      </div>


      {data.unavailable.length > 0 ? (
        <Alert
          tone="warning"
          title={`${data.unavailable.length} of 3 GreenLake sections could not be read`}
        >
          <span className="nt-body-sm">
            {data.unavailable.map((s) => SECTION_LABEL[s]).join(', ')} returned no data because the
            read failed — the tables below show what was actually readable, not an empty workspace.
          </span>
        </Alert>
      ) : null}

      {readOnly ? (
        <Alert tone="info" title="This workspace credential is read-only">
          <span className="nt-body-sm">
            No write scope is declared for the GreenLake credential, so member, location, device,
            subscription and role changes are hidden. Declare a write scope on the GreenLake
            connection in Connected systems to enable them.
          </span>
        </Alert>
      ) : null}

      {!readOnly && !lab ? (
        <Card className="nt-card--write-ritual" dataPhase={busy ? 'executing' : 'review'}>
          <Checkbox
            label="I have reviewed this write — apply with review confirmation (not a draft)."
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
          />
          <p className="nt-hint-muted nt-fs-12 nt-mt-8">
            Hardened mode will not send <span className="nt-mono-11">reviewConfirmed</span> until this
            box is ticked. Each successful action clears the checkbox so the next change is reviewed
            on its own.
          </p>
        </Card>
      ) : null}

      <div className="nt-filter-bar nt-sticky-filters nt-gap-8">
        <div className="nt-filter-field nt-min-w-200">
          <Input
            size="sm"
            mono
            placeholder="Filter members, roles, locations…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter GreenLake workspace"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--md">
          <Select
            options={statusOptions}
            value={userStatus}
            onValueChange={setUserStatus}
            size="sm"
            aria-label="Member status"
          />
        </div>
      </div>

      {statusChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Member status">
          <span className="nt-chip-row__label">Status</span>
          {statusChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setUserStatus(userStatus.toLowerCase() === c.key.toLowerCase() ? 'all' : c.key)}
              className={
                userStatus.toLowerCase() === c.key.toLowerCase() ? 'nt-chip nt-chip--active' : 'nt-chip'
              }
              aria-pressed={userStatus.toLowerCase() === c.key.toLowerCase()}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {idsFilter !== null ? (
        <div className="nt-chip-row" role="group" aria-label="Selection deep link">
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('ids');
              setSearchParams(next, { replace: true });
              setSelectedMemberKeys([]);
            }}
            title={idsFilter.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {idsPresent === idsFilter.length
              ? `${idsFilter.length} selected member${idsFilter.length === 1 ? '' : 's'}`
              : `${idsPresent} of ${idsFilter.length} selected members present`}
            {' — clear'}
          </button>
        </div>
      ) : null}

      {roleIdsFilter !== null ? (
        <div className="nt-chip-row" role="group" aria-label="Role grant selection deep link">
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('roleIds');
              setSearchParams(next, { replace: true });
              setSelectedRoleKeys([]);
            }}
            title={roleIdsFilter.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {roleIdsPresent === roleIdsFilter.length
              ? `${roleIdsFilter.length} selected role grant${roleIdsFilter.length === 1 ? '' : 's'}`
              : `${roleIdsPresent} of ${roleIdsFilter.length} selected role grants present`}
            {' — clear'}
          </button>
        </div>
      ) : null}

      {locationIdsFilter !== null ? (
        <div className="nt-chip-row" role="group" aria-label="Location selection deep link">
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('locationIds');
              setSearchParams(next, { replace: true });
              setSelectedLocationKeys([]);
            }}
            title={locationIdsFilter.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {locationIdsPresent === locationIdsFilter.length
              ? `${locationIdsFilter.length} selected location${locationIdsFilter.length === 1 ? '' : 's'}`
              : `${locationIdsPresent} of ${locationIdsFilter.length} selected locations present`}
            {' — clear'}
          </button>
        </div>
      ) : null}

      {/* -- Members ---------------------------------------------------- */}
      <div id={sectionDomId('users')}>
        <div className="nt-filter-bar nt-gap-8">
          <SectionHeader
            label="Workspace members"
            meta={
              has('users')
                ? filteredUsers.length === data.users.length
                  ? `${data.users.length} MEMBERS`
                  : `${filteredUsers.length} of ${data.users.length}`
                : 'UNAVAILABLE'
            }
          />
          <Button
            variant="ghost"
            size="sm"
            className="nt-ml-auto"
            onClick={() => copySectionLink('users')}
          >
            Copy section link
          </Button>
          {has('users') && filteredUsers.length > 0 ? (
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          ) : null}
        </div>
        {has('users') ? (
          filteredUsers.length === 0 ? (
            <EmptyState
              title={
                idsFilter !== null
                  ? 'No members match this selection'
                  : 'Nothing matches that filter'
              }
              description={
                idsFilter !== null
                  ? 'Clear the selection filter to restore workspace members under the current search / status filters.'
                  : 'Loosen the search or status filter to widen members, roles, and locations.'
              }
            >
              {data.users.length > 0 && idsFilter !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('ids');
                    setSearchParams(next, { replace: true });
                    setSelectedMemberKeys([]);
                  }}
                >
                  Clear selection filter
                </Button>
              ) : data.users.length > 0 && (q.trim() || userStatus !== 'all') ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setQ('');
                    setUserStatus('all');
                    setSelectedMemberKeys([]);
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </EmptyState>
          ) : (
            <DataTable
              ariaLabel="Workspace members"
              density={density}
              columns={memberColumns}
              rows={filteredUsers}
              rowKey={(u) => u.id}
              selectedKeys={selectedMemberKeys}
              onSelectionChange={setSelectedMemberKeys}
              rowTone={(u) => (u.status === 'VERIFIED' ? 'success' : 'warning')}
            />
          )
        ) : (
          <SectionFailure data={data} section="users" />
        )}
        {has('users') && selectedMemberKeys.length > 0 ? (
          <div
            className="nt-configure-bulk-bar nt-bulk-glass"
            role="region"
            aria-label="Workspace member selection actions"
          >
            <span className="nt-configure-bulk-bar__count">{`${selectedMemberKeys.length} SELECTED`}</span>
            <span className="nt-configure-bulk-bar__hint">
              export, copy emails or display names, or share a selection link for only the members you marked — full list export stays in the header
            </span>
            <span className="nt-configure-bulk-bar__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const selected = new Set(selectedMemberKeys);
                  const picked = filteredUsers.filter((u) => selected.has(u.id));
                  if (picked.length === 0) {
                    toast('No selected members still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const n = exportTableCsv(
                    'greenlake-members-selected.csv',
                    ['id', 'username', 'firstName', 'lastName', 'status', 'lastLogin'],
                    picked.map((u) => [
                      u.id,
                      u.username,
                      u.firstName ?? '',
                      u.lastName ?? '',
                      u.status ?? '',
                      u.lastLogin ?? '',
                    ]),
                  );
                  toast(`Exported ${countOf(n, 'selected member')}`, {
                    description: 'greenlake-members-selected.csv — directory fields only.',
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
                    const selected = new Set(selectedMemberKeys);
                    const picked = filteredUsers.filter((u) => selected.has(u.id));
                    if (picked.length === 0) {
                      toast('No selected members still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const emails = [
                      ...new Set(
                        picked
                          .map((u) => (u.username ?? '').trim())
                          .filter((email) => email && email !== '—'),
                      ),
                    ];
                    if (emails.length === 0) {
                      toast('No emails on the selected members', {
                        description: 'Those rows did not publish a username — use Copy names or export CSV instead.',
                        tone: 'info',
                      });
                      return;
                    }
                    const text = emails.join('\n');
                    try {
                      await navigator.clipboard.writeText(text);
                      toast(`Copied ${countOf(emails.length, 'email')}`, {
                        description:
                          emails.length < picked.length
                            ? `${picked.length - emails.length} selected without a username skipped`
                            : 'newline-joined · paste into invite lists or a ticket',
                        tone: 'success',
                      });
                    } catch {
                      toast('Could not copy emails', { description: text, tone: 'warning' });
                    }
                  })();
                }}
              >
                Copy emails
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const selected = new Set(selectedMemberKeys);
                    const picked = filteredUsers.filter((u) => selected.has(u.id));
                    if (picked.length === 0) {
                      toast('No selected members still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const names = [
                      ...new Set(
                        picked
                          .map((u) => [u.firstName, u.lastName].filter(Boolean).join(' ').trim())
                          .filter((name) => name && name !== '—'),
                      ),
                    ];
                    if (names.length === 0) {
                      toast('No names on the selected members', {
                        description: 'Those rows did not publish a display name — export CSV for emails instead.',
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
                            ? `${picked.length - names.length} selected without a display name skipped`
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
                    const selected = new Set(selectedMemberKeys);
                    const picked = filteredUsers.filter((u) => selected.has(u.id));
                    if (picked.length === 0) {
                      toast('No selected members still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const next = new URLSearchParams(searchParams);
                    next.set('ids', picked.map((u) => u.id).join('\n'));
                    /* Keep members section focus so a colleague lands on the roster. */
                    if (!next.get('section')) next.set('section', 'users');
                    const qs = next.toString();
                    const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                    try {
                      await navigator.clipboard.writeText(url);
                      toast('Selection link copied', {
                        description: `${picked.length} member${picked.length === 1 ? '' : 's'} · ids=`,
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
              <Button variant="ghost" size="sm" onClick={() => setSelectedMemberKeys([])}>
                Clear
              </Button>
            </span>
          </div>
        ) : null}
      </div>

      {readOnly ? null : (
        <Card className="nt-card--write-ritual" dataPhase={busy ? 'executing' : 'review'}>
          <div className="nt-wrap-6 nt-end-align">
            <Field
              label="Invite by email"
              value={inviteEmail}
              onChange={setInviteEmail}
              placeholder="person@example.com"
              width={260}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !writesArmed || inviteEmail.trim() === ''}
              onClick={() => void run('inviteUser', { email: inviteEmail.trim() }, () => setInviteEmail(''))}
            >
              Send invite
            </Button>
            <span className="nt-body-sm nt-hint-muted">
              GreenLake emails the invitation immediately — this is not a draft.
            </span>
          </div>
        </Card>
      )}

      {/* -- Role grants ------------------------------------------------ */}
      <div id={sectionDomId('roleAssignments')}>
        <div className="nt-filter-bar nt-gap-8">
          <SectionHeader
            label="Role grants"
            meta={
              has('roleAssignments')
                ? filteredRoles.length === data.roleAssignments.length
                  ? `${data.roleAssignments.length} GRANTS`
                  : `${filteredRoles.length} of ${data.roleAssignments.length}`
                : 'UNAVAILABLE'
            }
          />
          <Button
            variant="ghost"
            size="sm"
            className="nt-ml-auto"
            onClick={() => copySectionLink('roleAssignments')}
          >
            Copy section link
          </Button>
        </div>
        {has('roleAssignments') ? (
          filteredRoles.length === 0 ? (
            <EmptyState
              title={
                roleIdsFilter !== null
                  ? 'No role grants match this selection'
                  : 'Nothing matches that filter'
              }
              description={
                roleIdsFilter !== null
                  ? 'Clear the selection filter to restore role grants under the current search filter.'
                  : 'Loosen the search to widen role grants.'
              }
            >
              {data.roleAssignments.length > 0 && roleIdsFilter !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('roleIds');
                    setSearchParams(next, { replace: true });
                    setSelectedRoleKeys([]);
                  }}
                >
                  Clear selection filter
                </Button>
              ) : data.roleAssignments.length > 0 && q.trim() ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setQ('');
                    setSelectedRoleKeys([]);
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </EmptyState>
          ) : (
            <DataTable
              ariaLabel="Role grants"
              density={density}
              columns={roleColumns}
              rows={filteredRoles}
              rowKey={(a) => a.id}
              selectedKeys={selectedRoleKeys}
              onSelectionChange={setSelectedRoleKeys}
            />
          )
        ) : (
          <SectionFailure data={data} section="roleAssignments" />
        )}
        {has('roleAssignments') && selectedRoleKeys.length > 0 ? (
          <div
            className="nt-configure-bulk-bar nt-bulk-glass"
            role="region"
            aria-label="Role grant selection actions"
          >
            <span className="nt-configure-bulk-bar__count">{`${selectedRoleKeys.length} SELECTED`}</span>
            <span className="nt-configure-bulk-bar__hint">
              export, copy principals or role names, or share a selection link for only the grants you
              marked — full list export stays in the header
            </span>
            <span className="nt-configure-bulk-bar__actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const selected = new Set(selectedRoleKeys);
                  const picked = filteredRoles.filter((r) => selected.has(r.id));
                  if (picked.length === 0) {
                    toast('No selected role grants still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const n = exportTableCsv(
                    'greenlake-role-grants-selected.csv',
                    [
                      'id',
                      'principal',
                      'principalType',
                      'principalName',
                      'role',
                      'roleGrn',
                      'scope',
                      'source',
                    ],
                    picked.map((r) => [
                      r.id,
                      r.principal,
                      r.principalType,
                      r.principalName ?? '',
                      r.role,
                      r.roleGrn,
                      r.scope.join('; '),
                      r.source ?? '',
                    ]),
                  );
                  toast(`Exported ${countOf(n, 'selected role grant')}`, {
                    description: 'greenlake-role-grants-selected.csv — grant fields only.',
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
                    const selected = new Set(selectedRoleKeys);
                    const picked = filteredRoles.filter((r) => selected.has(r.id));
                    if (picked.length === 0) {
                      toast('No selected role grants still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const principals = [
                      ...new Set(
                        picked
                          .map((r) => (r.principalName ?? r.principal ?? '').trim())
                          .filter((p) => p && p !== '—'),
                      ),
                    ];
                    if (principals.length === 0) {
                      toast('No principals on the selected grants', {
                        description:
                          'Those rows did not publish a principal — use Copy names or export CSV instead.',
                        tone: 'info',
                      });
                      return;
                    }
                    const text = principals.join('\n');
                    try {
                      await navigator.clipboard.writeText(text);
                      toast(`Copied ${countOf(principals.length, 'principal')}`, {
                        description:
                          principals.length < picked.length
                            ? `${picked.length - principals.length} selected without a principal skipped`
                            : 'newline-joined · paste into access reviews or a ticket',
                        tone: 'success',
                      });
                    } catch {
                      toast('Could not copy principals', { description: text, tone: 'warning' });
                    }
                  })();
                }}
              >
                Copy principals
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const selected = new Set(selectedRoleKeys);
                    const picked = filteredRoles.filter((r) => selected.has(r.id));
                    if (picked.length === 0) {
                      toast('No selected role grants still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const names = [
                      ...new Set(
                        picked
                          .map((r) => (r.role ?? '').trim())
                          .filter((name) => name.length > 0 && name !== '—'),
                      ),
                    ];
                    if (names.length === 0) {
                      toast('No names on the selected grants', {
                        description:
                          'Those rows did not publish a role label — use Copy principals or export CSV instead.',
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
                            ? `${picked.length - names.length} selected without a role label skipped`
                            : 'newline-joined role labels · paste into access reviews or a ticket',
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
                    const selected = new Set(selectedRoleKeys);
                    const picked = filteredRoles.filter((r) => selected.has(r.id));
                    if (picked.length === 0) {
                      toast('No selected role grants still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const next = new URLSearchParams(searchParams);
                    next.set('roleIds', picked.map((r) => r.id).join('\n'));
                    next.set('section', 'roles');
                    const qs = next.toString();
                    const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                    try {
                      await navigator.clipboard.writeText(url);
                      toast('Selection link copied', {
                        description: `${picked.length} role grant${picked.length === 1 ? '' : 's'} · roleIds=`,
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
              <Button variant="ghost" size="sm" onClick={() => setSelectedRoleKeys([])}>
                Clear
              </Button>
            </span>
          </div>
        ) : null}
      </div>

      {readOnly ? null : (
        <Card className="nt-card--write-ritual" dataPhase={busy ? 'executing' : 'review'}>
          <div className="nt-wrap-6 nt-end-align">
            <Field
              label="Principal"
              value={rolePrincipal}
              onChange={setRolePrincipal}
              placeholder="user:6aec904ab3a1…"
              width={230}
            />
            <Field
              label="Role GRN"
              value={roleGrn}
              onChange={setRoleGrn}
              placeholder="grn:glp/providers/authorization/roles/ccs.operator"
              width={330}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !writesArmed || rolePrincipal.trim() === '' || roleGrn.trim() === ''}
              onClick={() =>
                void run('assignRole', { principal: rolePrincipal.trim(), role: roleGrn.trim() }, () => {
                  setRolePrincipal('');
                  setRoleGrn('');
                })
              }
            >
              Grant role
            </Button>
          </div>
          <span className="nt-body-sm nt-hint-muted">
            GreenLake withdrew its role-catalogue endpoint from the public API, so the portal cannot
            offer a role picker — copy the role GRN from the GreenLake console. Grants apply to this
            workspace.
          </span>
        </Card>
      )}

      {/* -- Locations -------------------------------------------------- */}
      <div id={sectionDomId('locations')}>
      <div className="nt-filter-bar nt-gap-8">
        <SectionHeader
          label="Locations"
          meta={
            has('locations')
              ? filteredLocations.length === data.locations.length
                ? `${data.locations.length} LOCATIONS`
                : `${filteredLocations.length} of ${data.locations.length}`
              : 'UNAVAILABLE'
          }
        />
        <Button
          variant="ghost"
          size="sm"
          className="nt-ml-auto"
          onClick={() => copySectionLink('locations')}
        >
          Copy section link
        </Button>
      </div>
      {has('locations') ? (
        data.locations.length === 0 ? (
          <Alert tone="info" title="This workspace has no locations">
            <span className="nt-body-sm">
              The locations feed was read successfully and returned nothing — the workspace genuinely
              has none defined yet.
            </span>
          </Alert>
        ) : filteredLocations.length === 0 ? (
          <EmptyState
            title={
              locationIdsFilter !== null
                ? 'No locations match this selection'
                : 'Nothing matches that filter'
            }
            description={
              locationIdsFilter !== null
                ? 'Clear the selection filter to restore locations under the current search filter.'
                : 'Loosen the search to widen locations.'
            }
          >
            {data.locations.length > 0 && locationIdsFilter !== null ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('locationIds');
                  setSearchParams(next, { replace: true });
                  setSelectedLocationKeys([]);
                }}
              >
                Clear selection filter
              </Button>
            ) : data.locations.length > 0 && q.trim() ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQ('');
                  setSelectedLocationKeys([]);
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <DataTable
            ariaLabel="Locations"
            density={density}
            columns={locationColumns}
            rows={filteredLocations}
            rowKey={(l) => l.id}
            selectedKeys={selectedLocationKeys}
            onSelectionChange={setSelectedLocationKeys}
          />
        )
      ) : (
        <SectionFailure data={data} section="locations" />
      )}
      {has('locations') && selectedLocationKeys.length > 0 ? (
        <div
          className="nt-configure-bulk-bar nt-bulk-glass"
          role="region"
          aria-label="Location selection actions"
        >
          <span className="nt-configure-bulk-bar__count">{`${selectedLocationKeys.length} SELECTED`}</span>
          <span className="nt-configure-bulk-bar__hint">
            export, copy names, or share a selection link for only the locations you marked — full list
            export stays in the header
          </span>
          <span className="nt-configure-bulk-bar__actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const selected = new Set(selectedLocationKeys);
                const picked = filteredLocations.filter((l) => selected.has(l.id));
                if (picked.length === 0) {
                  toast('No selected locations still in view', {
                    description: 'Clear selection or adjust filters.',
                    tone: 'info',
                  });
                  return;
                }
                const n = exportTableCsv(
                  'greenlake-locations-selected.csv',
                  ['id', 'name', 'type', 'address', 'country', 'deviceCount'],
                  picked.map((l) => [
                    l.id,
                    l.name,
                    l.type ?? '',
                    l.address ?? '',
                    l.country ?? '',
                    l.deviceCount == null ? '' : String(l.deviceCount),
                  ]),
                );
                toast(`Exported ${countOf(n, 'selected location')}`, {
                  description: 'greenlake-locations-selected.csv — directory fields only.',
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
                  const selected = new Set(selectedLocationKeys);
                  const picked = filteredLocations.filter((l) => selected.has(l.id));
                  if (picked.length === 0) {
                    toast('No selected locations still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const names = [
                    ...new Set(
                      picked
                        .map((l) => (l.name ?? '').trim())
                        .filter((name) => name && name !== '—'),
                    ),
                  ];
                  if (names.length === 0) {
                    toast('No names on the selected locations', {
                      description: 'Those rows did not publish a name — export CSV for ids instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const text = names.join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    toast(`Copied ${countOf(names.length, 'location name')}`, {
                      description:
                        names.length < picked.length
                          ? `${picked.length - names.length} selected without a name skipped`
                          : 'newline-joined · paste into a ticket or site handoff',
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
                  const selected = new Set(selectedLocationKeys);
                  const picked = filteredLocations.filter((l) => selected.has(l.id));
                  if (picked.length === 0) {
                    toast('No selected locations still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const next = new URLSearchParams(searchParams);
                  next.set('locationIds', picked.map((l) => l.id).join('\n'));
                  next.set('section', 'locations');
                  const qs = next.toString();
                  const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Selection link copied', {
                      description: `${picked.length} location${picked.length === 1 ? '' : 's'} · locationIds=`,
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
            <Button variant="ghost" size="sm" onClick={() => setSelectedLocationKeys([])}>
              Clear
            </Button>
          </span>
        </div>
      ) : null}

      {readOnly ? null : (
        <Card className="nt-card--write-ritual" dataPhase={busy ? 'executing' : 'review'}>
          <div className="nt-wrap-6 nt-end-align">
            <Field label="Name" value={locName} onChange={setLocName} placeholder="Campus-01" />
            <Field
              label="Street"
              value={locStreet}
              onChange={setLocStreet}
              placeholder="1 Example Way"
            />
            <Field label="City" value={locCity} onChange={setLocCity} placeholder="Houston" />
            <Field
              label="Postal code"
              value={locPostal}
              onChange={setLocPostal}
              placeholder="77001"
              width={120}
            />
            <Field
              label="Country"
              value={locCountry}
              onChange={setLocCountry}
              placeholder="United States"
              width={150}
            />
            <Field
              label="Primary contact"
              value={locContact}
              onChange={setLocContact}
              placeholder="user@example.com"
              width={200}
            />
            <Field
              label="Contact phone"
              value={locPhone}
              onChange={setLocPhone}
              placeholder="+15550000000"
              width={150}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={
                busy ||
                !writesArmed ||
                [locName, locStreet, locCity, locPostal, locCountry, locContact, locPhone].some(
                  (v) => v.trim() === '',
                )
              }
              onClick={() =>
                void run(
                  'createLocation',
                  {
                    name: locName.trim(),
                    streetAddress: locStreet.trim(),
                    city: locCity.trim(),
                    postalCode: locPostal.trim(),
                    country: locCountry.trim(),
                    contactName: locContact.trim(),
                    contactEmail: locContact.trim(),
                    contactPhone: locPhone.trim(),
                  },
                  () => {
                    setLocName('');
                    setLocStreet('');
                    setLocCity('');
                    setLocPostal('');
                    setLocCountry('');
                    setLocContact('');
                    setLocPhone('');
                  },
                )
              }
            >
              Create location
            </Button>
          </div>
          {/* Both constraints cost a failed round-trip to discover, so the form
              states them rather than letting GreenLake reject the submission. */}
          <p className="nt-hint-muted nt-fs-12 nt-mt-8">
            Country must be the full name (“United States”, not “US”). The primary contact must be
            an existing workspace member’s username — GreenLake rejects the location otherwise.
          </p>
        </Card>
      )}
      </div>

      {/* -- Devices & subscriptions ------------------------------------ */}
      {readOnly ? null : (
        <>
          <SectionHeader label="Add to the workspace" meta="DEVICES & SUBSCRIPTIONS" />
          <Card>
            <div className="nt-wrap-6 nt-end-align">
              <Field
                label="Device serial"
                value={devSerial}
                onChange={setDevSerial}
                placeholder="CNXXXXXXXX"
              />
              <Field
                label="MAC address"
                value={devMac}
                onChange={setDevMac}
                placeholder="00:11:22:33:44:55"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !writesArmed || devSerial.trim() === '' || devMac.trim() === ''}
                onClick={() =>
                  void run(
                    'addDevices',
                    { serialNumber: devSerial.trim(), macAddress: devMac.trim() },
                    () => {
                      setDevSerial('');
                      setDevMac('');
                    },
                  )
                }
              >
                Add device
              </Button>
            </div>
            <span className="nt-body-sm nt-hint-muted">
              GreenLake does not allow devices to be removed through its API, so an added device
              cannot be deleted from here.
            </span>
          </Card>
          <Card>
            <div className="nt-wrap-6 nt-end-align">
              <Field
                label="Subscription key"
                value={subKey}
                onChange={setSubKey}
                placeholder="Subscription key from HPE"
                width={260}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !writesArmed || subKey.trim() === ''}
                onClick={() => void run('addSubscription', { key: subKey.trim() }, () => setSubKey(''))}
              >
                Submit key
              </Button>
              <span className="nt-body-sm nt-hint-muted">
                GreenLake validates subscription keys asynchronously — a submitted key is not an
                added subscription until it appears on Licences.
              </span>
            </div>
          </Card>
        </>
      )}

      {/* Reference material and advisory panels sit below the data they
          describe. Rendered above it they pushed the primary table several
          hundred pixels down the page — on a queue screen the queue is what
          the operator came for, not the suggestions about it. */}
      <VisualReferencePanel target={{ kind: 'connector', id: 'greenlake', plane: 'GREENLAKE' }} />
      <ConfigRecommendationsPanel title="GreenLake / licence recommendations" category="inventory" limit={6} />
    </div>
  );
}
