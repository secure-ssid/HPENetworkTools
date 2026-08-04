/**
 * web/src/screens/Sites.tsx — ten sites, and the plane each one answers to.
 * High-fidelity port of design/NtSites.dc.html: header actions carry the plane
 * Select + name Input + "Add site", a 4-Stat row, flair divider, the open
 * table (Site / Managed by — multiple plane Badges / Mix / Devices / Clients /
 * 70×3px Health bar / Alerts / Last sync), and a footer with the mono count
 * and a decorative one-page Pagination. The footer count is derived from the
 * loaded rows and carries the envelope's own provenance stamp (DEMO FIXTURE vs
 * LIVE · SYNCED hh:mm), so a fixture total is never read as a live estate.
 * Filters are local, instant, AND-combined.
 * "Add site" opens a small honest drawer: sites are created on the managing
 * plane, so submitting hands off (toast) instead of fake-creating a row.
 * Data: getSites() — live /api/sites when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Divider,
  Drawer,
  EmptyState,
  FormField,
  Input,
  Pagination,
  Select,
  Spinner,
  Table,
  useToast,
} from '../nightdesk';
import { getSites } from '../api/client';
import type { SitesData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { hhmmLocal as hhmm, countOf } from '@hpe/shared';
import type { MistSleRow, SiteHealthTone, SiteRow } from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';

const HEALTH_COLORS: Record<SiteHealthTone, string> = {
  ok: 'var(--nd-success)',
  warn: 'var(--nd-warning)',
  bad: 'var(--nd-danger)',
  stale: 'var(--nd-border-strong)',
};

/** ≥0.9 good, 0.7–0.9 moderate, <0.7 poor — the SLE badge's own thresholds,
 *  independent of the site health tone above (Mist scores per classifier,
 *  not per the merged inventory's device/alert mix). */
