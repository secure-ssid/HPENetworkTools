/**
 * web/src/screens/siteDetail/Applications.tsx — the site page's Central DPI
 * application-visibility section.
 *
 * The section is the ONLY caller of the lazy applications endpoint — the
 * route pages the Central DPI endpoint at 200 rows a call, so nothing here
 * fetches on the poll cadence. It reads once, when the section mounts for a
 * Central-claimed site; a site no Central badge claims has no DPI source at
 * all and says so without spending a call.
 *
 * The table itself (risk strip, watchlist, top talkers, rollup) is shared
 * with the Central screen's own application-visibility section and lives in
 * central/dpi.tsx — one rendering, two fetch disciplines.
 *
 * The honesty rules mirror the portal's other on-demand reads:
 *  - the payload's `source.sections.apps` picks the sentence — 'ok' renders
 *    the table, 'empty' is the plane's authoritative no-traffic answer,
 *    'failed' says the call broke, 'not-fetched' says we chose not to ask
 *    (the call budget is spent);
 *  - the route answering 404 / `applications: null` is "not reported", a
 *    straight sentence rather than an empty table;
 *  - the read itself failing is a failure sentence, never an empty table.
 */

import { useEffect, useState } from 'react';
import { SectionHeader, Spinner } from '../../nightdesk';
import { getSiteApplications, type SiteApplicationsResult } from '../../api/client';
import { countOf, detailHasRows, detailState } from '@hpe/shared';
import { DpiApplicationsBody, dpiSectionNote } from '../central/dpi';
import { noteStyle } from '../central/style';

/**
 * The application-visibility section: the site's Central DPI table, fetched
 * when the section mounts. Rendered for every site — a site no Central badge
 * claims gets the honest not-reported line, and costs no call.
 */
export function SiteApplications({
  centralClaimed,
  siteKey,
}: {
  /** True when a Central badge claims the site — the only plane that runs
   *  DPI. Gates the fetch: a non-Central site never spends a call. */
  centralClaimed: boolean;
  /** The key the route resolves — the canonical site id. */
  siteKey: string;
}) {
  /* The read result, null = in flight. Keyed by siteKey through the effect:
   * navigating site-to-site re-reads (the server TTL-caches, so a revisit
   * inside the window costs no plane call). */
  const [result, setResult] = useState<SiteApplicationsResult | null>(null);

  useEffect(() => {
    if (!centralClaimed) return;
    let live = true;
    void getSiteApplications(siteKey)
      .then((r) => {
        if (live) setResult(r);
      })
      .catch(() => {
        if (live) setResult({ kind: 'failed', message: 'the applications request failed' });
      });
    return () => {
      live = false;
    };
  }, [centralClaimed, siteKey]);

  const appsState =
    result?.kind === 'ok' ? detailState(result.applications.source, 'apps') : null;
  const meta = !centralClaimed
    ? 'NOT REPORTED'
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
      {!centralClaimed ? (
        <div style={noteStyle}>No linked plane publishes DPI application data for this site.</div>
      ) : result === null ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <Spinner size="sm" />
        </div>
      ) : result.kind === 'not-reported' ? (
        <div style={noteStyle}>
          No application table was reported for this site — Central publishes one only for a site it
          manages.
        </div>
      ) : result.kind === 'failed' ? (
        <div style={{ ...noteStyle, color: 'var(--nd-danger)' }}>
          {`The application read failed — ${result.message}`}
        </div>
      ) : detailHasRows(result.applications.source, 'apps', result.applications.apps) ? (
        <DpiApplicationsBody applications={result.applications} />
      ) : (
        <div style={noteStyle}>{dpiSectionNote(result.applications)}</div>
      )}
    </div>
  );
}
