/**
 * web/src/screens/central/SitesSection.tsx — the Central screen's per-site
 * summary: device/client counts and the worst health PER THE PLANE'S OWN
 * ROWS (never the cross-plane merge — this screen is what Central sees).
 * Rows click through to the site page. Multi-select raises **Export selected**,
 * **Copy names** (unique newline-joined site names for hand-offs — Devices
 * **Copy serials** pattern), **Copy selection link** (`?ids=` of marked site
 * ids — Sites `?ids=` pattern; keeps `section=sites`; clearable chip while
 * active; Loop 178), and Clear (Loop 174). Selection-empty `?ids=` deep
 * links offer **Clear selection filter** (Loop 207).
 *
 * Honest states, the screen's standing rule: a dataset the pull did not
 * carry is named ("not reported"), an empty list the pull DID carry is a
 * real answer, and a null count renders '—' rather than a zero the plane
 * never claimed.
 */

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, DataTable, EmptyState, SectionHeader, useToast } from '../../nightdesk';
import type { DataTableColumn } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { CentralDataset, CentralSiteRow, Tone } from '@hpe/shared';
import { namesFilterForParam } from '../../app/nav';
import { exportTableCsv } from '../../lib/csv';

/** Health badge tone — the same 90/70 breaks the Sites screen's bar uses. */
function healthTone(healthPct: number): Tone {
  return healthPct >= 90 ? 'success' : healthPct >= 70 ? 'warning' : 'danger';
}

const siteColumns: Array<DataTableColumn<CentralSiteRow>> = [
  { key: 'site', title: 'Site', hideable: false, render: (s) => s.siteName },
  { key: 'devices', title: 'Devices', numeric: true, render: (s) => s.devices },
  {
    key: 'clients',
    title: 'Clients',
    numeric: true,
    render: (s) => (s.clients === null ? '—' : s.clients),
  },
  {
    key: 'health',
    title: 'Health',
    render: (s) =>
      s.healthPct === null ? (
        <span className="nt-service-note">—</span>
      ) : (
        <Badge tone={healthTone(s.healthPct)}>{`${s.healthPct}%`}</Badge>
      ),
  },
  {
    key: 'alerts',
    title: 'Open alerts',
    render: (s) =>
      s.openAlerts === null ? (
        <span className="nt-service-note">—</span>
      ) : s.openAlerts === 0 ? (
        <Badge tone="success">clear</Badge>
      ) : (
        <Badge tone="warning">{countOf(s.openAlerts, 'open')}</Badge>
      ),
  },
];

