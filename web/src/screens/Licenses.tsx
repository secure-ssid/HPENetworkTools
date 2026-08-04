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
 * Rows support multi-select (x toggles) for bulk export/copy, but have no
 * primary Enter action — nothing here navigates or opens a drawer.
 * Spare-capacity toggle writes `?idle=1` so refresh / **Copy view link** reopen
 * the same slice (default hides idle zero-assignment seats). An **Idle** chip row
 * (counts idle zero-assignment seats over plane+status+q — Loop 151) toggles the
 * same `?idle=1` as the Switch. Plane Select writes `?plane=` (exact,
 * case-insensitive); a **Plane** chip row (counts over status+q+idle) toggles the
 * same `?plane=`; Status Select writes `?status=` (exact); a **Status** chip row
 * (counts over plane+q+idle universe) toggles the same `?status=`; free-text
 * `?q=` matches name/sku/plane/term/status. Filtered empties offer **Clear filters**.
 * Multi-select raises **Export selected**, **Copy SKUs** (unique newline-joined
 * product SKUs for paste into GreenLake / tickets — Devices **Copy serials**
 * pattern), **Copy names** (unique newline-joined subscription names when SKUs
 * are sparse — Sites / Auth events pattern; Loop 228), **Copy selection link**
 * (`?skus=` of unique product SKUs — Sites `?ids=` pattern; clearable chip while
 * active; Loop 172), and Clear (Loop 162).
 * Selection-empty `?skus=` offers **Clear selection filter** (Loop 210).
 * Filters ride **Download server CSV**.
 * Header **LIVE** stamps pure live and licenses blend feeds alike (Loop 166).
 * Subscriptions table carries keyboard shortcuts help (`?` / DATATABLE_ROW_SHORTCUTS
 * — Loop 192). Live empty subscriptions offer **Connected systems** (Loop 192).
 * Data: getLicenses() — live /api/licenses when the server is up, fixtures otherwise.
 */
 
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  PageSkeleton,
  Alert,
  Badge,
  Button,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  Divider,
  EmptyState,
  Input,
  KeyboardShortcuts,
  SectionHeader, Select, Switch,
  TableViewOptions,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { getLicenses } from '../api/client';
import type { LicensesData } from '../api/client';
import { hhmmLocal as hhmm, countOf } from '@hpe/shared';
import type { MistLicenseUsageRow, SubscriptionRow, Tone } from '@hpe/shared';
import { useSettings } from '../app/SettingsContext';
import { namesFilterForParam } from '../app/nav';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { exportTableCsv } from '../lib/csv';

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

/** Idle capacity is clutter only when GreenLake explicitly reports no
 * assignments. Active, expiring, and retiring records remain useful even at
 * zero, while unknown/non-numeric values are never treated as a zero. */
