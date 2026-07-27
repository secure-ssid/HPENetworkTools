/**
 * web/src/screens/Licenses.tsx — GreenLake subscriptions, controller
 * perpetuals and Mist SUBs reconciled against what is racked. High-fidelity
 * port of design/NtLicenses.dc.html: five Stats, a warning Alert naming the
 * two gaps that cost money, the open subscriptions table (name + mono SKU,
 * plane Badge, term, numeric qty/assigned, 80×3px utilisation bar amber ≥95%,
 * mono expires, status Badge), then flair → two columns: "Renewals, soonest
 * first" (mono date, what, mono days coloured by urgency) and "Orphans & gaps"
 * (tag Badge + what + mono detail, ghost "Reclaim all" → honest hand-off
 * toast). Export CSV downloads the table client-side; Reconcile with
 * GreenLake is an honest hand-off toast (GreenLake is a read-only plane).
 * Data: getLicenses() — live /api/licenses when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Divider, SectionHeader, Spinner, Stat, Table, useToast } from '../nightdesk';
import { getLicenses } from '../api/client';
import type { LicensesData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Inventory / Licences"
        title="Licences & subscriptions"
        subtitle="GreenLake subscriptions, controller perpetuals and Mist SUBs, reconciled against what is actually racked."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
            <Button variant="primary" size="sm" onClick={reconcile}>
              Reconcile with GreenLake
            </Button>
          </>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: 18,
        }}
      >
        {data.stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} deltaTone={s.tone} />
        ))}
      </div>

      <Alert tone="warning" title="Two reconciliation gaps worth money">
        <span style={{ fontSize: 13 }}>
          Six Foundation AP subscriptions are still assigned to devices decommissioned in May —
          reclaim them before the September renewal. Fourteen Warehouse switches carry no GreenLake
          record at all, which is fine for local management but means no TAC entitlement.
        </span>
      </Alert>

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
          {data.subscriptions.map((l) => (
            <Table.Row key={l.sku}>
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
                        width: l.pct,
                        background:
                          parseInt(l.pct, 10) >= 95 ? 'var(--nd-warning)' : 'var(--nd-success)',
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
          ))}
        </Table.Body>
      </Table>

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
          <SectionHeader label="Renewals, soonest first" meta="NEXT 180 DAYS" />
          {data.renewals.map((r) => (
            <div
              key={r.date}
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
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader
            label="Orphans & gaps"
            meta={
              <Button variant="ghost" size="sm" onClick={reclaimAll}>
                Reclaim all
              </Button>
            }
          />
          {data.orphans.map((o) => (
            <div
              key={o.what}
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
        </div>
      </div>
    </div>
  );
}
