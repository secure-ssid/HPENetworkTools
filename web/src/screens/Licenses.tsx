/**
 * web/src/screens/Licenses.tsx — GreenLake subscriptions, controller
 * perpetuals and Mist SUBs reconciled against what is racked. High-fidelity
 * port of design/NtLicenses.dc.html: five Stats, a warning Alert naming the
 * gaps that cost money (the authored two-gap prose on the demo path, otherwise
 * derived from data.orphans), the subscriptions table (name + mono SKU,
 * plane Badge, term, numeric qty/assigned, 80×3px utilisation bar amber ≥95%,
 * mono expires, status Badge), then Mist's per-site subscription usage (the
 * one plane publishing /licenses/usages: per-service consumption against the
 * fully-loaded demand, honest '—' where the row stated no count, and a muted
 * not-reported state when Mist contributed nothing), then flair → two
 * columns: "Renewals, soonest
 * first" (mono date, what, mono days coloured by urgency) and "Orphans & gaps"
 * (tag Badge + what + mono detail, ghost "Reclaim all" → honest hand-off
 * toast). Export CSV downloads the table client-side; Reconcile with
 * GreenLake is an honest hand-off toast (reconcile/reclaim are not portal
 * operations — the GreenLake tab writes individual objects, not bulk licence
 * reassignment).
 *
 * The subscriptions table is the nightdesk DataTable: the column manager
 * (View options in the header actions → show/hide/reorder, header-edge
 * resize) persists through SettingsContext under the 'licenses' table id.
 * Two columns tint — utilisation and expiry — because they are the two cells
 * with a genuine threshold; the cutoffs are documented on the tint fns below.
 * The rows are deliberately NOT a keyboard grid: a subscription row has no
 * primary action (nothing here navigates or opens), and inventing one would
 * put a shortcut overlay up that lies about what Enter does.
 * Data: getLicenses() — live /api/licenses when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Divider,
  EmptyState,
  SectionHeader,
  Spinner,
  TableViewOptions,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { getLicenses } from '../api/client';
import type { LicensesData } from '../api/client';
import { hhmmLocal as hhmm, countOf } from '@hpe/shared';
import type { MistLicenseUsageRow, SubscriptionRow, Tone } from '@hpe/shared';
import { useSettings } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';

/**
 * The renewals panel caption, read off the payload rather than asserted. The
 * live route filters to a 180-day window, so the window may be named — but
 * "nothing due" is only honest when at least one subscription carries a date;
 * with none, the horizon was never observed and the caption says so.
 */
function renewalsMeta(data: LicensesData): string {
  if (data.renewals.length > 0) return `NEXT 180 DAYS · ${data.renewals.length}`;
  const dated = data.subscriptions.filter((s) => s.expires && s.expires !== '—').length;
  return dated > 0 ? 'NEXT 180 DAYS · NOTHING DUE' : 'NO DATED SUBSCRIPTIONS';
}

/** GreenLake formats the utilisation figure for display ('97%'); '—' means it
 *  reported no quantity or assignment count, which is not a number. */
function pctValue(pct: string): number | null {
  return /^\d+(\.\d+)?%$/.test(pct) ? Number.parseFloat(pct) : null;
}

/** A retired entitlement is operational clutter only when GreenLake explicitly
 * marks it expired and reports no assigned seats. Missing or non-numeric
 * assignments stay visible because they are not evidence of unused capacity. */
function isOperationalSubscription(row: SubscriptionRow): boolean {
  const assigned = row.assigned.replace(/,/g, '').trim();
  const isNumericZero = assigned !== '' && Number.isFinite(Number(assigned)) && Number(assigned) === 0;
  return !((row.status as string) === 'expired' && isNumericZero);
}

function operationalSubscriptions(data: LicensesData): SubscriptionRow[] {
  return data.subscriptions.filter(isOperationalSubscription);
}

/* The utilisation tint cutoffs. The 95% line is the utilisation bar's own
   (the fill paints amber at ≥95%, green below): at 95% the pool is nearly
   exhausted and the next assignment has nowhere to go. Over 100% is a
   different fact again — more seats are consumed than the pool holds — which
   the bar caps at a full fill and only a tint can say. Below 95% the pool has
   headroom, the bar's green. No figure ('—') is no judgement, never a healthy
   pool — the same call the bar's empty track makes. */
function utilisationTint(pct: string): Tone | null {
  const value = pctValue(pct);
  if (value === null) return null;
  if (value > 100) return 'danger';
  if (value >= 95) return 'warning';
  return 'success';
}

