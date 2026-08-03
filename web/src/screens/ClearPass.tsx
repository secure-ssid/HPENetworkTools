/**
 * web/src/screens/ClearPass.tsx — the endpoint policy screen.
 *
 * ClearPass owns two things the rest of the portal only borrows a slice of:
 * the endpoint repository (profiling — MAC, IP, hostname, category, OS,
 * enforcement profile) and the RADIUS auth feed (already the dedicated
 * /auth-events screen). This screen puts the repository front and centre with
 * a filterable table, and keeps a compact tail of the same auth feed so an
 * operator does not have to leave the plane's screen to see why an endpoint
 * was just quarantined.
 *
 * Behind those two, a SegmentedControl tab strip holds the CPPM's policy
 * inventories: the NADs that authenticate to it, its auth sources, roles,
 * enforcement policies→profiles, local users (whitelisted identity fields
 * only — no password material exists in this payload), and the service
 * definitions themselves (enabled state, template, hit count, match rules —
 * whitelisted the same way; nothing in a service row is credential
 * material). Each collection rides the envelope only when the plane reported
 * it, so every tab keeps the three states distinct: reported rows / a real
 * empty answer / "not reported by this CPPM". Services populate wherever the
 * box answers /api/config/service (6.11+) or the legacy /api/service — the
 * demo estate's 6.11 CPPM included; device groups stay the collection that
 * reads "not available on this CPPM" in both modes. A service row opens a
 * detail drawer with the full definition (summary, match rules,
 * authentication, authorization, enforcement, options), read on demand from
 * GET /api/clearpass/services/:id — the one per-service read this screen
 * spends, TTL-cached and budget-gated on the server, never polled.
 *
 * The Endpoints and Local users tabs also WRITE — the only two CPPM datasets
 * the portal touches (policy stays in ClearPass): 'Register endpoint' and a
 * per-row edit (status + operator note), 'Add local user' and a per-row edit
 * (display name, role from the reported roles, enabled, and a write-only
 * password that is never displayed, echoed, or read back). Every write goes
 * through the same reviewed drawer the SSID editor set — an exact summary of
 * what will be written, an explicit review checkbox standing in for a
 * ticket, and the server's apply→verify→audit result shown verbatim. Demo
 * mode applies the write to the fixture world the screen is already showing
 * and says plainly that nothing left the portal; live mode re-fetches the
 * screen after a landed write and says so when the server's cache refresh
 * could not confirm the lists are current.
 *
 * Data: getClearPass() — live /api/clearpass when the server is up, fixtures
 * otherwise (see web/src/api/screens.ts).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  EmptyState,
  FormField,
  Input,
  SectionHeader,
  SegmentedControl,
  Select,
  Spinner,
  Switch,
  Table,
  Textarea,
  useToast,
} from '../nightdesk';
import { getClearPass, getClearPassServiceDetail } from '../api/client';
import type { ClearPassData, ClearPassServiceDetailResult } from '../api/client';
import {
  registerClearPassEndpoint,
  updateClearPassEndpoint,
  createClearPassLocalUser,
  updateClearPassLocalUser,
} from '../api/clearpass';
import { isApiError } from '../api/core';
import { useSettings } from '../app/SettingsContext';
import { useLabConfigMode } from '../hooks/useLabConfigMode';
import { hhmmssLocal, hhmmLocal, formatCount, normalizeMac, detailState } from '@hpe/shared';
import {
  CLEARPASS_ENDPOINT_STATUSES,
  type ClearPassAuthSourceRow,
  type ClearPassDeviceGroupRow,
  type ClearPassEndpointRegisterForm,
  type ClearPassEndpointStatus,
  type ClearPassEndpointUpdateForm,
  type ClearPassEnforcementPolicyRow,
  type ClearPassEnforcementProfileRow,
  type ClearPassLocalUserCreateForm,
  type ClearPassLocalUserRow,
  type ClearPassLocalUserUpdateForm,
  type ClearPassNetworkDeviceRow,
  type ClearPassRoleRow,
  type ClearPassServiceDetailLive,
  type ClearPassServiceRow,
  type ClearPassWriteResult,
  type EndpointRow,
  type StatDef,
  type Tone,
} from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';

type ClearPassTab = 'endpoints' | 'auth' | 'network' | 'sources' | 'roles' | 'enforcement' | 'users' | 'services';

const TAB_OPTIONS: Array<{ value: ClearPassTab; label: string }> = [
  { value: 'endpoints', label: 'Endpoints' },
  { value: 'auth', label: 'Auth events' },
  { value: 'network', label: 'Network devices' },
  { value: 'sources', label: 'Auth sources' },
  { value: 'roles', label: 'Roles' },
  { value: 'enforcement', label: 'Enforcement' },
  { value: 'users', label: 'Local users' },
  { value: 'services', label: 'Services' },
];

const STATUS_TONE: Record<string, Tone> = {
  Known: 'success',
  Unknown: 'warning',
  Disabled: 'neutral',
};

function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? 'neutral';
}

function uniq(values: Array<string | null>): string[] {
  return values.filter((v): v is string => v !== null).filter((v, i, a) => a.indexOf(v) === i);
}

export default function ClearPass() {
  const navigate = useNavigate();
  const { density } = useSettings();
  const { lab } = useLabConfigMode();
  const [data, setData] = useState<ClearPassData | null>(null);
  const [tab, setTab] = useState<ClearPassTab>('endpoints');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [category, setCategory] = useState('all');

  useEffect(() => {
    let live = true;
    void getClearPass().then((d) => {
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

  return (
    <ClearPassView
      data={data}
      navigate={navigate}
      density={density}
      lab={lab}
      tab={tab}
      setTab={setTab}
      q={q}
      setQ={setQ}
      status={status}
      setStatus={setStatus}
      category={category}
      setCategory={setCategory}
      reload={async () => setData(await getClearPass())}
      mergeDemo={(fn) => setData((current) => (current ? fn(current) : current))}
    />
  );
}

/** Which reviewed write drawer is open (null = none). */
type WriteDrawerState =
  | { kind: 'register' }
  | { kind: 'editEndpoint'; row: EndpointRow }
  | { kind: 'createUser' }
  | { kind: 'editUser'; row: ClearPassLocalUserRow }
  | null;

