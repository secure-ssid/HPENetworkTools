/**
 * web/src/screens/Licenses.tsx — GreenLake subscriptions, controller
 * perpetuals and Mist SUBs reconciled against what is racked. High-fidelity
 * port of design/NtLicenses.dc.html: five Stats, a warning Alert naming the
 * gaps that cost money (the authored two-gap prose on the demo path, otherwise
 * derived from data.orphans), the open subscriptions table (name + mono SKU,
 * plane Badge, term, numeric qty/assigned, 80×3px utilisation bar amber ≥95%,
 * mono expires, status Badge), then flair → two columns: "Renewals, soonest
 * first" (mono date, what, mono days coloured by urgency) and "Orphans & gaps"
 * (tag Badge + what + mono detail, ghost "Reclaim all" → honest hand-off
 * toast). Export CSV downloads the table client-side; Reconcile with
 * GreenLake is an honest hand-off toast (GreenLake is a read-only plane).
 * Data: getLicenses() — live /api/licenses when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Divider,
  EmptyState,
  SectionHeader,
  Spinner,
  Table,
  useToast,
} from '../nightdesk';
import { getLicenses } from '../api/client';
import type { LicensesData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

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

export default function Licenses() {
  const { density, showPlatformTags } = useSettings();
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

  const exportCsv = () => {
    const header = 'name,sku,plane,term,qty,assigned,utilisation,expires,status';
    const lines = data.subscriptions.map((l) =>
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
      description: 'Read-only plane — the portal hands off with the current assignment report.',
    });

  const reclaimAll = () => toast('Reclaim runs on GreenLake — hand-off queued');

  // The authored two-gap prose describes the fixture ORPHANS rows, so it may
  // only run on the authored path; a blended licences payload is real GreenLake
  // data pasted into this page and must not carry demo counts above it.
  const sectionLive = data.dataSource === 'live' || (data.blended?.includes('licenses') ?? false);
  const isDemo = !sectionLive;
  // Provenance is part of the answer on a screen fed by one read-only plane:
  // fixtures, blended GreenLake rows and a fully live pull otherwise render
  // identically (README design rule 1).
  const stamp = sectionLive
    ? `GREENLAKE ${data.syncedAt ? hhmm(data.syncedAt) : 'NOT SYNCED'}`
    : 'DEMO FIXTURES';
  // Gaps that cost money are the orphaned and unlicensed rows; an `idle` row is
  // spare capacity, not a reconciliation gap.
  const gaps = data.orphans.filter((o) => o.tag !== 'idle');

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
      ) : gaps.length > 0 ? (
        <Alert
          tone="warning"
          title={`${gaps.length} reconciliation gap${gaps.length === 1 ? '' : 's'} worth money`}
        >
          <span style={{ fontSize: 13 }}>
            {gaps.map((g) => `${g.what} — ${g.detail}`).join('. ')}.
          </span>
        </Alert>
      ) : (
        <Alert tone="info" title="Reconciliation gaps are not reported by this plane">
          <span style={{ fontSize: 13 }}>
            The subscriptions feed carries seat totals but no device assignments, so orphaned
            subscriptions and unlicensed devices cannot be computed from live data.
          </span>
        </Alert>
      )}

      <Table density={density}>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell>Subscription</Table.HeaderCell>
            <Table.HeaderCell>Plane</Table.HeaderCell>
            <Table.HeaderCell>Term</Table.HeaderCell>
            <Table.HeaderCell numeric>Qty</Table.HeaderCell>
            <Table.HeaderCell numeric>Assigned</Table.HeaderCell>
            <Table.HeaderCell>Utilisation</Table.HeaderCell>
            <Table.HeaderCell numeric>Expires</Table.HeaderCell>
            <Table.HeaderCell>Status</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {data.subscriptions.map((l, i) => {
            // GreenLake emits '—' when it reports no quantity or assignment
            // count. That is not a CSS length, so feeding it to the fill div
            // used to paint a full green bar — an unknown utilisation reading
            // as a healthy, fully-used pool. Parse once and leave the track
            // empty when there is no figure; the mono label still says '—'.
            const pctNum = /^\d+(\.\d+)?%$/.test(l.pct) ? Number.parseFloat(l.pct) : null;
            return (
            // GreenLake's SKU is a product number, not a key: two subscription
            // keys for the same product share it, and an unresolved one is '—'
            // on every row. Key on the row's own identity plus its position.
            <Table.Row key={`${l.sku}|${l.name}|${l.expires}|${i}`}>
              <Table.Cell>
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
              </Table.Cell>
              <Table.Cell>
                {showPlatformTags ? <Badge tone={l.planeTone}>{l.plane}</Badge> : null}
              </Table.Cell>
              <Table.Cell>{l.term}</Table.Cell>
              <Table.Cell numeric>{l.qty}</Table.Cell>
              <Table.Cell numeric>{l.assigned}</Table.Cell>
              <Table.Cell>
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
              </Table.Cell>
              <Table.Cell numeric>{l.expires}</Table.Cell>
              <Table.Cell>
                <Badge tone={l.tone}>{l.status}</Badge>
              </Table.Cell>
            </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
      {data.subscriptions.length === 0 ? (
        <EmptyState
          title="No subscriptions in the cache"
          description={
            sectionLive
              ? 'GreenLake has not returned a subscription list yet — check the plane on Connected systems.'
              : 'This payload carries no subscription rows.'
          }
        />
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