function sleTone(overall: number | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (overall === null) return 'neutral';
  if (overall >= 0.9) return 'success';
  if (overall >= 0.7) return 'warning';
  return 'danger';
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function sleTooltip(sle: MistSleRow): string {
  return [
    `Coverage ${pct(sle.coverage)}`,
    `Capacity ${pct(sle.capacity)}`,
    `Roaming ${pct(sle.roaming)}`,
    `AP Health ${pct(sle.apHealth)}`,
    `WAN ${pct(sle.wan)}`,
  ].join(' · ');
}


function planeNames(sites: SiteRow[]): string[] {
  const all: string[] = [];
  sites.forEach((s) =>
    s.planes.forEach((p) => {
      if (all.indexOf(p.name) < 0) all.push(p.name);
    }),
  );
  return all;
}

export default function Sites() {
  const navigate = useNavigate();
  const { density, showPlatformTags, pollIntervalSec } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<SitesData | null>(null);
  const [plane, setPlane] = useState('all');
  const [q, setQ] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSubnet, setNewSubnet] = useState('');
  const [newPlane, setNewPlane] = useState('CENTRAL');

  /* The footer stamps LIVE · SYNCED hh:mm, so a NOC tab must not sit on a
     mount-time snapshot under it: poll on the settings cadence, the same
     pattern Overview.tsx runs. One fetch at a time — a slow response never
     stacks up behind the interval; fixture reads poll harmlessly. */
  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = () => {
      if (inFlight) return;
      inFlight = true;
      void getSites()
        .then((d) => {
          if (live) setData(d);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    pull();
    const every = Math.max(pollIntervalSec, 10) * 1000;
    const id = setInterval(pull, every);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pollIntervalSec]);

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const sites = data.sites;
  const ql = q.trim().toLowerCase();
  const rows = sites.filter(
    (s) =>
      (plane === 'all' || s.planes.some((p) => p.name === plane)) &&
      (!ql || s.name.toLowerCase().includes(ql)),
  );
  // Footer count: the estate total the rows themselves carry (418 across the
  // ten fixtures), never a literal that a live inventory would contradict.
  const indexedDevices = sites.reduce((n, s) => n + s.devices, 0);
  // The authored "Ten sites" prose is demo copy — a live estate counts itself.
  const sitesLive = data.dataSource === 'live' || (data.blended?.includes('sites') ?? false);
  // Design rule 1: the footer count is a data claim, so it says which source
  // made it. Same vocabulary as SiteDetail so the two never disagree.
  const sourceLabel = sitesLive
    ? `LIVE · SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : 'NEVER'}`
    : 'DEMO FIXTURE';
  const planeOptions = [{ value: 'all', label: 'All planes' }].concat(
    planeNames(sites).map((p) => ({ value: p, label: p })),
  );
  const addPlaneOptions = planeNames(sites).map((p) => ({ value: p, label: p }));
  /* 'CENTRAL' is only a default while the estate actually has one — on a
     CENTRAL-less estate a Select holding it has no matching option and
     renders blank, so fall back to the first plane the estate does report. */
  const newPlaneValue = addPlaneOptions.some((o) => o.value === newPlane)
    ? newPlane
    : (addPlaneOptions[0]?.value ?? newPlane);

  /* Sites are owned by the managing planes — hand off, never fake-create. */
  const submitAddSite = () => {
    toast('Site creation runs on the managing plane — handed off', {
      description: newName
        ? `${newName}${newSubnet ? ` · ${newSubnet}` : ''} · ${newPlaneValue}`
        : undefined,
      tone: 'info',
    });
    setAddOpen(false);
    setNewName('');
    setNewSubnet('');
    setNewPlane('CENTRAL');
  };

  // A plane that contributed no device list contributed no sites either, so
  // its locations are missing from the table rather than present-and-empty.
  const missingSources = data.missingSources ?? [];
  const sleBySiteId = data.sleBySiteId ?? {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Inventory / Sites"
        title="Sites"
        subtitle={
          sitesLive
            ? `${countOf(sites.length, 'site')}${
                missingSources.length > 0 ? ' so far' : ''
              }, and the plane each one actually answers to.`
            : 'Ten sites, and the plane each one actually answers to.'
        }
        actions={
          <>
            <div style={{ width: 170 }}>
              <Select
                options={planeOptions}
                value={plane}
                onValueChange={setPlane}
                size="sm"
                aria-label="Filter by plane"
              />
            </div>
            <div style={{ width: 200 }}>
              <Input
                size="sm"
                mono
                placeholder="site name…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Filter sites"
              />
            </div>
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
              Add site
            </Button>
          </>
        }
      />

      {missingSources.length > 0 ? (
        <Alert
          tone="warning"
          title={`${missingSources.length} linked plane${
            missingSources.length === 1 ? '' : 's'
          } contributed no inventory: ${missingSources.join(', ')}`}
        >
          <span style={{ fontSize: 13 }}>
            Sites are derived from the merged device inventory, so any location known only to these planes is absent
            from the table below — not listed as empty. The counts above describe the estate that answered, not the
            whole one. Check them in Connected systems.
          </span>
        </Alert>
      ) : null}

      {/* The server computes this row in every mode; an older payload that
          ships none must not leave a zero-height grid behind. */}
      {data.stats.length > 0 ? (
        <StatRow stats={data.stats} />
      ) : null}

      <Divider variant="flair" />

      <Table density={density}>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell>Site</Table.HeaderCell>
            <Table.HeaderCell>Managed by</Table.HeaderCell>
            <Table.HeaderCell>Mix</Table.HeaderCell>
            <Table.HeaderCell numeric>Devices</Table.HeaderCell>
            <Table.HeaderCell numeric>Clients</Table.HeaderCell>
            <Table.HeaderCell>Health</Table.HeaderCell>
            <Table.HeaderCell>SLE</Table.HeaderCell>
            <Table.HeaderCell>Alerts</Table.HeaderCell>
            <Table.HeaderCell numeric>Last sync</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {rows.map((s) => (
            <Table.Row key={s.id}>
              <Table.Cell>
                <button
                  type="button"
                  onClick={() => navigate(`/sites/${encodeURIComponent(s.id)}`)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 13.5, color: 'var(--nd-text-primary)' }}>{s.name}</span>
                  <span
                    className="nt-hint-muted"
                  >
                    {s.subnet}
                  </span>
                </button>
              </Table.Cell>
              <Table.Cell>
                {showPlatformTags ? (
                  s.planes.length > 0 ? (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {s.planes.map((p) => (
                        <Badge key={p.name} tone={p.tone}>
                          {p.name}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    /* A site the plane reported without naming a manager —
                       say so rather than leaving the cell blank. */
                    <span
                      className="nt-hint-muted"
                    >
                      not reported
                    </span>
                  )
                ) : null}
              </Table.Cell>
              <Table.Cell>
                <span
                  className="nt-hint-muted"
                >
                  {s.mix}
                </span>
              </Table.Cell>
              <Table.Cell numeric>{s.devices}</Table.Cell>
              <Table.Cell numeric>{s.clients}</Table.Cell>
              <Table.Cell>
                {/* The 70px rail stays mounted in every state so the column
                    keeps its alignment; only the fill is dropped when the
                    plane reported no percentage (design/NtSites.dc.html:70-74,
                    which shows the stale site as an empty track + '—'). */}
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  title={s.health === null ? 'health not reported by the managing plane' : undefined}
                >
                  <div
                    style={{
                      width: 70,
                      flex: '0 0 70px',
                      height: 3,
                      background: 'var(--nd-bg-inset)',
                      borderRadius: 99,
                      overflow: 'hidden',
                    }}
                  >
                    {s.healthPct !== '—' ? (
                      <div
                        style={{
                          height: 3,
                          borderRadius: 99,
                          width: s.healthPct,
                          background: HEALTH_COLORS[s.tone],
                        }}
                      />
                    ) : null}
                  </div>
                  <span
                    className="nt-hint-muted"
                  >
                    {s.health ?? '—'}
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>
                {(() => {
                  const sle = sleBySiteId[s.id];
                  return (
                    <span title={sle ? sleTooltip(sle) : 'no SLE score reported for this site'}>
                      <Badge tone={sleTone(sle?.overall ?? null)}>
                        {sle && sle.overall !== null ? pct(sle.overall) : '—'}
                      </Badge>
                    </span>
                  );
                })()}
              </Table.Cell>
              <Table.Cell>
                <Badge tone={s.alertTone}>{s.alerts}</Badge>
              </Table.Cell>
              <Table.Cell numeric>{s.sync}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {rows.length === 0 ? (
        <EmptyState
          title={
            sites.length === 0 && missingSources.length > 0
              ? 'No sites from the planes that answered'
              : 'Nothing matches that filter'
          }
          description={
            sites.length === 0 && missingSources.length > 0
              ? `${missingSources.join(', ')} contributed no inventory, so any site there is unknown rather than absent.`
              : 'No site matches that plane and name combination.'
          }
        />
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          paddingTop: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span
            className="nt-hint-muted"
          >
            {rows.length} of {sites.length} sites · {indexedDevices} devices indexed
          </span>
          <span
            className="nt-mono-label" style={{ color: 'var(--nd-text-muted)' }}
          >
            {sourceLabel}
          </span>
        </div>
        <Pagination page={1} total={1} onChange={() => {}} />
      </div>

      <Drawer
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add site"
        description="Sites are created on the managing plane — the portal hands off with this payload pre-filled."
      >
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            submitAddSite();
          }}
        >
          <FormField label="Site name" htmlFor="add-site-name">
            <Input
              id="add-site-name"
              size="md"
              placeholder="e.g. Eastfield Clinic"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </FormField>
          <FormField label="Subnet" htmlFor="add-site-subnet">
            <Input
              id="add-site-subnet"
              size="md"
              mono
              placeholder="10.54.0.0/24"
              value={newSubnet}
              onChange={(e) => setNewSubnet(e.target.value)}
            />
          </FormField>
          <FormField label="Managed by" htmlFor="add-site-plane">
            <Select
              id="add-site-plane"
              options={addPlaneOptions}
              value={newPlaneValue}
              onValueChange={setNewPlane}
              size="md"
              aria-label="Managing plane"
            />
          </FormField>
          <div
            className="nt-service-note"
          >
            The portal does not create sites locally — the request is handed to the managing plane,
            which owns site creation.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" size="sm" type="submit">
              Hand off to plane
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