function isOperationalSubscription(row: SubscriptionRow): boolean {
  const assigned = row.assigned.replace(/,/g, '').trim();
  const isNumericZero = assigned !== '' && Number.isFinite(Number(assigned)) && Number(assigned) === 0;
  return !(row.status === 'idle' && isNumericZero);
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<LicensesData | null>(null);
  /** Idle zero-assignment seats are clutter by default; operators can expand. */
  const [showIdleCapacity, setShowIdleCapacity] = useState(
    () => searchParams.get('idle') === '1' || searchParams.get('idle') === 'true',
  );
  /** Plane Select — `all` omits the param; otherwise exact case-insensitive match. */
  const [plane, setPlane] = useState(() => {
    const raw = searchParams.get('plane')?.trim() ?? '';
    return raw || 'all';
  });
  /** Status Select — exact case-insensitive match on subscription status. */
  const [status, setStatus] = useState(() => {
    const raw = searchParams.get('status')?.trim() ?? '';
    return raw || 'all';
  });
  /** Free-text filter — write-back as `?q=` (min 1 char after trim). */
  const [q, setQ] = useState(() => searchParams.get('q')?.trim() ?? '');
  /* Keyboard multi-select (x toggles focused row) raises Export selected /
   * Copy SKUs / Copy selection link. */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /licenses?skus=a\nb (bulk Copy selection link). Read off the URL
   * like Sites ?ids= — must not drift from the address bar. */
  const skusFilter = namesFilterForParam(searchParams.get('skus'));

  useEffect(() => {
    let live = true;
    void getLicenses().then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, []);

  /* Keep ?idle= / ?plane= / ?status= / ?q= aligned with the filter strip so refresh and share match.
   * Selection deep-link `skus=` is URL-owned (Copy selection link) and preserved here. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (showIdleCapacity) next.set('idle', '1');
    else next.delete('idle');
    if (plane !== 'all') next.set('plane', plane);
    else next.delete('plane');
    if (status !== 'all') next.set('status', status);
    else next.delete('status');
    const qt = q.trim();
    if (qt) next.set('q', qt);
    else next.delete('q');
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [showIdleCapacity, plane, status, q, searchParams, setSearchParams]);

  const planeOptions = useMemo(() => {
    const names: string[] = [
      ...new Set((data?.subscriptions ?? []).map((s) => String(s.plane)).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    if (plane !== 'all' && !names.includes(plane)) names.unshift(plane);
    return [{ value: 'all', label: 'All planes' }, ...names.map((p) => ({ value: p, label: p }))];
  }, [data?.subscriptions, plane]);

  const statusOptions = useMemo(() => {
    const names: string[] = [
      ...new Set((data?.subscriptions ?? []).map((s) => String(s.status ?? '').trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    if (status !== 'all' && !names.includes(status)) names.unshift(status);
    return [{ value: 'all', label: 'All statuses' }, ...names.map((s) => ({ value: s, label: s }))];
  }, [data?.subscriptions, status]);

  if (!data) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const hiddenIdleCount = data.subscriptions.length - operationalSubscriptions(data).length;
  const baseSubscriptions = showIdleCapacity ? data.subscriptions : operationalSubscriptions(data);
  const planeKey = plane === 'all' ? '' : plane.trim().toLowerCase();
  const statusKey = status === 'all' ? '' : status.trim().toLowerCase();
  const qNeedle = q.trim().toLowerCase();
  const matchesQ = (s: (typeof baseSubscriptions)[number]) => {
    if (!qNeedle) return true;
    const hay = [s.name, s.sku, s.plane, s.term, s.status]
      .map((v) => String(v ?? '').toLowerCase())
      .join(' ');
    return hay.includes(qNeedle);
  };
  const matchesPlane = (s: (typeof baseSubscriptions)[number]) =>
    !planeKey || s.plane.trim().toLowerCase() === planeKey;
  const matchesStatus = (s: (typeof baseSubscriptions)[number]) =>
    !statusKey || String(s.status ?? '').trim().toLowerCase() === statusKey;
  const skusFilterLc =
    skusFilter === null ? null : skusFilter.map((sku) => sku.trim().toLowerCase()).filter(Boolean);
  const matchesSkus = (s: (typeof baseSubscriptions)[number]) =>
    skusFilterLc === null || skusFilterLc.includes((s.sku ?? '').trim().toLowerCase());
  /* Status chips count over plane+q+idle+skus (not status); plane chips over
   * status+q+idle+skus (not plane); idle chips over plane+status+q+skus on the full
   * subscription list (idle hide is the dimension under test) so each row still
   * shows the full mix while its own chip is on. Selection deep-link `skus=`
   * narrows every universe. */
  const statusUniverse = baseSubscriptions.filter((s) => matchesPlane(s) && matchesQ(s) && matchesSkus(s));
  const planeUniverse = baseSubscriptions.filter((s) => matchesStatus(s) && matchesQ(s) && matchesSkus(s));
  const subscriptions = baseSubscriptions.filter(
    (s) => matchesPlane(s) && matchesStatus(s) && matchesQ(s) && matchesSkus(s),
  );
  const idleUniverse = data.subscriptions.filter(
    (s) => matchesPlane(s) && matchesStatus(s) && matchesQ(s) && matchesSkus(s),
  );
  const idleHiddenCount = idleUniverse.filter((s) => !isOperationalSubscription(s)).length;
  const idleChips =
    idleHiddenCount > 0 || showIdleCapacity
      ? [{ key: '1' as const, label: 'Idle', tone: 'neutral' as Tone, count: idleHiddenCount }]
      : [];
  const statusTone = (raw: string): Tone => {
    const s = raw.trim().toLowerCase();
    if (s === 'active') return 'success';
    if (s === 'expiring') return 'warning';
    if (s === 'retiring') return 'danger';
    return 'neutral';
  };
  const statusChipKeys = [
    ...new Set(statusUniverse.map((s) => String(s.status ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (status !== 'all' && !statusChipKeys.includes(status)) statusChipKeys.unshift(status);
  const statusChips = statusChipKeys.map((key) => ({
    key,
    label: key,
    tone: statusTone(key),
    count: statusUniverse.filter((s) => String(s.status ?? '').trim().toLowerCase() === key.toLowerCase()).length,
  }));
  const planeChipKeys = [
    ...new Set(planeUniverse.map((s) => String(s.plane ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  if (plane !== 'all' && !planeChipKeys.includes(plane)) planeChipKeys.unshift(plane);
  const planeChips = planeChipKeys
    .map((key) => ({
      key,
      label: key,
      count: planeUniverse.filter((s) => s.plane.trim().toLowerCase() === key.toLowerCase()).length,
    }))
    .filter((c) => c.count > 0 || plane.toLowerCase() === c.key.toLowerCase());
  const skusPresent =
    skusFilter === null
      ? 0
      : skusFilter.filter((sku) =>
          data.subscriptions.some(
            (s) => (s.sku ?? '').trim().toLowerCase() === sku.trim().toLowerCase(),
          ),
        ).length;
  const clearLicenseFilters = () => {
    setShowIdleCapacity(false);
    setPlane('all');
    setStatus('all');
    setQ('');
    if (skusFilter !== null) {
      const next = new URLSearchParams(searchParams);
      next.delete('skus');
      setSearchParams(next, { replace: true });
    }
    setSelectedKeys([]);
  };

  const copyViewLink = () => {
    /* Prefer the live address bar (idle/plane/status/q write-back keeps it current); fall back
       to state when the host has not mirrored the router search (tests / edge). */
    const fallback = new URLSearchParams();
    if (showIdleCapacity) fallback.set('idle', '1');
    if (plane !== 'all') fallback.set('plane', plane);
    if (status !== 'all') fallback.set('status', status);
    if (q.trim()) fallback.set('q', q.trim());
    const fb = fallback.toString();
    const qs = window.location.search || (fb ? `?${fb}` : '');
    const url = `${window.location.origin}${window.location.pathname}${qs}`;
    void navigator.clipboard.writeText(url).then(
      () =>
        toast('View link copied', {
          description: qs.replace(/^\?/, '') || 'default licence view',
          tone: 'success',
        }),
      () => toast('Could not copy link', { description: url, tone: 'danger' }),
    );
  };

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

  const exportRenewalsCsv = () => {
    const n = exportTableCsv(
      'licences-renewals.csv',
      ['date', 'what', 'days'],
      data.renewals.map((r) => [r.date, r.what, r.days]),
    );
    toast(`Exported ${n} renewal${n === 1 ? '' : 's'}`, {
      description: 'licences-renewals.csv — soonest-first window only.',
      tone: 'success',
    });
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
        <div className="nt-stack nt-gap-2">
          <span className="nt-fs-13-primary">{l.name}</span>
          <span
            className="nt-hint-muted"
          >
            {l.sku}
          </span>
        </div>
      ),
    },
    {
      key: 'plane',
      title: 'Plane',
      render: (l) => (showPlatformTags ? <Badge plane>{l.plane}</Badge> : null),
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
          <div className="nt-row nt-gap-8">
            <div
              className="nt-license-track nt-plane-ecg"
            >
              <div
                className={
                  pctNum !== null && pctNum >= 95
                    ? 'nt-health-fill nt-plane-ecg__fill nt-license-fill nt-license-fill--hot'
                    : 'nt-health-fill nt-plane-ecg__fill nt-license-fill nt-license-fill--ok'
                }
                style={{ ['--nd-health' as string]: pctNum === null ? '0%' : `${Math.min(pctNum, 100)}%` }}
              />
            </div>
            <span
              className="nt-hint-muted"
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
    <div className="nt-stack nt-recon-reveal nt-licenses-shell nt-section-panel">
      <ScreenHeader
        overline="Inventory / Licences"
        title="Licences & subscriptions"
        subtitle="GreenLake subscriptions, controller perpetuals and Mist SUBs, reconciled against what is actually racked."
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              HPE Network Tools · entitlement
            </span>
            <Badge plane>GreenLake</Badge>
            {/* LIVE on pure live and licenses blend alike — stamp alone is easy to miss. */}
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <span
              className="nt-mono-label"
            >
              {stamp}
            </span>
            <Button variant="ghost" size="sm" onClick={copyViewLink}>
              Copy view link
            </Button>
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={data.renewals.length === 0}
              onClick={exportRenewalsCsv}
            >
              Export renewals CSV
            </Button>
            {data.dataSource === 'live' ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      /* Match the table: idle hide + optional plane/status + q filters. */
                      const qs = new URLSearchParams();
                      if (showIdleCapacity) qs.set('idle', '1');
                      if (plane !== 'all') qs.set('plane', plane);
                      if (status !== 'all') qs.set('status', status);
                      if (q.trim()) qs.set('q', q.trim());
                      const suffix = qs.toString() ? `?${qs}` : '';
                      const path = `/api/licenses/export${suffix}`;
                      const res = await downloadApiCsv(path, 'licenses.csv');
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: [
                            showIdleCapacity
                              ? 'including idle zero-assignment seats'
                              : 'operational subscriptions (idle zeros hidden)',
                            plane !== 'all' ? `plane=${plane}` : null,
                            status !== 'all' ? `status=${status}` : null,
                            q.trim() ? `q=${q.trim()}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · '),
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
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={data.renewals.length === 0}
                  onClick={() => {
                    void (async () => {
                      const res = await downloadApiCsv(
                        '/api/licenses/export?part=renewals',
                        'licenses-renewals.csv',
                      );
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'licenses-renewals.csv — renewals window.',
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
                  Download renewals CSV
                </Button>
              </>
              ) : null}
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
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </>
        }
      />

      <div className="nt-plane-theater" role="note">HPE Network Tools · entitlement theater · subscription health owns hue</div>
      <div className="nt-status-ribbon nt-licenses-ribbon" role="status" aria-label="Licenses status ribbon">
        <span className="nt-status-ribbon__item">entitlements · health owns hue</span>
        <span className="nt-status-ribbon__item">subscription capacity</span>
        <span className="nt-status-ribbon__item">planes monochrome</span>
      </div>

      {/* Five tiles on the authored path; a payload that carries fewer lays them
          out evenly rather than leaving a dead track in the grid. */}
      <StatRow stats={data.stats} />


      <div className="nt-filter-bar">
        <div className="nt-filter-field nt-filter-field--xl nt-w-220">
          <Input
            size="sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, SKU, status…"
            aria-label="Search subscriptions"
          />
        </div>
        {hiddenIdleCount > 0 ? (
          <Switch
            checked={showIdleCapacity}
            onCheckedChange={setShowIdleCapacity}
            label={`Show ${hiddenIdleCount} idle unassigned ${hiddenIdleCount === 1 ? 'subscription' : 'subscriptions'}`}
          />
        ) : null}
        {planeOptions.length > 1 ? (
          <div className="nt-filter-field nt-filter-field--md">
            <Select
              options={planeOptions}
              value={plane}
              onValueChange={setPlane}
              size="sm"
              aria-label="Subscription plane"
            />
          </div>
        ) : null}
        {statusOptions.length > 1 ? (
          <div className="nt-filter-field nt-filter-field--md">
            <Select
              options={statusOptions}
              value={status}
              onValueChange={setStatus}
              size="sm"
              aria-label="Subscription status"
            />
          </div>
        ) : null}
        {hiddenIdleCount > 0 && !showIdleCapacity ? (
          <span className="nt-body-sm nt-hint-muted">
            Hidden by default — zero-assignment idle seats are not operational inventory.
          </span>
        ) : null}
      </div>

      {idleChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Idle capacity">
          <span className="nt-chip-row__label">Idle</span>
          {idleChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setShowIdleCapacity(!showIdleCapacity)}
              className={
                showIdleCapacity ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'
              }
              aria-pressed={showIdleCapacity}
              data-idle={c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {planeChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Subscription plane">
          <span className="nt-chip-row__label">Plane</span>
          {planeChips.map((c) => {
            const active = plane.toLowerCase() === c.key.toLowerCase();
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setPlane(active ? 'all' : c.key)}
                className={active ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
                aria-pressed={active}
              >
                <Badge tone="neutral">{c.label}</Badge>
                <span className="nt-chip__count">{c.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {statusChips.length > 0 ? (
        <div className="nt-severity-chips nt-chip-row" role="group" aria-label="Subscription status">
          <span className="nt-chip-row__label">Status</span>
          {statusChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setStatus(status === c.key ? 'all' : c.key)}
              className={status === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={status === c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {isDemo ? (
        <Alert tone="warning" title="Two reconciliation gaps worth money">
          <span className="nt-body-sm">
            Six Foundation AP subscriptions are still assigned to devices decommissioned in May —
            reclaim them before the September renewal. Fourteen Warehouse switches carry no GreenLake
            record at all, which is fine for local management but means no TAC entitlement.
          </span>
        </Alert>
      ) : (
        <>
          {unchecked.length > 0 ? (
            <Alert tone="info" title="The estate comparison could not be run this cycle">
              <span className="nt-body-sm">
                {unchecked.map((u) => `${u.what} — ${u.detail}`).join('. ')}.
              </span>
            </Alert>
          ) : null}
          {gaps.length > 0 ? (
            <Alert
              tone="warning"
              title={`${countOf(gaps.length, 'reconciliation gap')} worth money`}
            >
              <span className="nt-body-sm">
                {gaps.map((g) => `${g.what} — ${g.detail}`).join('. ')}.
              </span>
            </Alert>
          ) : unchecked.length === 0 ? (
            /* Only reachable with the comparison genuinely run and clean —
               with an `unchecked` row above, "not reported by this plane"
               would be a second, false explanation for the same silence. */
            <Alert tone="info" title="Reconciliation gaps are not reported by this plane">
              <span className="nt-body-sm">
                The subscriptions feed carries seat totals but no device assignments, so orphaned
                subscriptions and unlicensed devices cannot be computed from live data.
              </span>
            </Alert>
          ) : null}
        </>
      )}

      {skusFilter !== null ? (
        <div className="nt-chip-row" role="group" aria-label="Selection deep link">
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('skus');
              setSearchParams(next, { replace: true });
            }}
            title={skusFilter.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {skusPresent === skusFilter.length
              ? `${skusFilter.length} selected SKU${skusFilter.length === 1 ? '' : 's'}`
              : `${skusPresent} of ${skusFilter.length} selected SKUs present`}
            {' — clear'}
          </button>
        </div>
      ) : null}
      <DataTable
        ariaLabel="Subscriptions"
        density={density}
        columns={licenseColumns}
        rows={subscriptions}
        rowKey={(l) => rowIds.get(l) ?? l.name}
        columnsConfig={tableColumns.licenses}
        onColumnsConfigChange={(config) => setTableColumns('licenses', config)}
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        rowTone={(l) => l.tone}
      />
      {selectedKeys.length > 0 ? (
        <div
          className="nt-configure-bulk-bar nt-bulk-glass"
          role="region"
          aria-label="Subscription selection actions"
        >
          <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
          <span className="nt-configure-bulk-bar__hint">
            export, copy SKUs, copy names, or share a selection link for only the subscriptions you marked — full list export stays in the header
          </span>
          <span className="nt-configure-bulk-bar__actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const selected = new Set(selectedKeys);
                const picked = subscriptions.filter((l) => selected.has(rowIds.get(l) ?? l.name));
                if (picked.length === 0) {
                  toast('No selected subscriptions still in view', {
                    description: 'Clear selection or adjust filters.',
                    tone: 'info',
                  });
                  return;
                }
                const n = exportTableCsv(
                  'licences-subscriptions-selected.csv',
                  ['name', 'sku', 'plane', 'term', 'qty', 'assigned', 'utilisation', 'expires', 'status'],
                  picked.map((l) => [
                    l.name,
                    l.sku,
                    l.plane,
                    l.term,
                    l.qty,
                    l.assigned,
                    l.pct,
                    l.expires,
                    l.status,
                  ]),
                );
                toast(`Exported ${countOf(n, 'selected subscription')}`, {
                  description: 'licences-subscriptions-selected.csv — seat fields only.',
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
                  const selected = new Set(selectedKeys);
                  const picked = subscriptions.filter((l) => selected.has(rowIds.get(l) ?? l.name));
                  if (picked.length === 0) {
                    toast('No selected subscriptions still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const skus = [
                    ...new Set(
                      picked
                        .map((l) => (l.sku ?? '').trim())
                        .filter((sku) => sku && sku !== '—'),
                    ),
                  ];
                  if (skus.length === 0) {
                    toast('No SKUs on the selected subscriptions', {
                      description: 'Those rows did not publish a product SKU — use Copy names or export CSV instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const text = skus.join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    toast(`Copied ${countOf(skus.length, 'SKU')}`, {
                      description:
                        skus.length < picked.length
                          ? `${picked.length - skus.length} selected without a SKU skipped`
                          : 'newline-joined · paste into GreenLake or a ticket',
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy SKUs', { description: text, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy SKUs
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const selected = new Set(selectedKeys);
                  const picked = subscriptions.filter((l) => selected.has(rowIds.get(l) ?? l.name));
                  if (picked.length === 0) {
                    toast('No selected subscriptions still in view', {
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
                    toast('No names on the selected subscriptions', {
                      description: 'Those rows did not publish a subscription name — export CSV instead.',
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
                          ? `${picked.length - names.length} selected without a name skipped`
                          : 'newline-joined · paste into GreenLake or a ticket',
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
                  const selected = new Set(selectedKeys);
                  const picked = subscriptions.filter((l) => selected.has(rowIds.get(l) ?? l.name));
                  if (picked.length === 0) {
                    toast('No selected subscriptions still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const skus = [
                    ...new Set(
                      picked
                        .map((l) => (l.sku ?? '').trim())
                        .filter((sku) => sku && sku !== '—'),
                    ),
                  ];
                  if (skus.length === 0) {
                    toast('No SKUs on the selected subscriptions', {
                      description: 'Those rows did not publish a product SKU — use Copy names or export CSV instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const next = new URLSearchParams(searchParams);
                  next.set('skus', skus.join('\n'));
                  const qs = next.toString();
                  const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Selection link copied', {
                      description: `${skus.length} SKU${skus.length === 1 ? '' : 's'} · skus=`,
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
            <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
              Clear
            </Button>
          </span>
        </div>
      ) : null}
      {subscriptions.length === 0 ? (
        <EmptyState
          title={
            data.subscriptions.length > 0 && skusFilter !== null
              ? 'No subscriptions match this selection'
              : 'No subscriptions to show'
          }
          description={
            data.subscriptions.length > 0 && skusFilter !== null
              ? 'Clear the selection filter to restore the subscription list under the current search / plane / status filters.'
              : data.subscriptions.length > 0
                ? q.trim() || plane !== 'all' || status !== 'all'
                  ? 'No subscriptions match the active search / plane / status filter (and idle hide, when on).'
                  : 'All reported subscriptions are idle with zero assigned seats.'
                : sectionLive
                  ? 'GreenLake has not returned a subscription list yet — check the plane on Connected systems.'
                  : 'This payload carries no subscription rows.'
          }
        >
          {data.subscriptions.length > 0 && skusFilter !== null ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('skus');
                setSearchParams(next, { replace: true });
                setSelectedKeys([]);
              }}
            >
              Clear selection filter
            </Button>
          ) : data.subscriptions.length > 0 &&
            (q.trim() || plane !== 'all' || status !== 'all') ? (
            <Button variant="secondary" size="sm" onClick={clearLicenseFilters}>
              Clear filters
            </Button>
          ) : data.subscriptions.length === 0 && sectionLive ? (
            <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
              Connected systems
            </Button>
          ) : null}
        </EmptyState>
      ) : null}

      {/* Mist's per-site consumption of those subscriptions — the table above
          broken down by site. Four payload states, kept distinct: the key
          absent (an older server never sent the section — hide it rather than
          invent a state), null (Mist reported nothing this cycle), an empty
          list (Mist answered; no site carries a usage row), and the rows. */}
      {data.mistLicenseUsages !== undefined ? (
        <div className="nt-stack nt-gap-2">
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
                className="nt-license-row"
              >
                <div className="nt-flex-1">
                  <div
                    className="nt-fs-12-pri"
                  >
                    {u.siteName}
                  </div>
                  <div
                    className="nt-hint-muted"
                  >
                    {usageDevicePart(u)}
                  </div>
                </div>
                <span className="nt-mono-11 nt-ta-right-sec">
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

      <div className="nt-form-grid nt-row nt-licenses-split">
        <div className="nt-stack nt-gap-2">
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
            <div key={`${r.date}|${r.what}|${i}`} className="nt-renewal-row">
              <span className="nt-renewal-row__date">{r.date}</span>
              <span className="nt-renewal-row__what">{r.what}</span>
              <span
                className="nt-renewal-row__days"
                data-urgency={
                  r.color.includes('danger')
                    ? 'danger'
                    : r.color.includes('warning')
                      ? 'warning'
                      : 'muted'
                }
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

        <div className="nt-stack nt-gap-2">
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
              className="nt-license-row-start"
            >
              <Badge tone={o.tone}>{o.tag}</Badge>
              <div className="nt-flex-1">
                <div
                  className="nt-fs-12-pri"
                >
                  {o.what}
                </div>
                <div
                  className="nt-hint-muted"
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

      {/* Reference material and advisory panels sit below the data they
          describe. Rendered above it they pushed the primary table several
          hundred pixels down the page — on a queue screen the queue is what
          the operator came for, not the suggestions about it. */}
      <VisualReferencePanel target={{ kind: 'estate', id: 'licenses' }} editable />
      <ConfigRecommendationsPanel title="Licence / inventory recommendations" category="inventory" limit={8} />
    </div>
  );
}
