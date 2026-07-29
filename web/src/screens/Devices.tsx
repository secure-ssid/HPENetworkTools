/**
 * web/src/screens/Devices.tsx — unified inventory with two presentations.
 * High-fidelity port of design/NtDevices.dc.html: header SegmentedControl
 * ("Unified table" | "Platform lanes") bound to the global inventoryView
 * setting (the prototype's local-override bug is not carried over), filter
 * row (search, type, plane, site, "Reconciliation issues only" Switch, mono
 * `N of M indexed` count), warning Alert with the reconciliation truth
 * (counts from the payload's reconciliation block — live reconciler totals, or
 * the authored estate figures in demo, never a tally of the sample rows), then
 * either the open unified table (every claiming plane in Managed by, plus a
 * double-claimed / no-cloud-plane marker beside State) or the platform-lanes
 * grid (one lane per plane the payload published lane meta for — INCLUDING a
 * linked plane that reported nothing, which is the gap the view exists to
 * show — meta from the payload's lanes map, 2px bottom rule in the plane's
 * mark colour, 520px own scroll). Filters are local, instant and additive
 * (AND) and search every key the placeholder advertises (name, model, site,
 * serial, MAC, management IP); an empty table shows the EmptyState. The header
 * subtitle states the authored estate totals in demo and is derived from the
 * payload in live/blend — it never asserts a fixture count over real data.
 * Data: getDevices() — live /api/devices when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  EmptyState,
  Input,
  SegmentedControl,
  Select,
  Spinner,
  Switch,
  Table,
  useToast,
} from '../nightdesk';
import { getDevices, savePortalSettings } from '../api/client';
import type { DevicesData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import type { InventoryView } from '../app/SettingsContext';
import { deviceDetailPath, planeFilterForParam } from '../app/nav';
import { UNKNOWN_LANE_META } from '../../../shared';
import type { DeviceRow, Plane, Tone } from '../../../shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import '../app/app.css';

function displayField(value: string): string {
  const normal = value.trim().toLowerCase();
  return !value || normal === '—' || normal === 'unknown' ? 'Not reported' : value;
}

const VIEW_OPTIONS = [
  { value: 'Unified table', label: 'Unified table' },
  { value: 'Platform lanes', label: 'Platform lanes' },
];

/** Lane-row state dot per Badge tone (prototype `dotFor` map). */
const DOT_COLORS: Record<Tone, string> = {
  success: 'var(--nd-success)',
  warning: 'var(--nd-warning)',
  danger: 'var(--nd-danger)',
  info: 'var(--nd-info)',
  neutral: 'var(--nd-border-strong)',
  accent: 'var(--nd-accent)',
};

/** Fallback for a plane the payload carries no lane meta for. Honesty rule 1:
 *  a lane with no freshness stamp says so — it never claims to be linked. The
 *  shared constant is the same one the server's live lane builder falls back
 *  to, so the two copies cannot drift. */
const FALLBACK_LANE = UNKNOWN_LANE_META;

/** Every plane that claims this row. The reconciler ships `claimedBy` on live
 *  rows; the authored fixtures encode the double claim in `state` instead and
 *  carry no claimant list, so they fall back to the single display plane. */
function claimantsOf(d: DeviceRow): Plane[] {
  return d.claimedBy?.length ? d.claimedBy : [d.plane];
}

/** Row-level reconciliation marker (design rule 2 — one flagged row, never a
 *  duplicate), or null when the row reconciles cleanly. Only rows carrying a
 *  claimant list get one: the fixtures already say 'double-claimed' in State. */
function reconciliationMark(d: DeviceRow): { label: string; tone: Tone } | null {
  if (!d.claimedBy || !d.reconciliationIssue) return null;
  return d.claimedBy.length > 1
    ? { label: 'double-claimed', tone: 'danger' }
    : { label: 'no cloud plane', tone: 'warning' };
}