/* The expiry tint is the row's OWN status tone — the badge the payload
   already computed from its days-to-expiry judgement (the entitlement
   adapter's expiring-soon badge horizon, 90 days): 'expiring' washes warning,
   'retiring' danger, 'active' success, 'idle' neutral. Keying the tint on the
   same field the Status badge renders means the cell and the badge can never
   disagree, and the cutoffs stay where they are made — server-side, not
   re-parsed here from a display date ('support 31 Jan 27' does not parse
   honestly). */
function expiryTint(l: SubscriptionRow): Tone {
  return l.tone;
}

/* The two counts a usage row may carry, each omitted when the row did not
   carry it. A row with neither says so — '0 devices' would be a claim Mist
   never made. */
function usageDevicePart(row: MistLicenseUsageRow): string {
  const parts = [
    row.numDevices !== null ? countOf(row.numDevices, 'device') : null,
    row.numAps !== null ? countOf(row.numAps, 'AP') : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : 'device counts not reported';
}

/* One site's per-service consumption against its fully-loaded demand, e.g.
   'SUB-SW 22 / 24'. The service list is the union of the two maps: an explicit
   0 is a real reported count and renders as one (Southpoint's SUB-SW 0 / 4 is
   the four unassigned wired SUBs the orphan list names), while a service named
   only by the demand map renders its consumption as '—' — the row did not
   state it, and a fabricated 0 would read as "nothing consumed". */
function usageServicePart(row: MistLicenseUsageRow): string {
  if (row.usages === null) return 'consumption not reported';
  const usages = row.usages;
  const services = [...new Set([...Object.keys(usages), ...Object.keys(row.fullyLoaded ?? {})])];
  return services
    .map((service) => {
      const used = usages[service];
      const demand = row.fullyLoaded?.[service];
      const usedText = typeof used === 'number' ? String(used) : '—';
      return typeof demand === 'number' ? `${service} ${usedText} / ${demand}` : `${service} ${usedText}`;
    })
    .join(' · ');
}

export default function Licenses() {
  const { density, showPlatformTags, tableColumns, setTableColumns } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<LicensesData | null>(null);

  useEffect(() => {
    let live = true;
    void getLicenses().then((d) => {
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

  const subscriptions = operationalSubscriptions(data);

  const exportCsv = () => {
    const header = 'name,sku,plane,term,qty,assigned,utilisation,expires,status';
    const lines = subscriptions.map((l) =>
      [l.name, l.sku, l.plane, l.term, l.qty, l.assigned, l.pct, l.expires, l.status]
        .map((v) => `"${v.replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'licences-subscriptions.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const reconcile = () =>
    toast('Reconcile runs on GreenLake', {
      description: 'Bulk reassignment is not a portal operation — handing off with the current assignment report.',
    });

  const reclaimAll = () => toast('Reclaim runs on GreenLake — hand-off queued');

  // The authored two-gap prose describes the fixture ORPHANS rows, so it may
  // only run on the authored path; a blended licences payload is real GreenLake
  // data pasted into this page and must not carry demo counts above it.
  const sectionLive = data.dataSource === 'live' || (data.blended?.includes('licenses') ?? false);
  const isDemo = !sectionLive;
  // Provenance is part of the answer on a screen fed by a single plane:
  // fixtures, blended GreenLake rows and a fully live pull otherwise render
  // identically (README design rule 1).
  const stamp = sectionLive
    ? `GREENLAKE ${data.syncedAt ? hhmm(data.syncedAt) : 'NOT SYNCED'}`
    : 'DEMO FIXTURES';
  // Gaps that cost money are the orphaned and unlicensed rows; an `idle` row is
  // spare capacity, not a reconciliation gap, and an `unchecked` row is the
  // server saying it could not run the comparison at all — counting that as a
  // gap "worth money" would put a number on findings nobody made.
  const gaps = data.orphans.filter((o) => o.tag !== 'idle' && o.tag !== 'unchecked');
  // The server emits these when it could not compare entitlements against the
  // estate at all. They are the reason the money-gap count below may be short,
  // so they get their own line rather than sitting unexplained in the list.
  const unchecked = data.orphans.filter((o) => o.tag === 'unchecked');

  /* The subscriptions table as DataTable defs. 'Subscription' is the primary
     identifier — always visible, never offered for hiding; the manager
     persists against these keys under the 'licenses' table id, so renaming a
     label never orphans a saved layout. Only the two threshold columns tint;
     the cutoffs live on the tint fns above. */
  const licenseColumns: Array<DataTableColumn<SubscriptionRow>> = [
    {
      key: 'subscription',
      title: 'Subscription',
      hideable: false,
      render: (l) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>{l.name}</span>
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              color: 'var(--nd-text-muted)',
            }}
          >
            {l.sku}
          </span>
        </div>
      ),
    },
    {
      key: 'plane',
      title: 'Plane',
      render: (l) => (showPlatformTags ? <Badge tone={l.planeTone}>{l.plane}</Badge> : null),
    },
    { key: 'term', title: 'Term', render: (l) => l.term },
    { key: 'qty', title: 'Qty', numeric: true, render: (l) => l.qty },
    { key: 'assigned', title: 'Assigned', numeric: true, render: (l) => l.assigned },
    {
      key: 'utilisation',
      title: 'Utilisation',
      tint: (l) => utilisationTint(l.pct),
      render: (l) => {
        // GreenLake emits '—' when it reports no quantity or assignment
        // count. That is not a CSS length, so feeding it to the fill div used
        // to paint a full green bar — an unknown utilisation reading as a
        // healthy, fully-used pool. Parse once and leave the track empty when
        // there is no figure; the mono label still says '—'.
        const pctNum = pctValue(l.pct);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 80,
                height: 3,
                background: 'var(--nd-bg-inset)',
                borderRadius: 99,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: 3,
                  borderRadius: 99,
                  width: pctNum === null ? 0 : `${Math.min(pctNum, 100)}%`,
                  background:
                    pctNum !== null && pctNum >= 95 ? 'var(--nd-warning)' : 'var(--nd-success)',
                }}
              />
            </div>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {l.pct}
            </span>
          </div>
        );
      },
    },
    { key: 'expires', title: 'Expires', numeric: true, tint: expiryTint, render: (l) => l.expires },
    {
      key: 'status',
      title: 'Status',
      render: (l) => <Badge tone={l.tone}>{l.status}</Badge>,
    },
  ];

  // GreenLake's SKU is a product number, not a key: two subscription keys for
  // the same product share it, and an unresolved one is '—' on every row.
  // DataTable's rowKey sees no index, so the identity the compound Table keyed
  // on — the row's own fields plus its position — is mapped once here.
  const rowIds = new Map<SubscriptionRow, string>(
    subscriptions.map((l, i) => [l, `${l.sku}|${l.name}|${l.expires}|${i}`] as const),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Inventory / Licences"
        title="Licences & subscriptions"
        subtitle="GreenLake subscriptions, controller perpetuals and Mist SUBs, reconciled against what is actually racked."
        actions={
          <>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-10)',
                color: 'var(--nd-text-muted)',
                letterSpacing: '.08em',
              }}
            >
              {stamp}
            </span>
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
            <Button variant="primary" size="sm" onClick={reconcile}>
              Reconcile with GreenLake
            </Button>
            {/* The column manager for the table below lives up here with the
                table's other actions — this screen has no filter row. */}
            <TableViewOptions
              columns={licenseColumns}
              config={tableColumns.licenses ?? {}}
              onChange={(config) => setTableColumns('licenses', config)}
            />
          </>
        }
      />

      {/* Five tiles on the authored path; a payload that carries fewer lays them
          out evenly rather than leaving a dead track in the grid. */}
      <StatRow stats={data.stats} />

      {isDemo ? (
        <Alert tone="warning" title="Two reconciliation gaps worth money">
          <span style={{ fontSize: 13 }}>
            Six Foundation AP subscriptions are still assigned to devices decommissioned in May —
            reclaim them before the September renewal. Fourteen Warehouse switches carry no GreenLake
            record at all, which is fine for local management but means no TAC entitlement.
          </span>
        </Alert>
      ) : (
        <>
          {unchecked.length > 0 ? (
            <Alert tone="info" title="The estate comparison could not be run this cycle">
              <span style={{ fontSize: 13 }}>
                {unchecked.map((u) => `${u.what} — ${u.detail}`).join('. ')}.
              </span>
            </Alert>
          ) : null}
          {gaps.length > 0 ? (
            <Alert
              tone="warning"
              title={`${countOf(gaps.length, 'reconciliation gap')} worth money`}
            >
              <span style={{ fontSize: 13 }}>
                {gaps.map((g) => `${g.what} — ${g.detail}`).join('. ')}.
              </span>
            </Alert>
          ) : unchecked.length === 0 ? (
            /* Only reachable with the comparison genuinely run and clean —
               with an `unchecked` row above, "not reported by this plane"
               would be a second, false explanation for the same silence. */
            <Alert tone="info" title="Reconciliation gaps are not reported by this plane">
              <span style={{ fontSize: 13 }}>
                The subscriptions feed carries seat totals but no device assignments, so orphaned
                subscriptions and unlicensed devices cannot be computed from live data.
              </span>
            </Alert>
          ) : null}
        </>
      )}

      <DataTable
        ariaLabel="Subscriptions"
        density={density}
        columns={licenseColumns}
        rows={subscriptions}
        rowKey={(l) => rowIds.get(l) ?? l.name}
        columnsConfig={tableColumns.licenses}
        onColumnsConfigChange={(config) => setTableColumns('licenses', config)}
      />
      {subscriptions.length === 0 ? (
        <EmptyState
          title="No subscriptions in the cache"
          description={
            sectionLive
              ? 'GreenLake has not returned a subscription list yet — check the plane on Connected systems.'
              : 'This payload carries no subscription rows.'
          }
        />
      ) : null}

      {/* Mist's per-site consumption of those subscriptions — the table above
          broken down by site. Four payload states, kept distinct: the key
          absent (an older server never sent the section — hide it rather than
          invent a state), null (Mist reported nothing this cycle), an empty
          list (Mist answered; no site carries a usage row), and the rows. */}
      {data.mistLicenseUsages !== undefined ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader
            label="Mist per-site subscription usage"
            meta={
              data.mistLicenseUsages === null
                ? 'NOT REPORTED'
                : data.mistLicenseUsages.length === 0
                  ? 'NO USAGE ROWS'
                  : `${data.mistLicenseUsages.length} ${data.mistLicenseUsages.length === 1 ? 'SITE' : 'SITES'} · USED / FULLY-LOADED`
            }
          />
          {data.mistLicenseUsages !== null && data.mistLicenseUsages.length > 0 ? (
            data.mistLicenseUsages.map((u) => (
              <div
                key={u.siteId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 0',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 'var(--nd-text-12)',
                      color: 'var(--nd-text-primary)',
                      lineHeight: 1.4,
                    }}
                  >
                    {u.siteName}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {usageDevicePart(u)}
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-text-secondary)',
                    textAlign: 'right',
                  }}
                >
                  {usageServicePart(u)}
                </span>
              </div>
            ))
          ) : (
            <EmptyState
              title={data.mistLicenseUsages === null ? 'Mist licence usage not reported' : 'No per-site usage rows'}
              description={
                data.mistLicenseUsages === null
                  ? 'No linked Mist plane contributed a licences/usages read this cycle — per-site consumption is unknown, not zero.'
                  : 'Mist answered the licences/usages read with no site rows.'
              }
            />
          )}
        </div>
      ) : null}

      <Divider variant="flair" />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 34,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* 'NEXT 180 DAYS' is the authored window and true of the fixture
              list. The live route now enforces the same window server-side
              (screens.ts RENEWAL_WINDOW_DAYS), so live mode may name it too —
              with the count it actually holds. An empty live list is two
              different facts: nothing falls due inside the window, or no
              subscription carries an expiry date at all, and only the second
              one leaves the horizon unknown. */}
          <SectionHeader
            label="Renewals, soonest first"
            meta={sectionLive ? renewalsMeta(data) : 'NEXT 180 DAYS'}
          />
          {/* Live expiry dates are month-precision, so two subscriptions
              expiring in the same month collide on `date` alone. */}
          {data.renewals.map((r, i) => (
            <div
              key={`${r.date}|${r.what}|${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 0',
                borderBottom: '1px solid var(--nd-border-subtle)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: 'var(--nd-text-secondary)',
                  width: 78,
                  flex: '0 0 78px',
                }}
              >
                {r.date}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
                {r.what}
              </span>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: r.color,
                }}
              >
                {r.days}
              </span>
            </div>
          ))}
          {data.renewals.length === 0 ? (
            <EmptyState
              title="No dated renewals"
              description="No subscription in the cache carries an expiry date, so nothing can be ranked by urgency."
            />
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader
            label="Orphans & gaps"
            meta={
              <Button
                variant="ghost"
                size="sm"
                onClick={reclaimAll}
                disabled={data.orphans.length === 0}
              >
                Reclaim all
              </Button>
            }
          />
          {data.orphans.map((o, i) => (
            <div
              key={`${o.tag}|${o.what}|${i}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '10px 0',
                borderBottom: '1px solid var(--nd-border-subtle)',
              }}
            >
              <Badge tone={o.tone}>{o.tag}</Badge>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 'var(--nd-text-12)',
                    color: 'var(--nd-text-primary)',
                    lineHeight: 1.4,
                  }}
                >
                  {o.what}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-10)',
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {o.detail}
                </div>
              </div>
            </div>
          ))}
          {data.orphans.length === 0 ? (
            <EmptyState
              title="Nothing to reclaim"
              description={
                sectionLive
                  ? 'The subscriptions feed carries no device assignments, so orphans and gaps cannot be computed.'
                  : 'No orphaned assignments or licensing gaps in this payload.'
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