function ClearPassView({
  data,
  navigate,
  density,
  lab,
  tab,
  setTab,
  q,
  setQ,
  status,
  setStatus,
  category,
  setCategory,
  reload,
  mergeDemo,
}: {
  data: ClearPassData;
  navigate: ReturnType<typeof useNavigate>;
  density: 'comfortable' | 'compact';
  lab: boolean;
  tab: ClearPassTab;
  setTab: (v: ClearPassTab) => void;
  q: string;
  setQ: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  /** Live mode: re-fetch the whole envelope after a landed write. */
  reload: () => Promise<void>;
  /** Demo mode: apply the reviewed write to the fixture world on screen. */
  mergeDemo: (fn: (d: ClearPassData) => ClearPassData) => void;
}) {
  const [writeDrawer, setWriteDrawer] = useState<WriteDrawerState>(null);
  /** The service whose detail drawer is open (null = none). */
  const [serviceView, setServiceView] = useState<ClearPassServiceRow | null>(null);
  const demo = data.dataSource === 'demo';
  const endpoints = data.endpoints;
  const authEvents = data.authEvents;
  const missingSources = data.missingSources ?? [];

  const stats = useMemo<StatDef[]>(() => {
    const known = endpoints.filter((e) => e.status === 'Known').length;
    const unknown = endpoints.filter((e) => e.status === 'Unknown').length;
    const disabled = endpoints.filter((e) => e.status === 'Disabled').length;
    const total = endpoints.length;
    const pct = total > 0 ? Math.round((known / total) * 100) : 0;
    return [
      { label: 'Total endpoints', value: String(total), delta: 'endpoint repository', tone: 'neutral' },
      { label: 'Known', value: String(known), delta: `${pct}% of repository`, tone: 'positive' },
      { label: 'Unknown', value: String(unknown), delta: unknown > 0 ? 'needs profiling' : 'none unknown', tone: unknown > 0 ? 'negative' : 'neutral' },
      { label: 'Disabled', value: String(disabled), delta: 'access revoked', tone: 'neutral' },
      // A live count comes out of the poller's ≤200-event page — minutes of
      // traffic, not a day. Only the fixture feed is a 24h cut (the same rule
      // AuthEvents words its live fail-reason bars by).
      { label: 'Auth events', value: String(authEvents.length), delta: data.dataSource === 'live' ? 'current poller snapshot' : 'last 24h', tone: 'neutral' },
    ];
  }, [endpoints, authEvents, data.dataSource]);

  const ql = q.trim().toLowerCase();
  const rows = endpoints.filter(
    (e) =>
      (status === 'all' || e.status === status) &&
      (category === 'all' || e.category === category) &&
      (!ql || (e.hostname ?? '' ).toLowerCase().includes(ql) || e.mac.toLowerCase().includes(ql) || (e.ip ?? '').toLowerCase().includes(ql)),
  );

  const statusOptions = [{ value: 'all', label: 'All statuses' }].concat(
    uniq(endpoints.map((e) => e.status)).map((v) => ({ value: v, label: v })),
  );
  const categoryOptions = [{ value: 'all', label: 'All categories' }].concat(
    uniq(endpoints.map((e) => e.category)).map((v) => ({ value: v, label: v })),
  );

  const recentAuth = authEvents.slice(0, 20);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Operate / ClearPass"
        title="ClearPass"
        subtitle="Endpoint policy, profiling, and authentication from HPE ClearPass."
        actions={
          <>
            {data.dataSource === 'live' ? <Badge tone="info">LIVE</Badge> : null}
            <Button variant="ghost" size="sm" onClick={() => navigate('/auth-events')}>
              Auth events →
            </Button>
          </>
        }
      />

      <StatRow stats={stats} />

      {missingSources.length > 0 ? (
        <Alert
          tone="warning"
          title={`${missingSources.length} linked plane${
            missingSources.length === 1 ? '' : 's'
          } contributed no ClearPass data: ${missingSources.join(', ')}`}
        >
          <span style={{ fontSize: 13 }}>
            The endpoint repository or auth feed has not come back from this plane — treat the counts above as
            a lower bound, not the whole estate.
          </span>
        </Alert>
      ) : null}

      <SegmentedControl options={TAB_OPTIONS} value={tab} onValueChange={(v) => setTab(v as ClearPassTab)} ariaLabel="ClearPass sections" />

      {tab === 'endpoints' ? (
        <>
          <SectionHeader label="Endpoint repository" meta={`${rows.length} of ${endpoints.length} shown`} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ width: 250 }}>
              <Input
                size="sm"
                mono
                placeholder="hostname, MAC, IP…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Filter endpoints"
              />
            </div>
            <div style={{ width: 160 }}>
              <Select options={statusOptions} value={status} onValueChange={setStatus} size="sm" aria-label="Status" />
            </div>
            <div style={{ width: 180 }}>
              <Select
                options={categoryOptions}
                value={category}
                onValueChange={setCategory}
                size="sm"
                aria-label="Category"
              />
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <Button variant="secondary" size="sm" onClick={() => setWriteDrawer({ kind: 'register' })}>
                Register endpoint
              </Button>
            </div>
          </div>

          {rows.length === 0 ? (
            endpoints.length === 0 ? (
              <EmptyState
                title="No endpoints from any policy plane"
                description={
                  data.dataSource === 'live'
                    ? 'ClearPass has not returned endpoint rows yet — check Connected systems.'
                    : 'No policy plane has an endpoint repository linked.'
                }
              >
                {data.dataSource === 'live' ? (
                  <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                    Connected systems
                  </Button>
                ) : null}
              </EmptyState>
            ) : (
              <EmptyState
                title="Nothing matches that filter"
                description="Loosen the search, status or category filter to see more of the repository."
              />
            )
          ) : (
            <Table density={density}>
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell>MAC</Table.HeaderCell>
                  <Table.HeaderCell>Hostname</Table.HeaderCell>
                  <Table.HeaderCell>IP</Table.HeaderCell>
                  <Table.HeaderCell>Category</Table.HeaderCell>
                  <Table.HeaderCell>OS / Family</Table.HeaderCell>
                  <Table.HeaderCell>Profile</Table.HeaderCell>
                  <Table.HeaderCell>Updated</Table.HeaderCell>
                  <Table.HeaderCell>{/* edit */}</Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {rows.map((e) => (
                  <EndpointTableRow
                    key={e.id}
                    row={e}
                    onOpenAuth={() => navigate(`/auth-events?q=${encodeURIComponent(e.mac)}`)}
                    onEdit={() => setWriteDrawer({ kind: 'editEndpoint', row: e })}
                  />
                ))}
              </Table.Body>
            </Table>
          )}
        </>
      ) : null}

      {tab === 'auth' ? (
        <>
          <SectionHeader label="Recent auth events" meta="LAST 20" />
          {recentAuth.length === 0 ? (
            <EmptyState
              title="No auth events in this window"
              description="ClearPass has not recorded a RADIUS decision recently."
            />
          ) : (
            <Table density={density}>
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell>Time</Table.HeaderCell>
                  <Table.HeaderCell>Result</Table.HeaderCell>
                  <Table.HeaderCell>Username</Table.HeaderCell>
                  <Table.HeaderCell>MAC</Table.HeaderCell>
                  <Table.HeaderCell>Method</Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {recentAuth.map((ev, i) => (
                  <Table.Row key={`${ev.time}-${i}`}>
                    <Table.Cell>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 'var(--nd-text-11)',
                          color: 'var(--nd-text-muted)',
                        }}
                      >
                        {ev.at ? hhmmssLocal(ev.at) : ev.time}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge tone={ev.tone} dot>
                        {ev.result}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>{ev.who}</Table.Cell>
                    <Table.Cell>
                      <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)' }}>{ev.mac}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 10.5, color: 'var(--nd-text-secondary)' }}>
                        {ev.method}
                      </span>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
          <div>
            <Button variant="ghost" size="sm" onClick={() => navigate('/auth-events')}>
              View full auth events →
            </Button>
          </div>
        </>
      ) : null}

      {tab === 'network' ? <NetworkDevicesSection rows={data.networkDevices} density={density} /> : null}
      {tab === 'sources' ? <AuthSourcesSection rows={data.authSources} density={density} /> : null}
      {tab === 'roles' ? <RolesSection rows={data.roles} density={density} /> : null}
      {tab === 'enforcement' ? (
        <EnforcementSection policies={data.enforcementPolicies} profiles={data.enforcementProfiles} density={density} />
      ) : null}
      {tab === 'users' ? (
        <LocalUsersSection
          rows={data.localUsers}
          density={density}
          onAdd={() => setWriteDrawer({ kind: 'createUser' })}
          onEdit={(row) => setWriteDrawer({ kind: 'editUser', row })}
        />
      ) : null}
      {tab === 'services' ? (
        <ServicesSection services={data.services} deviceGroups={data.deviceGroups} density={density} onView={setServiceView} />
      ) : null}

      {/* The service detail drawer — a READ, mounted only while open (keyed
          by the service id) so its fetch state starts fresh per opening,
          exactly like the write drawers below. */}
      {serviceView ? (
        <ServiceDetailDrawer
          key={serviceView.id}
          row={serviceView}
          onOpenChange={(v) => {
            if (!v) setServiceView(null);
          }}
        />
      ) : null}

      {/* The reviewed write drawers — endpoints and local users are the only
          two CPPM datasets the portal writes; policy stays in ClearPass. Each
          mounts only while open (keyed by the row it edits), so its form
          state starts fresh per opening — no reset effects. */}
      {writeDrawer?.kind === 'register' ? (
        <RegisterEndpointDrawer
          onOpenChange={(v) => {
            if (!v) setWriteDrawer(null);
          }}
          demo={demo}
          lab={lab}
          onDemoApplied={(form) => mergeDemo((d) => ({ ...d, endpoints: [...d.endpoints, demoEndpointRowFor(form)] }))}
          reload={reload}
        />
      ) : null}
      {writeDrawer?.kind === 'editEndpoint' ? (
        <EditEndpointDrawer
          key={writeDrawer.row.id}
          row={writeDrawer.row}
          onOpenChange={(v) => {
            if (!v) setWriteDrawer(null);
          }}
          demo={demo}
          lab={lab}
          onDemoApplied={(row, form) =>
            mergeDemo((d) => ({
              ...d,
              endpoints: d.endpoints.map((e) =>
                e.id === row.id
                  ? {
                      ...e,
                      ...(form.status !== undefined ? { status: form.status } : {}),
                      ...(form.description !== undefined ? { description: form.description || null } : {}),
                    }
                  : e,
              ),
            }))
          }
          reload={reload}
        />
      ) : null}
      {writeDrawer?.kind === 'createUser' ? (
        <LocalUserWriteDrawer
          mode="create"
          onOpenChange={(v) => {
            if (!v) setWriteDrawer(null);
          }}
          roles={data.roles}
          demo={demo}
          lab={lab}
          onDemoCreated={(form) =>
            mergeDemo((d) => ({
              ...d,
              localUsers: [...(d.localUsers ?? []), demoLocalUserRowFor(form)],
            }))
          }
          reload={reload}
        />
      ) : null}
      {writeDrawer?.kind === 'editUser' ? (
        <LocalUserWriteDrawer
          key={writeDrawer.row.id}
          mode="edit"
          row={writeDrawer.row}
          onOpenChange={(v) => {
            if (!v) setWriteDrawer(null);
          }}
          roles={data.roles}
          demo={demo}
          lab={lab}
          onDemoUpdated={(row, form) =>
            mergeDemo((d) => ({
              ...d,
              localUsers: (d.localUsers ?? []).map((u) =>
                u.id === row.id
                  ? {
                      ...u,
                      ...(form.username !== undefined ? { username: form.username || null } : {}),
                      ...(form.roleName !== undefined ? { roleName: form.roleName } : {}),
                      ...(form.enabled !== undefined ? { enabled: form.enabled } : {}),
                    }
                  : u,
              ),
            }))
          }
          reload={reload}
        />
      ) : null}
    </div>
  );
}