export function SitesSection({
  sites,
  notReported,
  density,
}: {
  sites: CentralSiteRow[];
  notReported: CentralDataset[];
  density: 'comfortable' | 'compact';
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /central?section=sites&ids=a\nb (bulk Copy selection link). */
  const idsFilter = namesFilterForParam(searchParams.get('ids'));
  const rows =
    idsFilter === null ? sites : sites.filter((s) => idsFilter.includes(s.siteId));
  const idsPresent =
    idsFilter === null ? 0 : idsFilter.filter((id) => sites.some((s) => s.siteId === id)).length;
  const sitesUnreported = notReported.includes('sites');
  const shortInputs = (['devices', 'clients', 'alerts'] as const).filter((k) =>
    notReported.includes(k),
  );
  const meta =
    sitesUnreported && sites.length === 0
      ? 'NOT REPORTED'
      : sites.length === 0
        ? 'NONE'
        : idsFilter !== null
          ? `${countOf(rows.length, 'SITE').toUpperCase()} OF ${sites.length} · CENTRAL`
          : `${countOf(sites.length, 'SITE').toUpperCase()} · CENTRAL`;

  const copySectionLink = () => {
    const url = `${window.location.origin}/central?section=sites#sites`;
    void navigator.clipboard.writeText(url).then(
      () => toast('Sites section link copied', { description: 'section=sites', tone: 'success' }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  const exportCsv = () => {
    if (rows.length === 0) return;
    const n = exportTableCsv(
      'central-sites.csv',
      ['siteId', 'siteName', 'devices', 'clients', 'healthPct', 'openAlerts'],
      rows.map((s) => [
        s.siteId,
        s.siteName,
        s.devices,
        s.clients ?? '',
        s.healthPct ?? '',
        s.openAlerts ?? '',
      ]),
    );
    toast(`Exported ${n} site${n === 1 ? '' : 's'}`, {
      description: 'central-sites.csv — Central site summary on this screen.',
    });
  };

  return (
    <div id="central-section-sites" className="nt-stack nt-gap-2 nt-central-section nt-section-panel">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">HPE Network Tools · Central sites lane · estate slice</div>
      <div className="nt-status-ribbon nt-status-ribbon--compact nt-central-sites-ribbon" role="status" aria-label="Central sites status ribbon">
        <span className="nt-status-ribbon__item">Central sites</span>
        <span className="nt-status-ribbon__item">estate slice</span>
      </div>
      <div className="nt-row-between-12">
        <SectionHeader label="Sites" meta={meta} />
        <div className="nt-wrap-6">
          <Button variant="ghost" size="sm" onClick={copySectionLink}>
            Copy section link
          </Button>
          {rows.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
          ) : null}
        </div>
      </div>
      {sitesUnreported && sites.length === 0 ? (
        <div className="nt-service-note">
          Central did not report its site list this cycle — a failed read, or no linked plane. No
          site counts can be asserted.
        </div>
      ) : sites.length === 0 ? (
        <div className="nt-service-note">
          Central reported no sites and no devices or clients at any site — a real answer, not a
          failed read.
        </div>
      ) : (
        <>
          {shortInputs.length > 0 ? (
            <div className="nt-service-note nt-pad-4-0">
              {`Short by what the pull did not carry: ${shortInputs.join(', ')} — the counts below cover only what Central reported.`}
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
                  setSelectedKeys([]);
                }}
                title={idsFilter.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {idsPresent === idsFilter.length
                  ? `${idsFilter.length} selected site${idsFilter.length === 1 ? '' : 's'}`
                  : `${idsPresent} of ${idsFilter.length} selected sites present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          {rows.length === 0 ? (
            <EmptyState
              title="No sites match this selection"
              description="Clear the selection filter to restore the full Central site roster."
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('ids');
                  setSearchParams(next, { replace: true });
                  setSelectedKeys([]);
                }}
              >
                Clear selection filter
              </Button>
            </EmptyState>
          ) : (
            <DataTable
              ariaLabel="Central sites"
              density={density}
              columns={siteColumns}
              rows={rows}
              rowKey={(s) => s.siteId}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
              onRowActivate={(s) => navigate(`/sites/${encodeURIComponent(s.siteId)}`)}
            />
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Central site selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy names, or share a selection link for only the sites you marked — full list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((s) => selected.has(s.siteId));
                    if (picked.length === 0) {
                      toast('No selected sites still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'central-sites-selected.csv',
                      ['siteId', 'siteName', 'devices', 'clients', 'healthPct', 'openAlerts'],
                      picked.map((s) => [
                        s.siteId,
                        s.siteName,
                        s.devices,
                        s.clients ?? '',
                        s.healthPct ?? '',
                        s.openAlerts ?? '',
                      ]),
                    );
                    toast(`Exported ${countOf(n, 'selected site')}`, {
                      description: 'central-sites-selected.csv — Central site summary fields only.',
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
                      const picked = rows.filter((s) => selected.has(s.siteId));
                      if (picked.length === 0) {
                        toast('No selected sites still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const names = [
                        ...new Set(
                          picked
                            .map((s) => (s.siteName ?? '').trim())
                            .filter((name) => name && name !== '—'),
                        ),
                      ];
                      if (names.length === 0) {
                        toast('No names on the selected sites', {
                          description: 'Those rows did not publish a site name — export CSV for ids instead.',
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
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((s) => selected.has(s.siteId));
                      if (picked.length === 0) {
                        toast('No selected sites still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('ids', picked.map((s) => s.siteId).join('\n'));
                      next.set('section', 'sites');
                      const qs = next.toString();
                      const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${picked.length} site${picked.length === 1 ? '' : 's'} · ids=`,
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
          <div className="nt-service-note nt-fs-105-pt6">
            Counts are Central&rsquo;s own rows; health is the share of its known-state devices that
            are up.
          </div>
        </>
      )}
    </div>
  );
}
