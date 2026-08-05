/**
 * web/src/screens/central/ApplicationsSection.tsx — the Central screen's
 * application-visibility section: a picker over the estate's Central sites
 * driving the SAME on-demand DPI read the site page uses
 * (/api/sites/:siteId/applications), rendered by the SAME shared table
 * (central/dpi.tsx).
 *
 * The fetch discipline is the site page's own: one read when the section
 * mounts for the default site and one per picker change, never a poll — the
 * route pages the Central DPI endpoint behind its TTL cache and call-budget
 * gate. Every no-table outcome is its own honest sentence, never an empty
 * table.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, SectionHeader, Select, Skeleton, useToast } from '../../nightdesk';
import { getSiteApplications, type SiteApplicationsResult } from '../../api/client';
import { countOf, detailHasRows, detailState } from '@hpe/shared';
import type { CentralSiteRow } from '@hpe/shared';
import { exportTableCsv } from '../../lib/csv';
import { DpiApplicationsBody, dpiSectionNote } from './dpi';

const APP_CSV_HEADERS = [
  'siteId',
  'name',
  'id',
  'risk',
  'riskRaw',
  'state',
  'rxBytes',
  'txBytes',
  'totalBytes',
  'categories',
  'applicationHostType',
  'destLocation',
  'experience',
  'lastUsedAt',
  'tlsVersion',
  'certificateExpiryAt',
] as const;

export function ApplicationsSection({
  sites,
  sitesReported,
}: {
  /** The estate's Central sites — the picker's universe. */
  sites: CentralSiteRow[];
  /** False when the pull did not carry the site list: the picker cannot
   *  name a site to read, and says so instead of guessing one. */
  sitesReported: boolean;
}) {
  const { toast } = useToast();
  const options = useMemo(
    () => sites.map((s) => ({ value: s.siteId, label: s.siteName })),
    [sites],
  );
  /* The operator's pick, or the first site until they make one — derived at
   * render, never re-seated by an effect: a pick that leaves the list (a
   * re-polled payload renaming the sites) falls back to the first site on
   * its own. */
  const [picked, setPicked] = useState<string | null>(null);
  const selected =
    picked !== null && options.some((o) => o.value === picked)
      ? picked
      : (options[0]?.value ?? null);

  /* The settled read, tagged with the site it answered for. The effect only
   * ever sets it from async callbacks, so a site change renders the spinner
   * (selected ≠ read.site) until the new read lands — never the previous
   * site's table under the new site's name. */
  const [read, setRead] = useState<{ site: string; result: SiteApplicationsResult } | null>(null);
  useEffect(() => {
    if (selected === null) return;
    let live = true;
    void getSiteApplications(selected)
      .then((r) => {
        if (live) setRead({ site: selected, result: r });
      })
      .catch(() => {
        if (live) setRead({ site: selected, result: { kind: 'failed', message: 'the applications request failed' } });
      });
    return () => {
      live = false;
    };
  }, [selected]);
  const result = selected !== null && read?.site === selected ? read.result : null;

  const appsState =
    result?.kind === 'ok' ? detailState(result.applications.source, 'apps') : null;
  const hasTable =
    result?.kind === 'ok' &&
    detailHasRows(result.applications.source, 'apps', result.applications.apps);
  const meta =
    options.length === 0
      ? sitesReported
        ? 'NO SITES'
        : 'NOT REPORTED'
      : result === null
        ? 'READING…'
        : result.kind === 'not-reported'
          ? 'NOT REPORTED'
          : result.kind === 'failed'
            ? 'READ FAILED'
            : appsState === 'ok'
              ? `${countOf(result.applications.apps?.length ?? 0, 'APP').toUpperCase()} · CENTRAL DPI`
              : (appsState ?? '').toUpperCase().replace('-', ' ');

  const copySectionLink = () => {
    const url = `${window.location.origin}/central?section=applications#applications`;
    void navigator.clipboard.writeText(url).then(
      () =>
        toast('Applications section link copied', {
          description: 'section=applications',
          tone: 'success',
        }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  const exportCsv = () => {
    if (!hasTable || result?.kind !== 'ok' || selected === null) return;
    const apps = result.applications.apps ?? [];
    const n = exportTableCsv(
      `central-applications-${selected}.csv`,
      [...APP_CSV_HEADERS],
      apps.map((a) => [
        selected,
        a.name,
        a.id,
        a.risk,
        a.riskRaw ?? '',
        a.state ?? '',
        a.rxBytes ?? '',
        a.txBytes ?? '',
        a.totalBytes ?? '',
        a.categories.join(';'),
        a.applicationHostType ?? '',
        a.destLocation.join(';'),
        a.experience ?? '',
        a.lastUsedAt ?? '',
        a.tlsVersion ?? '',
        a.certificateExpiryAt ?? '',
      ]),
    );
    toast(`Exported ${n} app${n === 1 ? '' : 's'}`, {
      description: 'Client-side CSV of the loaded DPI table for the selected site.',
    });
  };

  return (
    <div id="central-section-applications" className="nt-stack nt-gap-10 nt-central-section nt-section-panel">
      <div className="nt-status-ribbon nt-status-ribbon--compact nt-central-apps-ribbon" role="status" aria-label="Central apps status ribbon">
        <span className="nt-status-ribbon__item">Central DPI</span>
        <span className="nt-status-ribbon__item">app visibility</span>
      </div>
      <div className="nt-row-between-12">
        <SectionHeader label="Application visibility" meta={meta} />
        <div className="nt-wrap-6">
          <Button variant="ghost" size="sm" onClick={copySectionLink}>
            Copy section link
          </Button>
          {hasTable ? (
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
          ) : null}
        </div>
      </div>
      {options.length === 0 && !sitesReported ? (
        <div className="nt-service-note">
          Central did not report its site list this cycle, so no site can be named for the DPI
          read. The site page runs the same read for a site it already knows.
        </div>
      ) : options.length === 0 ? (
        <div className="nt-service-note">
          Central reported no sites — there is no site to read application data for. DPI is
          site-scoped: a site the plane does not manage has no application table.
        </div>
      ) : (
        <>
          <div className="nt-row nt-gap-10">
            <span className="nt-hint-muted">SITE</span>
            <Select
              size="sm"
              aria-label="Site for the application read"
              options={options}
              value={selected ?? undefined}
              onValueChange={(value) => setPicked(value)}
            />
          </div>
          {result === null ? (
            <div className="nt-center-pad-24">
              <div role="status" aria-label="HPE Network Tools · loading applications" className="nt-stack nt-gap-6 nt-debug-wake nt-debug-wake--compact">
                <Skeleton height={12} width="30%" />
                <Skeleton height={28} />
              </div>
            </div>
          ) : result.kind === 'not-reported' ? (
            <div className="nt-service-note">
              No application table was reported for this site — Central publishes one only for a
              site it manages.
            </div>
          ) : result.kind === 'failed' ? (
            <div className="nt-service-note nt-danger-text">
              {`The application read failed — ${result.message}`}
            </div>
          ) : detailHasRows(result.applications.source, 'apps', result.applications.apps) ? (
            <DpiApplicationsBody applications={result.applications} />
          ) : (
            <div className="nt-service-note">{dpiSectionNote(result.applications)}</div>
          )}
        </>
      )}
    </div>
  );
}