function EndpointTableRow({
  row,
  onOpenAuth,
  onEdit,
}: {
  row: EndpointRow;
  onOpenAuth: () => void;
  onEdit: () => void;
}) {
  return (
    <Table.Row>
      <Table.Cell>
        <Badge tone={statusTone(row.status)} dot>
          {row.status}
        </Badge>
      </Table.Cell>
      <Table.Cell>
        <button
          type="button"
          onClick={onOpenAuth}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-accent-text)',
            textAlign: 'left',
          }}
        >
          {row.mac}
        </button>
      </Table.Cell>
      <Table.Cell>
        {row.hostname ?? '—'}
        {row.description ? (
          <div style={{ fontSize: 'var(--nd-text-10)', color: 'var(--nd-text-muted)' }}>{row.description}</div>
        ) : null}
      </Table.Cell>
      <Table.Cell>
        <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)', color: 'var(--nd-text-muted)' }}>
          {row.ip ?? '—'}
        </span>
      </Table.Cell>
      <Table.Cell>
        {row.category ?? '—'}
        {row.insightTags && row.insightTags.length > 0 ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {row.insightTags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </Table.Cell>
      <Table.Cell>{[row.family, row.os].filter(Boolean).join(' · ') || '—'}</Table.Cell>
      <Table.Cell>{row.profile ?? '—'}</Table.Cell>
      <Table.Cell>
        <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-10)', color: 'var(--nd-text-muted)' }}>
          {row.updatedAt ?? '—'}
        </span>
      </Table.Cell>
      <Table.Cell>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit endpoint ${row.mac}`}>
          Edit
        </Button>
      </Table.Cell>
    </Table.Row>
  );
}

// -- Policy inventories --------------------------------------------------------
//
// One section per CPPM collection the adapter walks alongside the endpoint
// repository. Every section keeps the three states distinct: rows the plane
// reported, a real EMPTY answer (the CPPM has none), and a key the envelope
// did not carry at all (this CPPM did not report the collection — a failed
// read, or a build that does not expose it). The absent case must never
// render as the empty one.

/** Section meta: the count when the plane reported, an honest flag when not. */
function inventoryMeta(rows: readonly unknown[] | undefined): string {
  return rows === undefined ? 'NOT REPORTED' : `${rows.length}`;
}

/** Gates one inventory table on the reported / empty / not-reported states. */
function InventoryGate({
  rows,
  notReportedDescription,
  emptyTitle,
  children,
}: {
  rows: readonly unknown[] | undefined;
  notReportedDescription: string;
  emptyTitle: string;
  children: ReactNode;
}) {
  if (rows === undefined) {
    return <EmptyState title="Not reported by this CPPM" description={notReportedDescription} />;
  }
  if (rows.length === 0) return <EmptyState title={emptyTitle} />;
  return <>{children}</>;
}

/** A nullable boolean fact: null is "the box did not say", never a guess. */
function boolText(value: boolean | null): string {
  return value === null ? '—' : value ? 'Yes' : 'No';
}

function NetworkDevicesSection({
  rows,
  density,
}: {
  rows: ClearPassNetworkDeviceRow[] | undefined;
  density: 'comfortable' | 'compact';
}) {
  return (
    <>
      <SectionHeader label="Network devices" meta={inventoryMeta(rows)} />
      <InventoryGate
        rows={rows}
        notReportedDescription="ClearPass did not return its network-device inventory this cycle — the NAD list is unknown, not empty."
        emptyTitle="ClearPass reports no network devices"
      >
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>IP</Table.HeaderCell>
              <Table.HeaderCell>Vendor</Table.HeaderCell>
              <Table.HeaderCell>CoA</Table.HeaderCell>
              <Table.HeaderCell>RadSec</Table.HeaderCell>
              <Table.HeaderCell>Description</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {(rows ?? []).map((d) => (
              <Table.Row key={d.id}>
                <Table.Cell>{d.name}</Table.Cell>
                <Table.Cell>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-11)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {d.ipAddress ?? '—'}
                  </span>
                </Table.Cell>
                <Table.Cell>{d.vendorName ?? '—'}</Table.Cell>
                <Table.Cell>{boolText(d.coaCapable)}</Table.Cell>
                <Table.Cell>{boolText(d.radsecEnabled)}</Table.Cell>
                <Table.Cell>{d.description ?? '—'}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </InventoryGate>
    </>
  );
}

function AuthSourcesSection({
  rows,
  density,
}: {
  rows: ClearPassAuthSourceRow[] | undefined;
  density: 'comfortable' | 'compact';
}) {
  return (
    <>
      <SectionHeader label="Authentication sources" meta={inventoryMeta(rows)} />
      <InventoryGate
        rows={rows}
        notReportedDescription="ClearPass did not return its authentication sources this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no authentication sources"
      >
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>Type</Table.HeaderCell>
              <Table.HeaderCell>Description</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {(rows ?? []).map((s) => (
              <Table.Row key={s.id}>
                <Table.Cell>{s.name}</Table.Cell>
                <Table.Cell>{s.type ?? '—'}</Table.Cell>
                <Table.Cell>{s.description ?? '—'}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </InventoryGate>
    </>
  );
}

function RolesSection({ rows, density }: { rows: ClearPassRoleRow[] | undefined; density: 'comfortable' | 'compact' }) {
  return (
    <>
      <SectionHeader label="Roles" meta={inventoryMeta(rows)} />
      <InventoryGate
        rows={rows}
        notReportedDescription="ClearPass did not return its role inventory this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no roles"
      >
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>Description</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {(rows ?? []).map((r) => (
              <Table.Row key={r.id}>
                <Table.Cell>{r.name}</Table.Cell>
                <Table.Cell>{r.description ?? '—'}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </InventoryGate>
    </>
  );
}

function EnforcementSection({
  policies,
  profiles,
  density,
}: {
  policies: ClearPassEnforcementPolicyRow[] | undefined;
  profiles: ClearPassEnforcementProfileRow[] | undefined;
  density: 'comfortable' | 'compact';
}) {
  return (
    <>
      <SectionHeader label="Enforcement policies" meta={inventoryMeta(policies)} />
      <InventoryGate
        rows={policies}
        notReportedDescription="ClearPass did not return its enforcement policies this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no enforcement policies"
      >
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Policy</Table.HeaderCell>
              <Table.HeaderCell>Type</Table.HeaderCell>
              <Table.HeaderCell>Default profile</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {(policies ?? []).map((p) => (
              <Table.Row key={p.id}>
                <Table.Cell>{p.name}</Table.Cell>
                <Table.Cell>{p.enforcementType ?? '—'}</Table.Cell>
                <Table.Cell>
                  <DefaultProfileChain policy={p} profiles={profiles} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </InventoryGate>

      <SectionHeader label="Enforcement profiles" meta={inventoryMeta(profiles)} />
      <InventoryGate
        rows={profiles}
        notReportedDescription="ClearPass did not return its enforcement profiles this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no enforcement profiles"
      >
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>Type</Table.HeaderCell>
              <Table.HeaderCell>Description</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {(profiles ?? []).map((p) => (
              <Table.Row key={p.id}>
                <Table.Cell>{p.name}</Table.Cell>
                <Table.Cell>{p.type ?? '—'}</Table.Cell>
                <Table.Cell>{p.description ?? '—'}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </InventoryGate>
    </>
  );
}

/**
 * The policy→default-profile→profile chain: a policy's catch-all names a
 * profile, and when that name resolves to a reported profile row the link
 * shows what the fallback actually returns (type · description). An
 * unresolved name still renders — it is what the policy says — just without
 * a resolution the envelope cannot vouch for.
 */
function DefaultProfileChain({
  policy,
  profiles,
}: {
  policy: ClearPassEnforcementPolicyRow;
  profiles: ClearPassEnforcementProfileRow[] | undefined;
}) {
  if (policy.defaultProfile === null) return <>—</>;
  const profile = profiles?.find((p) => p.name === policy.defaultProfile);
  const detail = profile ? [profile.type, profile.description].filter(Boolean).join(' · ') : '';
  return (
    <div>
      {policy.defaultProfile}
      {detail ? <div style={{ fontSize: 'var(--nd-text-10)', color: 'var(--nd-text-muted)' }}>→ {detail}</div> : null}
    </div>
  );
}

/**
 * Local users — STRICTLY the whitelisted identity fields the adapter maps
 * (login, display name, role, enabled). There is no password material in the
 * payload to render, and this section must never grow a column that would
 * carry any. The add/edit drawers set a password write-only; it is never
 * shown here or anywhere else.
 */
function LocalUsersSection({
  rows,
  density,
  onAdd,
  onEdit,
}: {
  rows: ClearPassLocalUserRow[] | undefined;
  density: 'comfortable' | 'compact';
  onAdd: () => void;
  onEdit: (row: ClearPassLocalUserRow) => void;
}) {
  return (
    <>
      <SectionHeader label="Local users" meta={inventoryMeta(rows)} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="secondary" size="sm" onClick={onAdd}>
          Add local user
        </Button>
      </div>
      <InventoryGate
        rows={rows}
        notReportedDescription="ClearPass did not return its local users this cycle — the list is unknown, not empty."
        emptyTitle="ClearPass reports no local users"
      >
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>User ID</Table.HeaderCell>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>Role</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>{/* edit */}</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {(rows ?? []).map((u) => (
              <Table.Row key={u.id}>
                <Table.Cell>
                  <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)' }}>{u.userId}</span>
                </Table.Cell>
                <Table.Cell>{u.username ?? '—'}</Table.Cell>
                <Table.Cell>{u.roleName ?? '—'}</Table.Cell>
                <Table.Cell>
                  {u.enabled === null ? (
                    '—'
                  ) : (
                    <Badge tone={u.enabled ? 'success' : 'neutral'} dot>
                      {u.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Button variant="ghost" size="sm" onClick={() => onEdit(u)} aria-label={`Edit local user ${u.userId}`}>
                    Edit
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </InventoryGate>
    </>
  );
}

/**
 * Services and device groups are the collections a CPPM build may not expose
 * at all (the adapter omits the key on a 404, without even a partial flag),
 * so an absent key reads "not available on this CPPM". Device groups stay
 * absent in BOTH modes — the demo estate's CPPM (verified 6.11 behavior)
 * does not serve them. Services populate wherever the box answers either
 * service path — the demo estate's 6.11 CPPM included — with the richer
 * 6.11 shape: enabled state, template, hit count, order, auth sources and a
 * one-line read of the match rules; the not-available state remains for the
 * older builds that 404 both paths.
 *
 * A service row is clickable (the name, or its View action — the screen's
 * row idiom): it opens the per-service detail drawer, which reads the full
 * definition on demand from the route's TTL-cached read.
 */
function ServicesSection({
  services,
  deviceGroups,
  density,
  onView,
}: {
  services: ClearPassServiceRow[] | undefined;
  deviceGroups: ClearPassDeviceGroupRow[] | undefined;
  density: 'comfortable' | 'compact';
  onView: (row: ClearPassServiceRow) => void;
}) {
  return (
    <>
      <SectionHeader label="Services" meta={services === undefined ? 'NOT AVAILABLE' : `${services.length}`} />
      {services === undefined ? (
        <EmptyState
          title="Services are not available on this CPPM"
          description="This CPPM answered 404 on both /api/config/service and /api/service — the section is absent, not empty. Nothing about the portal's read is broken."
        />
      ) : services.length === 0 ? (
        <EmptyState title="ClearPass reports no services" />
      ) : (
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Service</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>Type</Table.HeaderCell>
              <Table.HeaderCell>Hits</Table.HeaderCell>
              <Table.HeaderCell>Order</Table.HeaderCell>
              <Table.HeaderCell>Auth sources</Table.HeaderCell>
              <Table.HeaderCell>Match rules</Table.HeaderCell>
              <Table.HeaderCell>{/* view */}</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {services.map((s) => (
              <Table.Row key={s.id}>
                <Table.Cell>
                  <button
                    type="button"
                    onClick={() => onView(s)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      font: 'inherit',
                      color: 'var(--nd-accent-text)',
                      textAlign: 'left',
                    }}
                  >
                    {s.name}
                  </button>
                  {s.description ? (
                    <div style={{ fontSize: 'var(--nd-text-10)', color: 'var(--nd-text-muted)' }}>{s.description}</div>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  {s.enabled === null || s.enabled === undefined ? (
                    '—'
                  ) : (
                    <Badge tone={s.enabled ? 'success' : 'neutral'} dot>
                      {s.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  )}
                </Table.Cell>
                <Table.Cell>
                  {s.type ?? '—'}
                  {s.template ? (
                    <div style={{ fontSize: 'var(--nd-text-10)', color: 'var(--nd-text-muted)' }}>{s.template}</div>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  {s.hitCount === null || s.hitCount === undefined ? '—' : formatCount(s.hitCount)}
                </Table.Cell>
                <Table.Cell>{s.orderNo ?? '—'}</Table.Cell>
                <Table.Cell>{s.authSources && s.authSources.length > 0 ? s.authSources.join(', ') : '—'}</Table.Cell>
                <Table.Cell>
                  <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)' }}>
                    {s.rulesSummary ?? '—'}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Button variant="ghost" size="sm" onClick={() => onView(s)} aria-label={`View service ${s.name}`}>
                    View
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      <SectionHeader label="Device groups" meta={deviceGroups === undefined ? 'NOT AVAILABLE' : `${deviceGroups.length}`} />
      {deviceGroups === undefined ? (
        <EmptyState
          title="Device groups are not available on this CPPM"
          description="This CPPM build does not expose /api/device-group — the section is absent, not empty. Nothing about the portal's read is broken."
        />
      ) : deviceGroups.length === 0 ? (
        <EmptyState title="ClearPass reports no device groups" />
      ) : (
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>Description</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {deviceGroups.map((g) => (
              <Table.Row key={g.id}>
                <Table.Cell>{g.name}</Table.Cell>
                <Table.Cell>{g.description ?? '—'}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Service detail drawer — ONE service's full definition, read on demand.
//
// CPPM's own service form, read-only: SUMMARY, MATCH RULES, AUTHENTICATION,
// AUTHORIZATION, ENFORCEMENT, OPTIONS. The payload's own verdicts drive the
// body — 'ok' renders the object, 'empty' is the box's 404 (no such
// service), 'failed' is a broken read — and a field the box did not report
// renders 'Not reported', never an invented value. Nothing in a service
// definition is credential material, and this drawer must never grow a row
// that would carry any.
// ---------------------------------------------------------------------------

const serviceNoteStyle = {
  fontFamily: 'var(--nd-font-mono)',
  fontSize: 'var(--nd-text-11)',
  color: 'var(--nd-text-muted)',
  lineHeight: 1.6,
} as const;

/** A tri-state flag as CPPM words its own toggles; null is "the box did not say". */
function flagText(value: boolean | null): string {
  return value === null ? 'Not reported' : value ? 'Enabled' : 'Disabled';
}

/** rules_match_type as CPPM's rule editor words it; an unfamiliar value passes through. */
function matchTypeLabel(value: string | null): string {
  if (value === null) return 'Not reported';
  if (value === 'MATCHES_ALL') return 'Matches ALL of the following conditions';
  if (value === 'MATCHES_ANY') return 'Matches ANY of the following conditions';
  return value;
}

/** The drawer's body for one settled read — the three route outcomes first. */
function ServiceDetailBody({ result }: { result: ClearPassServiceDetailResult }) {
  if (result.kind === 'not-reported') {
    return (
      <div style={serviceNoteStyle}>
        No detail was reported for this service — the portal has no service read for this id.
      </div>
    );
  }
  if (result.kind === 'failed') {
    return (
      <div style={{ ...serviceNoteStyle, color: 'var(--nd-danger)' }}>
        The service detail read failed — {result.message}
      </div>
    );
  }
  const { detail } = result;
  const state = detailState(detail.source, 'service');
  const provenance = `CLEARPASS · READ ${hhmmLocal(detail.source.at)}${detail.source.cached ? ' · CACHED' : ''}`;
  if (state === 'failed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...serviceNoteStyle, fontSize: 'var(--nd-text-10)' }}>{provenance}</div>
        <div style={{ ...serviceNoteStyle, color: 'var(--nd-danger)' }}>
          The service read failed{detail.source.note ? ` — ${detail.source.note}` : ''}.
        </div>
      </div>
    );
  }
  if (state === 'empty' || detail.service === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...serviceNoteStyle, fontSize: 'var(--nd-text-10)' }}>{provenance}</div>
        <div style={serviceNoteStyle}>
          {detail.source.note ?? 'ClearPass answered 404 for this service — no such service on this CPPM.'}
        </div>
      </div>
    );
  }
  return <ServiceDefinition detail={detail} />;
}

/** The mapped service, sectioned the way CPPM's own service form sections it. */
function ServiceDefinition({ detail }: { detail: ClearPassServiceDetailLive }) {
  const s = detail.service;
  if (s === null) return null; // unreachable past ServiceDetailBody's gate — never render a guessed object
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ ...serviceNoteStyle, fontSize: 'var(--nd-text-10)' }}>
        {`CLEARPASS · READ ${hhmmLocal(detail.source.at)}${detail.source.cached ? ' · CACHED' : ''}`}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SectionHeader label="Summary" />
        <ReviewRow label="Name" value={s.name} />
        <ReviewRow label="ID" value={s.id} mono />
        <ReviewRow label="Type" value={s.type ?? 'Not reported'} />
        <ReviewRow label="Template" value={s.template ?? 'Not reported'} />
        <ReviewRow label="Order" value={s.orderNo !== null ? String(s.orderNo) : 'Not reported'} />
        <ReviewRow label="Status" value={flagText(s.enabled)} />
        <ReviewRow label="Hit count" value={s.hitCount !== null ? formatCount(s.hitCount) : 'Not reported'} />
        <ReviewRow label="Description" value={s.description ?? 'Not reported'} />
        <ReviewRow label="Monitor mode" value={flagText(s.monitorMode)} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionHeader label="Match rules" />
        <ReviewRow label="Match type" value={matchTypeLabel(s.rulesMatchType)} />
        {s.rulesConditions.length > 0 ? (
          <Table density="compact">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Type</Table.HeaderCell>
                <Table.HeaderCell>Name</Table.HeaderCell>
                <Table.HeaderCell>Operator</Table.HeaderCell>
                <Table.HeaderCell>Value</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {s.rulesConditions.map((c, i) => (
                <Table.Row key={`${c.type ?? ''}:${c.name ?? ''}:${i}`}>
                  <Table.Cell>{c.type ?? '—'}</Table.Cell>
                  <Table.Cell>{c.name ?? '—'}</Table.Cell>
                  <Table.Cell>
                    <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)' }}>
                      {c.operator ?? '—'}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 'var(--nd-text-11)' }}>
                      {c.value ?? '—'}
                    </span>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        ) : (
          <div style={serviceNoteStyle}>No match conditions were reported for this service.</div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SectionHeader label="Authentication" />
        <ReviewRow label="Methods" value={s.authMethods.length > 0 ? s.authMethods.join(', ') : 'Not reported'} />
        <ReviewRow label="Sources" value={s.authSources.length > 0 ? s.authSources.join(', ') : 'Not reported'} />
        <ReviewRow label="Strip username" value={flagText(s.stripUsername)} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SectionHeader label="Authorization" />
        <ReviewRow label="Role mapping" value={s.roleMappingPolicy ?? 'Not reported'} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SectionHeader label="Enforcement" />
        <ReviewRow label="Policy" value={s.enforcementPolicy ?? 'Not reported'} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SectionHeader label="Options" />
        <ReviewRow label="Posture" value={flagText(s.postureEnabled)} />
        <ReviewRow label="Audit" value={flagText(s.auditEnabled)} />
        <ReviewRow label="Profiler" value={flagText(s.profilerEnabled)} />
        <ReviewRow label="Accounting proxy" value={flagText(s.acctProxyEnabled)} />
        <ReviewRow label="Cached results" value={flagText(s.useCachedPolicyResults)} />
      </div>
    </div>
  );
}

/**
 * The per-service read drawer. Mounts only while open and keyed by the
 * service id, so the fetch fires once per opening and its state starts
 * fresh — the server TTL-caches, so a reopen inside the window costs no
 * CPPM call.
 */
function ServiceDetailDrawer({
  row,
  onOpenChange,
}: {
  row: ClearPassServiceRow;
  onOpenChange: (open: boolean) => void;
}) {
  const [result, setResult] = useState<ClearPassServiceDetailResult | null>(null);

  useEffect(() => {
    let live = true;
    void getClearPassServiceDetail(row.id)
      .then((r) => {
        if (live) setResult(r);
      })
      .catch(() => {
        if (live) setResult({ kind: 'failed', message: 'the service detail request failed' });
      });
    return () => {
      live = false;
    };
  }, [row.id]);

  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      width="lg"
      title={row.name}
      description="The service definition as ClearPass reports it — summary, match rules, authentication, authorization, enforcement and options."
    >
      {result === null ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spinner size="md" />
        </div>
      ) : (
        <ServiceDetailBody result={result} />
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Reviewed write drawers — endpoint register/edit and local-user create/edit.
//
// Every drawer is the same contract the SSID editor set: the form, then an
// exact summary of what will be written (a password is NEVER in it), then an
// explicit review checkbox standing in for a ticket, then the server's
// apply→verify→audit outcome shown verbatim. Apply stays disabled while the
// form would be refused or nothing changed. Demo mode applies the write to
// the fixture world on screen (the result message says plainly that nothing
// left the portal); live mode re-fetches the screen so the list reflects the
// plane, and the outcome says when the server could not re-read it.
// ---------------------------------------------------------------------------

/** Client-side mirror of the server's MAC rule — the server stays authoritative. */
function macProblem(mac: string): string | null {
  if (!mac.trim()) return 'a MAC address is required';
  return mac.trim().replace(/[^0-9a-fA-F]/g, '').length === 12
    ? null
    : 'a valid MAC address is 12 hex digits (any separator) — e.g. 3c:22:fb:41:0a:19';
}

/** The attributes textarea, one 'Name: Value' per line → CPPM's flat map. */
function parseAttributes(text: string): { attributes?: Record<string, string>; problem?: string } {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (!line) continue;
    const idx = line.indexOf(':');
    const key = idx > 0 ? line.slice(0, idx).trim() : '';
    const value = idx > 0 ? line.slice(idx + 1).trim() : '';
    if (!key || !value) return { problem: `attribute line '${line}' must be Name: Value` };
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? { attributes: out } : {};
}

/** The fixture-world row a demo registration adds — clearly a demo artifact
 *  ('just now (demo)'), matching the whitelisted shape every other row has. */
function demoEndpointRowFor(form: ClearPassEndpointRegisterForm): EndpointRow {
  return {
    id: `demo-ep-${normalizeMac(form.mac)}`,
    mac: normalizeMac(form.mac),
    description: form.description ?? null,
    ip: null,
    hostname: null,
    status: form.status ?? 'Known',
    category: form.attributes?.Category ?? null,
    family: form.attributes?.Family ?? null,
    os: form.attributes?.OS ?? null,
    profile: null,
    updatedAt: 'just now (demo)',
  };
}

/** The fixture-world row a demo local-user create adds — whitelisted identity
 *  fields only, exactly like the rows the plane reports. */
function demoLocalUserRowFor(form: ClearPassLocalUserCreateForm): ClearPassLocalUserRow {
  return {
    id: `demo-lu-${form.userId}`,
    userId: form.userId,
    username: form.username ?? null,
    roleName: form.roleName,
    enabled: form.enabled,
  };
}

/** One row of the 'What gets written' review summary. */
function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        padding: '6px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <span style={{ flex: '0 0 110px', fontSize: 11, color: 'var(--nd-text-muted)' }}>{label}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          color: 'var(--nd-text-secondary)',
          ...(mono ? { fontFamily: 'var(--nd-font-mono)', fontSize: 11.5 } : {}),
        }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The apply outcome, rendered verbatim from the server. Green is a claim: a
 * write CPPM answered but the read-back could not confirm does not get one —
 * the same rule the SSID apply's result panel follows.
 */
function WriteOutcomeAlert({ outcome }: { outcome: { error?: string; result?: ClearPassWriteResult } }) {
  if (outcome.error) {
    return (
      <Alert tone="danger" title="Apply failed">
        <span style={{ fontSize: 13 }}>{outcome.error}</span>
      </Alert>
    );
  }
  const r = outcome.result;
  if (!r) return null;
  const stale = r.cacheRefresh?.attempted === true && !r.cacheRefresh.ok;
  const tone = !r.ok ? 'danger' : r.verified === true && !stale ? 'success' : 'warning';
  const title = !r.ok
    ? 'Not applied'
    : r.verified === true
      ? stale
        ? 'Applied and confirmed — the list could not be re-read'
        : r.action === 'created'
          ? 'Applied and confirmed'
          : 'Updated and confirmed'
      : 'Applied, not confirmed by the read-back';
  return (
    <Alert tone={tone} title={title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        <span>{r.message}</span>
        {stale ? (
          <span>
            The list behind could not be re-read ({r.cacheRefresh?.message ?? 'reason not reported'}) — it may not
            show this yet. Do not apply it again.
          </span>
        ) : null}
      </div>
    </Alert>
  );
}

/** The review checkbox, the apply/cancel row, the outcome, and the audit note —
 *  one footer every write drawer shares. */
function ReviewedWriteFooter({
  lab,
  reviewed,
  onReviewed,
  problems,
  applying,
  applyLabel,
  onApply,
  onCancel,
  outcome,
}: {
  lab: boolean;
  reviewed: boolean;
  onReviewed: (v: boolean) => void;
  problems: string[];
  applying: boolean;
  applyLabel: string;
  onApply: () => Promise<void>;
  onCancel: () => void;
  outcome: { error?: string; result?: ClearPassWriteResult } | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!lab ? <Checkbox
        label="I have reviewed this write — apply directly, no ticket."
        checked={reviewed}
        onChange={(e) => onReviewed(e.target.checked)}
      /> : null}
      {problems.length > 0 ? (
        <Alert tone="warning" title="Apply is disabled — the form would be refused">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            {problems.map((p) => (
              <span key={p}>{p}</span>
            ))}
          </div>
        </Alert>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          size="md"
          disabled={(!lab && !reviewed) || applying || problems.length > 0}
          onClick={() => void onApply()}
        >
          {applying ? 'Applying…' : applyLabel}
        </Button>
        <Button variant="ghost" size="md" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {outcome ? <WriteOutcomeAlert outcome={outcome} /> : null}
      <span
        style={{
          fontFamily: 'var(--nd-font-mono)',
          fontSize: 10.5,
          color: 'var(--nd-text-muted)',
          lineHeight: 1.6,
        }}
      >
        Direct apply — no ticket, no queue. An audit event is still recorded for every attempt.
      </span>
    </div>
  );
}

/** Toast wording for a landed write — confirmed reads differently from
 *  answered-but-unverified, and a stale cache says so outright. */
function toastWriteOutcome(
  toast: ReturnType<typeof useToast>['toast'],
  label: string,
  r: ClearPassWriteResult,
): void {
  const confirmed = r.verified === true;
  const stale = r.cacheRefresh?.attempted === true && !r.cacheRefresh.ok;
  toast(confirmed && !stale ? `${label} applied` : `${label} applied — not fully confirmed`, {
    description: r.message + (stale ? ' The list may not show it yet — do not apply it again.' : ''),
    tone: confirmed && !stale ? 'success' : 'warning',
  });
}

/** 'Register endpoint' — POST /api/endpoint through the reviewed flow. Mounted
 *  only while open, so a fresh form is just a fresh mount. */
function RegisterEndpointDrawer({
  onOpenChange,
  demo,
  lab,
  onDemoApplied,
  reload,
}: {
  onOpenChange: (open: boolean) => void;
  demo: boolean;
  lab: boolean;
  onDemoApplied: (form: ClearPassEndpointRegisterForm) => void;
  reload: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [mac, setMac] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<ClearPassEndpointStatus>('Known');
  const [attrText, setAttrText] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ error?: string; result?: ClearPassWriteResult } | null>(null);

  const parsed = parseAttributes(attrText);
  const problems = [macProblem(mac), parsed.problem ?? null].filter((p): p is string => p !== null);

  const apply = async () => {
    if ((!lab && !reviewed) || applying || problems.length > 0) return;
    const form: ClearPassEndpointRegisterForm = {
      mac: mac.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      status,
      ...(parsed.attributes ? { attributes: parsed.attributes } : {}),
    };
    setApplying(true);
    const r = await registerClearPassEndpoint(form, lab ? undefined : true);
    setApplying(false);
    if (isApiError(r)) {
      setOutcome({ error: r.error });
      toast(r.error, { tone: 'danger' });
      return;
    }
    setOutcome({ result: r });
    if (r.ok) {
      toastWriteOutcome(toast, normalizeMac(form.mac), r);
      if (demo) onDemoApplied(form);
      else await reload();
    } else {
      toast(`${normalizeMac(form.mac)} was not registered`, { description: r.message, tone: 'danger' });
    }
  };

  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      width="lg"
      title="Register endpoint"
      description={`Add one MAC to the ClearPass endpoint repository, with the profiling attributes you know. ${lab ? 'This lab write applies directly.' : 'The write goes to the linked CPPM only after your explicit review.'}`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FormField label="MAC address" help="Any separator — normalised to aa:bb:cc:dd:ee:ff before the write.">
          <Input mono value={mac} onChange={(e) => setMac(e.target.value)} placeholder="3c:22:fb:41:0a:19" />
        </FormField>
        <FormField label="Description" help="The operator note shown in the repository — optional.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ward 3E infusion pump" />
        </FormField>
        <FormField label="Status">
          <Select
            options={CLEARPASS_ENDPOINT_STATUSES.map((s) => ({ value: s, label: s }))}
            value={status}
            onValueChange={(v) => setStatus(v as ClearPassEndpointStatus)}
            aria-label="Endpoint status"
          />
        </FormField>
        <FormField label="Attributes" help="Profiling hints, one Name: Value per line — optional.">
          <Textarea
            mono
            rows={3}
            value={attrText}
            onChange={(e) => setAttrText(e.target.value)}
            placeholder={'Category: Computer\nFamily: Embedded'}
          />
        </FormField>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader label={lab ? 'Write summary' : 'Review — what gets written'} />
          <ReviewRow label="MAC" value={mac.trim() ? normalizeMac(mac) : '—'} mono />
          <ReviewRow label="Status" value={status} />
          <ReviewRow label="Description" value={description.trim() || '—'} />
          <ReviewRow
            label="Attributes"
            value={
              parsed.attributes
                ? Object.entries(parsed.attributes)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')
                : '—'
            }
            mono={!!parsed.attributes}
          />
          <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 10.5, color: 'var(--nd-text-muted)', marginTop: 6 }}>
            {demo
              ? 'demo mode — validated and audit-logged here; nothing is sent to a live CPPM.'
              : 'POST /api/endpoint on the linked CPPM, then a read-back to confirm it.'}
          </span>
        </div>

        <ReviewedWriteFooter
          reviewed={reviewed}
          lab={lab}
          onReviewed={setReviewed}
          problems={problems}
          applying={applying}
          applyLabel="Register endpoint"
          onApply={apply}
          onCancel={() => onOpenChange(false)}
          outcome={outcome}
        />
      </div>
    </Drawer>
  );
}

/** Per-endpoint edit — status and/or the operator note (PATCH /api/endpoint/{id}).
 *  Keyed by row id and mounted only while open, so the form seeds itself from
 *  the row on mount. */
function EditEndpointDrawer({
  row,
  onOpenChange,
  demo,
  lab,
  onDemoApplied,
  reload,
}: {
  row: EndpointRow;
  onOpenChange: (open: boolean) => void;
  demo: boolean;
  lab: boolean;
  onDemoApplied: (row: EndpointRow, form: ClearPassEndpointUpdateForm) => void;
  reload: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [status, setStatus] = useState<ClearPassEndpointStatus>(() =>
    (CLEARPASS_ENDPOINT_STATUSES as string[]).includes(row.status) ? (row.status as ClearPassEndpointStatus) : 'Known',
  );
  const [description, setDescription] = useState(row.description ?? '');
  const [reviewed, setReviewed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ error?: string; result?: ClearPassWriteResult } | null>(null);

  const statusChanged = status !== row.status;
  const descChanged = description !== (row.description ?? '');
  const problems = statusChanged || descChanged ? [] : ['change the status or the description — there is nothing to write'];
  // Only what actually changed crosses — an untouched status is never
  // rewritten, so a row whose status sits outside the three-value write
  // vocabulary keeps it unless the operator deliberately moves it.
  const statusOptions = (CLEARPASS_ENDPOINT_STATUSES as string[]).includes(row.status)
    ? CLEARPASS_ENDPOINT_STATUSES.map((s) => ({ value: s, label: s }))
    : [...CLEARPASS_ENDPOINT_STATUSES.map((s) => ({ value: s, label: s })), { value: row.status, label: `${row.status} (current)` }];

  const apply = async () => {
    if ((!lab && !reviewed) || applying || problems.length > 0) return;
    const form: ClearPassEndpointUpdateForm = {
      ...(statusChanged ? { status } : {}),
      ...(descChanged ? { description } : {}),
    };
    setApplying(true);
    const r = await updateClearPassEndpoint(row.id, form, lab ? undefined : true);
    setApplying(false);
    if (isApiError(r)) {
      setOutcome({ error: r.error });
      toast(r.error, { tone: 'danger' });
      return;
    }
    setOutcome({ result: r });
    if (r.ok) {
      toastWriteOutcome(toast, row.mac, r);
      if (demo) onDemoApplied(row, form);
      else await reload();
    } else {
      toast(`${row.mac} was not updated`, { description: r.message, tone: 'danger' });
    }
  };

  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      width="lg"
      title={`Edit endpoint ${row.mac}`}
      description="Change the repository status and/or the operator note. The MAC is the endpoint's identity and is never rewritten."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FormField label="Status">
          <Select
            options={statusOptions}
            value={status}
            onValueChange={(v) => setStatus(v as ClearPassEndpointStatus)}
            aria-label="Endpoint status"
          />
        </FormField>
        <FormField label="Description" help="Empty clears the operator note.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader label={lab ? 'Write summary' : 'Review — what gets written'} />
          <ReviewRow label="MAC" value={row.mac} mono />
          <ReviewRow label="Status" value={statusChanged ? `${row.status} → ${status}` : `${status} (unchanged)`} />
          <ReviewRow
            label="Description"
            value={descChanged ? `${row.description ?? '—'} → ${description || '(cleared)'}` : 'unchanged'}
          />
          <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 10.5, color: 'var(--nd-text-muted)', marginTop: 6 }}>
            {demo
              ? 'demo mode — validated and audit-logged here; nothing is sent to a live CPPM.'
              : `PATCH /api/endpoint/${row.id} on the linked CPPM, then a read-back to confirm it.`}
          </span>
        </div>

        <ReviewedWriteFooter
          reviewed={reviewed}
          lab={lab}
          onReviewed={setReviewed}
          problems={problems}
          applying={applying}
          applyLabel="Apply update"
          onApply={apply}
          onCancel={() => onOpenChange(false)}
          outcome={outcome}
        />
      </div>
    </Drawer>
  );
}

/** Local-user create/edit — role from the reported roles, and a password that
 *  is write-only: never displayed in the review, never echoed in a result.
 *  Keyed by row id (edit) and mounted only while open, so the form seeds
 *  itself on mount. */
function LocalUserWriteDrawer({
  mode,
  row,
  onOpenChange,
  roles,
  demo,
  lab,
  onDemoCreated,
  onDemoUpdated,
  reload,
}: {
  mode: 'create' | 'edit';
  row?: ClearPassLocalUserRow; // edit only — required then
  onOpenChange: (open: boolean) => void;
  roles: ClearPassRoleRow[] | undefined;
  demo: boolean;
  lab: boolean;
  onDemoCreated?: (form: ClearPassLocalUserCreateForm) => void;
  onDemoUpdated?: (row: ClearPassLocalUserRow, form: ClearPassLocalUserUpdateForm) => void;
  reload: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [userId, setUserId] = useState(mode === 'edit' ? (row?.userId ?? '') : '');
  const [username, setUsername] = useState(mode === 'edit' ? (row?.username ?? '') : '');
  const [roleName, setRoleName] = useState(mode === 'edit' ? (row?.roleName ?? '') : '');
  const [enabled, setEnabled] = useState(mode === 'edit' ? (row?.enabled ?? true) : true);
  const [password, setPassword] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ error?: string; result?: ClearPassWriteResult } | null>(null);

  // The pickable roles are the reported dataset; an edit target whose CURRENT
  // role is not in it keeps that role visible (and simply unchanged), exactly
  // like the endpoint editor's out-of-vocabulary status.
  const roleNames = (roles ?? []).map((r) => r.name);
  const roleOptions = [
    ...(mode === 'edit' && roleName && !roleNames.includes(roleName)
      ? [{ value: roleName, label: `${roleName} (current)` }]
      : []),
    ...roleNames.map((n) => ({ value: n, label: n })),
  ];
  const rolesReported = roles !== undefined && roles.length > 0;

  const problems: string[] = [];
  if (mode === 'create') {
    if (!userId.trim()) problems.push('a user id is required');
    if (!roleName) problems.push(rolesReported ? 'pick a role' : 'a role is required, and the role inventory was not reported');
    if (!password) problems.push('a password is required for a new local user');
  } else {
    const changed =
      username !== (row?.username ?? '') ||
      roleName !== (row?.roleName ?? '') ||
      enabled !== (row?.enabled ?? true) ||
      password.length > 0;
    if (!changed) problems.push('change a field, or set a new password — there is nothing to write');
  }
  if (!rolesReported && (mode === 'create' || roleName !== (row?.roleName ?? ''))) {
    problems.push('the role inventory was not reported by this CPPM — a role cannot be picked; resync and reopen');
  }

  const apply = async () => {
    if ((!lab && !reviewed) || applying || problems.length > 0) return;
    if (mode === 'edit' && !row) return;
    setApplying(true);
    let r: Awaited<ReturnType<typeof createClearPassLocalUser>>;
    if (mode === 'create') {
      const form: ClearPassLocalUserCreateForm = {
        userId: userId.trim(),
        ...(username.trim() ? { username: username.trim() } : {}),
        roleName,
        enabled,
        password,
      };
      r = await createClearPassLocalUser(form, lab ? undefined : true);
      if (!isApiError(r) && r.ok) {
        if (demo) onDemoCreated?.(form);
        else await reload();
      }
    } else {
      const form: ClearPassLocalUserUpdateForm = {
        ...(username !== ((row as ClearPassLocalUserRow).username ?? '') ? { username } : {}),
        ...(roleName !== ((row as ClearPassLocalUserRow).roleName ?? '') ? { roleName } : {}),
        ...(enabled !== ((row as ClearPassLocalUserRow).enabled ?? true) ? { enabled } : {}),
        ...(password.length > 0 ? { password } : {}),
      };
      r = await updateClearPassLocalUser((row as ClearPassLocalUserRow).id, form, lab ? undefined : true);
      if (!isApiError(r) && r.ok) {
        if (demo) onDemoUpdated?.(row as ClearPassLocalUserRow, form);
        else await reload();
      }
    }
    setApplying(false);
    if (isApiError(r)) {
      setOutcome({ error: r.error });
      toast(r.error, { tone: 'danger' });
      return;
    }
    setOutcome({ result: r });
    const label = mode === 'create' ? userId.trim() : (row?.userId ?? 'local user');
    if (r.ok) toastWriteOutcome(toast, label, r);
    else toast(`${label} was not ${mode === 'create' ? 'created' : 'updated'}`, { description: r.message, tone: 'danger' });
    if (r.ok) setPassword(''); // a written password never lingers in the form
  };

  const title = mode === 'create' ? 'Add local user' : `Edit local user ${row?.userId ?? ''}`;
  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      width="lg"
      title={title}
      description="A ClearPass local account. The password is write-only: it is sent to CPPM and never displayed, echoed, or read back — including here."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {mode === 'create' ? (
          <FormField label="User ID" help="The login name — it cannot be changed afterwards.">
            <Input mono value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="noc-operator" />
          </FormField>
        ) : null}
        <FormField label="Display name" help="Optional.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="NOC Operator" />
        </FormField>
        <FormField label="Role">
          {rolesReported ? (
            <Select
              options={[{ value: '', label: 'Select a role…' }, ...roleOptions]}
              value={roleName}
              onValueChange={setRoleName}
              aria-label="Role"
            />
          ) : (
            <span style={{ fontSize: 12.5, color: 'var(--nd-text-muted)' }}>
              Not reported by this CPPM — a role cannot be picked.
            </span>
          )}
        </FormField>
        <FormField label="Account state">
          <Switch checked={enabled} onCheckedChange={setEnabled} label={enabled ? 'Enabled' : 'Disabled'} />
        </FormField>
        <FormField
          label={mode === 'create' ? 'Password' : 'New password'}
          help={mode === 'create' ? 'Write-only — never shown again, anywhere.' : 'Leave blank to keep the current password.'}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader label={lab ? 'Write summary' : 'Review — what gets written'} />
          <ReviewRow label="User ID" value={mode === 'create' ? userId.trim() || '—' : (row?.userId ?? '—')} mono />
          <ReviewRow
            label="Display name"
            value={
              mode === 'create'
                ? username.trim() || '—'
                : username !== (row?.username ?? '')
                  ? `${row?.username ?? '—'} → ${username || '(cleared)'}`
                  : 'unchanged'
            }
          />
          <ReviewRow
            label="Role"
            value={
              mode === 'create'
                ? roleName || '—'
                : roleName !== (row?.roleName ?? '')
                  ? `${row?.roleName ?? '—'} → ${roleName}`
                  : roleName || 'unchanged'
            }
          />
          <ReviewRow
            label="State"
            value={
              mode === 'create'
                ? enabled
                  ? 'Enabled'
                  : 'Disabled'
                : enabled !== (row?.enabled ?? true)
                  ? `${row?.enabled ? 'Enabled' : 'Disabled'} → ${enabled ? 'Enabled' : 'Disabled'}`
                  : 'unchanged'
            }
          />
          <ReviewRow label="Password" value={password ? 'set — write-only, never displayed' : mode === 'create' ? '—' : 'unchanged'} />
          <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 10.5, color: 'var(--nd-text-muted)', marginTop: 6 }}>
            {demo
              ? 'demo mode — validated and audit-logged here; nothing is sent to a live CPPM.'
              : mode === 'create'
                ? 'POST /api/local-user on the linked CPPM, then a whitelisted read-back (never the password).'
                : `PUT /api/local-user/${row?.id ?? ''} on the linked CPPM, then a whitelisted read-back (never the password).`}
          </span>
        </div>

        <ReviewedWriteFooter
          reviewed={reviewed}
          lab={lab}
          onReviewed={setReviewed}
          problems={problems}
          applying={applying}
          applyLabel={mode === 'create' ? 'Create local user' : 'Apply update'}
          onApply={apply}
          onCancel={() => onOpenChange(false)}
          outcome={outcome}
        />
      </div>
    </Drawer>
  );
}