export default function Devices() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { density, inventoryView, setInventoryView, showPlatformTags } = useSettings();
  const [data, setData] = useState<DevicesData | null>(null);
  const [searchParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [plane, setPlane] = useState(() => planeFilterForParam(searchParams.get('plane')));
  const [site, setSite] = useState('all');
  const [issuesOnly, setIssuesOnly] = useState(false);

  // Hide a fixture row from the demo inventory (persisted server-side);
  // optimistic local update, rollback on failure.
  const hideDevice = async (name: string) => {
    if (!data) return;
    const prev = data;
    setData({
      ...data,
      devices: data.devices.filter((d) => d.name !== name),
      hiddenDevices: [...(data.hiddenDevices ?? []), name],
    });
    const res = await savePortalSettings({
      hiddenDemoDevices: [...(prev.hiddenDevices ?? []), name],
    });
    if (!res.ok) {
      setData(prev);
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(`${name} hidden from the demo inventory`, {
      description: 'bring it back from the hidden chip in the filter row.',
      tone: 'info',
    });
  };

  const restoreHidden = async () => {
    if (!data) return;
    const res = await savePortalSettings({ hiddenDemoDevices: [] });
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    const fresh = await getDevices();
    setData(fresh);
    toast('Hidden demo devices restored', { tone: 'success' });
  };

  useEffect(() => {
    let live = true;
    void getDevices().then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, []);

  /* Deep link: /devices?plane=<registryId> (from the Systems plane drawer). */
  useEffect(() => {
    const pp = searchParams.get('plane');
    if (pp !== null) setPlane(planeFilterForParam(pp));
  }, [searchParams]);

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const devices = data.devices;
  const isDemo =
    data.dataSource === 'demo' && !(data.blended?.includes('devices') ?? false);
  const hiddenCount = data.hiddenDevices?.length ?? 0;
  const ql = q.trim().toLowerCase();
  // The placeholder promises name, model, serial and ip — so all four are
  // searched. Serial/MAC/IP are optional on the row (fixtures carry none, live
  // adapters carry what their plane published), and a MAC pasted from another
  // tool rarely uses the same separators, so a separator-stripped pass runs
  // alongside the literal one.
  const qlBare = ql.replace(/[^a-z0-9]/g, '');
  const matchesQuery = (d: DeviceRow): boolean => {
    if (!ql) return true;
    const hay = [d.name, d.model, d.siteName, d.serial ?? '', d.mac ?? '', d.ip ?? '']
      .join(' ')
      .toLowerCase();
    if (hay.includes(ql)) return true;
    return qlBare.length >= 6 && hay.replace(/[^a-z0-9 ]/g, '').includes(qlBare);
  };
  const rows = devices.filter(
    (d) =>
      (type === 'all' || d.type === type) &&
      (plane === 'all' || d.plane === plane) &&
      (site === 'all' || d.siteId === site) &&
      (!issuesOnly || d.reconciliationIssue) &&
      matchesQuery(d),
  );

  const uniq = <T,>(xs: T[]): T[] => xs.filter((v, i, a) => a.indexOf(v) === i);
  const typeOptions = [{ value: 'all', label: 'All types' }].concat(
    uniq(devices.map((d) => d.type)).map((t) => ({ value: t, label: t })),
  );
  const planeOptions = [{ value: 'all', label: 'All planes' }].concat(
    uniq(devices.map((d) => d.plane)).map((p) => ({ value: p, label: p })),
  );
  const siteOptions = [{ value: 'all', label: 'All sites' }].concat(
    uniq(devices.map((d) => d.siteId)).map((id) => ({
      value: id,
      label: devices.find((d) => d.siteId === id)?.siteName ?? id,
    })),
  );

  // Reconciliation truth, always from the payload. Every envelope carries it
  // now — live and blend ship the reconciler's real counts, the demo route and
  // this client's offline demo fallback ship the authored estate figures (the
  // 28 fixture rows are a SAMPLE of 418, so counting them would undercount —
  // the prose below says "Fourteen"). Only a payload that carries none at all
  // falls through to a tally of the loaded rows.
  const reconciliation = data.reconciliation;
  const doubleClaimed =
    reconciliation?.doubleClaimed ??
    devices.filter((d) => d.state === 'double-claimed' || (d.claimedBy?.length ?? 0) > 1).length;
  const unclaimed =
    reconciliation?.unclaimed ?? devices.filter((d) => d.licence === 'not in greenlake').length;

  // One lane per plane the payload published lane meta for — INCLUDING a
  // linked plane that reported no inventory at all, which is exactly the gap
  // the lanes view exists to make legible (a lane that vanishes reads as "no
  // such plane"). Planes present in the rows but missing from the lanes map
  // append with the non-asserting fallback meta.
  const present = uniq(devices.map((d) => d.plane));
  const lanePlanes: Plane[] = (Object.keys(data.lanes) as Plane[]).concat(
    present.filter((p) => !(p in data.lanes)),
  );

  // Header subtitle. The authored line states the demo estate's totals (418
  // devices are a 418-row estate the 28 fixtures sample); in live/blend mode
  // it is derived from what actually arrived, never asserted.
  const subtitle = isDemo
    ? '418 devices, six inventories, one reconciled list.'
    : `${devices.length} device${devices.length === 1 ? '' : 's'}, ${lanePlanes.length} inventor${
        lanePlanes.length === 1 ? 'y' : 'ies'
      }, one reconciled list.`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Inventory / Devices"
        title="Devices"
        subtitle={subtitle}
        actions={
          <SegmentedControl
            options={VIEW_OPTIONS}
            value={inventoryView}
            onValueChange={(v) => setInventoryView(v as InventoryView)}
            ariaLabel="Inventory presentation"
          />
        }
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 250 }}>
          <Input
            size="sm"
            mono
            placeholder="name, model, serial, ip…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div style={{ width: 140 }}>
          <Select
            options={typeOptions}
            value={type}
            onValueChange={setType}
            size="sm"
            aria-label="Device type"
          />
        </div>
        <div style={{ width: 150 }}>
          <Select
            options={planeOptions}
            value={plane}
            onValueChange={setPlane}
            size="sm"
            aria-label="Managed by"
          />
        </div>
        <div style={{ width: 190 }}>
          <Select
            options={siteOptions}
            value={site}
            onValueChange={setSite}
            size="sm"
            aria-label="Site"
          />
        </div>
        <Switch
          label="Reconciliation issues only"
          size="sm"
          checked={issuesOnly}
          onCheckedChange={setIssuesOnly}
        />
        {isDemo && hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => void restoreHidden()}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-accent-text)',
            }}
          >
            {hiddenCount} hidden — restore
          </button>
        ) : null}
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-muted)',
          }}
        >
          {rows.length} of {devices.length} indexed{isDemo ? ' · 418 total incl. bulk APs' : ''}
        </span>
      </div>

      {doubleClaimed > 0 || unclaimed > 0 ? (
        <Alert
          tone="warning"
          title={`Reconciliation: ${doubleClaimed} device${doubleClaimed === 1 ? '' : 's'} claimed by two inventories, ${unclaimed} by none`}
        >
          <span style={{ fontSize: 13 }}>
            {isDemo
              ? 'sw-riv-2, ap-riv-01 and ap-riv-06 exist in both Central Classic and the local collector with different firmware records. Fourteen Warehouse switches appear in no cloud plane at all — they are only visible over SSH.'
              : 'These counts come from the current live inventory reconciliation. Open an affected device to inspect its reporting planes and identity evidence.'}
          </span>
        </Alert>
      ) : null}

      {inventoryView === 'Unified table' ? (
        <>
          <Table density={density}>
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Device</Table.HeaderCell>
                <Table.HeaderCell>Model</Table.HeaderCell>
                <Table.HeaderCell>Type</Table.HeaderCell>
                <Table.HeaderCell>Site</Table.HeaderCell>
                <Table.HeaderCell>Managed by</Table.HeaderCell>
                <Table.HeaderCell>State</Table.HeaderCell>
                <Table.HeaderCell>Firmware</Table.HeaderCell>
                <Table.HeaderCell>Licence</Table.HeaderCell>
                {isDemo ? <Table.HeaderCell>{''}</Table.HeaderCell> : null}
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {rows.map((d) => {
                const claims = claimantsOf(d);
                const mark = reconciliationMark(d);
                return (
                  <Table.Row key={`${d.name}:${d.serial ?? d.plane}`}>
                    <Table.Cell>
                      <button
                        type="button"
                        onClick={() => navigate(deviceDetailPath({ name: d.name, plane: d.plane, serial: d.serial }))}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 'var(--nd-text-12)',
                          color: 'var(--nd-accent-text)',
                          textAlign: 'left',
                        }}
                      >
                        {d.name}
                      </button>
                    </Table.Cell>
                    <Table.Cell>{displayField(d.model)}</Table.Cell>
                    <Table.Cell>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                          textTransform: 'uppercase',
                        }}
                      >
                        {d.type}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <button
                        type="button"
                        onClick={() => navigate(`/sites/${encodeURIComponent(d.siteId)}`)}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          fontFamily: 'var(--nd-font-body)',
                          fontSize: 'var(--nd-text-12)',
                          color: 'var(--nd-text-primary)',
                          textAlign: 'left',
                        }}
                      >
                        {displayField(d.siteName)}
                      </button>
                    </Table.Cell>
                    <Table.Cell>
                      {showPlatformTags ? (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {claims.map((p) => (
                            <Badge key={p} tone={p === d.plane ? d.planeTone : 'neutral'}>
                              {p}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <Badge tone={d.stateTone} dot>
                          {d.state}
                        </Badge>
                        {mark ? <Badge tone={mark.tone}>{mark.label}</Badge> : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 'var(--nd-text-11)',
                          color:
                            displayField(d.firmware) === 'Not reported' || d.firmwareApproved
                              ? 'var(--nd-text-secondary)'
                              : 'var(--nd-warning)',
                        }}
                      >
                        {displayField(d.firmware)}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 10.5,
                          color: 'var(--nd-text-muted)',
                        }}
                      >
                        {displayField(d.licence)}
                      </span>
                    </Table.Cell>
                    {isDemo ? (
                      <Table.Cell>
                        <button
                          type="button"
                          onClick={() => void hideDevice(d.name)}
                          aria-label={`Hide ${d.name} from the demo inventory`}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 10.5,
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            color: 'var(--nd-text-muted)',
                          }}
                        >
                          hide
                        </button>
                      </Table.Cell>
                    ) : null}
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing matches that filter"
              description="Loosen the search or the type, plane and site filters to see the rest of the inventory."
            />
          ) : null}
        </>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(196px, 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
          {lanePlanes.map((p) => {
            const meta = data.lanes[p] ?? FALLBACK_LANE;
            const inLane = rows.filter((d) => d.plane === p);
            // "Nothing here" has two different meanings and the lane must not
            // conflate them: the plane reported no inventory at all, or the
            // local filters excluded the rows it did report.
            const planeReportedNothing = !present.includes(p);
            return (
              <div key={p} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    paddingBottom: 9,
                    borderBottom: `2px solid ${meta.mark}`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-11)',
                        letterSpacing: '.1em',
                        textTransform: 'uppercase',
                        color: 'var(--nd-text-primary)',
                      }}
                    >
                      {p}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-11)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {inLane.length} shown
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Badge tone={meta.tone} dot>
                      {meta.sync}
                    </Badge>
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-10)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {meta.note}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    maxHeight: 520,
                    overflow: 'auto',
                  }}
                >
                  {inLane.map((d) => (
                    <button
                      key={`${d.name}:${d.serial ?? d.plane}`}
                      type="button"
                      className="nt-rowlink"
                      onClick={() => navigate(deviceDetailPath({ name: d.name, plane: d.plane, serial: d.serial }))}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                        alignItems: 'stretch',
                        textAlign: 'left',
                        background: 'none',
                        border: 'none',
                        borderBottom: '1px solid var(--nd-border-subtle)',
                        borderLeft: '2px solid transparent',
                        padding: '9px 8px',
                        cursor: 'pointer',
                        width: '100%',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 11.5,
                            color: 'var(--nd-text-primary)',
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {d.name}
                        </span>
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 99,
                            background: DOT_COLORS[d.stateTone],
                            flex: '0 0 6px',
                          }}
                        />
                      </div>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-body)',
                          fontSize: 'var(--nd-text-11)',
                          color: 'var(--nd-text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {displayField(d.model)}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 'var(--nd-text-10)',
                          color: 'var(--nd-text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {displayField(d.siteName)}
                      </span>
                    </button>
                  ))}
                  {inLane.length === 0 ? (
                    <div
                      style={{
                        padding: '12px 4px',
                        fontFamily: 'var(--nd-font-display)',
                        fontStyle: 'italic',
                        fontSize: 'var(--nd-text-12)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {planeReportedNothing
                        ? 'No inventory reported by this plane.'
                        : 'Nothing in this lane matches the filter.'}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
