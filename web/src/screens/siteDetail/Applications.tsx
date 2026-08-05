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
import { Button, SectionHeader, Skeleton, useToast } from '../../nightdesk';
import { getSiteApplications, type SiteApplicationsResult } from '../../api/client';
import { countOf, detailHasRows, detailState } from '@hpe/shared';
import { DpiApplicationsBody, dpiSectionNote } from '../central/dpi';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import { exportTableCsv } from '../../lib/csv';

/** Canonical share target for the site applications section. */
export function siteApplicationsSectionUrl(
  pathname: string = typeof window !== 'undefined' ? window.location.pathname : '',
): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const base = pathname || '/sites';
  return `${origin}${base}?section=applications#applications`;
}

const APP_CSV_HEADERS = [
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

/**
 * The application-visibility section: the site's Central DPI table, fetched
 * when the section mounts. Rendered for every site — a site no Central badge
 * claims gets the honest not-reported line, and costs no call.
 */
export function SiteApplications({
  centralClaimed,
  siteKey,
  live = false,
}: {
  /** True when a Central badge claims the site — the only plane that runs
   *  DPI. Gates the fetch: a non-Central site never spends a call. */
  centralClaimed: boolean;
  /** The key the route resolves — the canonical site id. */
  siteKey: string;
  /** True when the parent site envelope is live/blend — gates server CSV. */
  live?: boolean;
}) {
  const { toast } = useToast();
  /* The read result, null = in flight. Keyed by siteKey through the effect:
   * navigating site-to-site re-reads (the server TTL-caches, so a revisit
   * inside the window costs no plane call). */
  const [result, setResult] = useState<SiteApplicationsResult | null>(null);

  useEffect(() => {
    if (!centralClaimed) return;
    let active = true;
    void getSiteApplications(siteKey)
      .then((r) => {
        if (active) setResult(r);
      })
      .catch(() => {
        if (active) setResult({ kind: 'failed', message: 'the applications request failed' });
      });
    return () => {
      active = false;
    };
  }, [centralClaimed, siteKey]);

  const appsState =
    result?.kind === 'ok' ? detailState(result.applications.source, 'apps') : null;
  const hasTable =
    result?.kind === 'ok' &&
    detailHasRows(result.applications.source, 'apps', result.applications.apps);
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

  const copySectionLink = () => {
    const url = siteApplicationsSectionUrl();
    void navigator.clipboard.writeText(url).then(
      () =>
        toast('Applications section link copied', {
          description: 'section=applications',
          tone: 'success',
        }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  return (
    <div className="nt-site-section nt-section-panel nt-stack nt-gap-10">
      <div className="nt-status-ribbon nt-status-ribbon--compact nt-apps-ribbon" role="status" aria-label="Applications status ribbon">
        <span className="nt-status-ribbon__item">apps · DPI</span>
        <span className="nt-status-ribbon__item">share owns attention</span>
      </div>
      <div className="nt-row-between-8">
        <SectionHeader label="Application visibility" meta={meta} />
        <div className="nt-wrap-6">
          <Button variant="ghost" size="sm" onClick={copySectionLink}>
            Copy section link
          </Button>
          {hasTable && result?.kind === 'ok' ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const apps = result.applications.apps ?? [];
                  const n = exportTableCsv(
                    `site-applications-${siteKey}.csv`,
                    [...APP_CSV_HEADERS],
                    apps.map((a) => [
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
                    description: 'Client-side CSV of the loaded DPI table.',
                  });
                }}
              >
                Export CSV
              </Button>
              {live ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const res = await downloadApiCsv(
                        `/api/sites/${encodeURIComponent(siteKey)}/applications/export`,
                        `site-applications-${siteKey}.csv`,
                      );
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: `site-applications-${siteKey}.csv — portal DPI export.`,
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
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {!centralClaimed ? (
        <div className="nt-service-note">No linked plane publishes DPI application data for this site.</div>
      ) : result === null ? (
        <div className="nt-center-pad-24" role="status" aria-label="HPE Network Tools · loading applications">
          <div className="nt-stack nt-gap-6">
            <Skeleton height={12} width="40%" />
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        </div>
      ) : result.kind === 'not-reported' ? (
        <div className="nt-service-note">
          No application table was reported for this site — Central publishes one only for a site it
          manages.
        </div>
      ) : result.kind === 'failed' ? (
        <div className="nt-note-danger nt-service-note">
          {`The application read failed — ${result.message}`}
        </div>
      ) : detailHasRows(result.applications.source, 'apps', result.applications.apps) ? (
        <DpiApplicationsBody applications={result.applications} />
      ) : (
        <div className="nt-service-note">{dpiSectionNote(result.applications)}</div>
      )}
    </div>
  );
}
