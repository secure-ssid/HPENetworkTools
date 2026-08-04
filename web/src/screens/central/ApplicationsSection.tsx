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
import { SectionHeader, Select, Spinner } from '../../nightdesk';
import { getSiteApplications, type SiteApplicationsResult } from '../../api/client';
import { countOf, detailHasRows, detailState } from '@hpe/shared';
import type { CentralSiteRow } from '@hpe/shared';
import { DpiApplicationsBody, dpiSectionNote } from './dpi';

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

  return (
    <div className="nt-stack nt-gap-10">
      <SectionHeader label="Application visibility" meta={meta} />
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
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <Spinner size="sm" />
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
