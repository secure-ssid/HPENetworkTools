/**
 * web/src/screens/central/dpi.tsx — the Central DPI application-visibility
 * rendering, shared by the two screens that show it.
 *
 * This lived inside the site page's applications section until the Central
 * screen needed the identical table for its own site picker: the risk strip,
 * the watchlist split, the top talkers and the share-of-largest rollup are
 * ONE rendering, extracted here rather than duplicated. The fetch discipline
 * stays with the callers (siteDetail/Applications.tsx reads on mount for the
 * site it is on; central/ApplicationsSection.tsx reads when its picker picks
 * a site) — both spend the same on-demand, budget-gated read, never a poll.
 *
 * The honesty rules mirror the portal's other on-demand reads:
 *  - the payload's `source.sections.apps` picks the sentence — 'ok' renders
 *    the table, 'empty' is the plane's authoritative no-traffic answer,
 *    'failed' says the call broke, 'not-fetched' says we chose not to ask
 *    (the call budget is spent);
 *  - byte totals are DPI estimates and the footer says so verbatim
 *    (DPI_BYTES_ARE_ESTIMATES); the category bars are shares of the LARGEST
 *    category, never percents of the total — an app's bytes count toward
 *    every category it carries.
 */

import { Badge, SectionHeader } from '../../nightdesk';
import {
  DPI_BYTES_ARE_ESTIMATES,
  RISK_BUCKET_ORDER,
  countOf,
  detailState,
  hhmmLocal as hhmm,
  riskBucketCounts,
  rollupAppCategories,
  watchlistSplit,
} from '@hpe/shared';
import type { DpiRiskBucket, SiteAppRow, SiteApplicationsLive, Tone, TrendWindow } from '@hpe/shared';
import { noteStyle } from './style';

/** How many rows a capped list shows before the remainder becomes a count. */
const WATCHLIST_KNOWN_LIMIT = 25;
const TOP_TALKERS_LIMIT = 25;

/** Worst-first badge tones for the five risk buckets. */
export const DPI_BUCKET_TONE: Record<DpiRiskBucket, Tone> = {
  suspicious: 'danger',
  moderate: 'warning',
  low: 'neutral',
  trustworthy: 'success',
  unknown: 'neutral',
};

export const dpiNoteStyle = noteStyle;

/** Byte totals, as an operator says them — estimates, and the section's
 *  footer says so (DPI_BYTES_ARE_ESTIMATES). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${Math.round(bytes)} B`;
}

/** The queried window's span as an operator says it ('24 h', '3 d'). null
 *  when the payload's bounds do not parse — the footer then names no span,
 *  because guessing one would be a fabrication. */
function windowSpan(window: TrendWindow): string | null {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const hours = (end - start) / 3_600_000;
  if (hours < 48) return `${Math.max(1, Math.round(hours))} h`;
  return `${Math.round(hours / 24)} d`;
}

/** One honest sentence for the three no-table outcomes of a settled read. */
export function dpiSectionNote(applications: SiteApplicationsLive): string {
  const state = detailState(applications.source, 'apps');
  if (state === 'failed') {
    return `The applications read did not complete${applications.source.note ? ` — ${applications.source.note}` : ''}.`;
  }
  if (state === 'not-fetched') {
    return `Applications were not fetched${applications.source.note ? ` — ${applications.source.note}` : ''}.`;
  }
  // 'empty', and the defensive 'ok' with no rows: the plane answered and had
  // nothing — an empty result, not a failed read.
  return 'Central answered for this site and reported no application traffic in the window.';
}

/** A watchlist row: the app, the plane's own risk word when it differs from
 *  the bucket it folded into, the estimated bytes and the bucket badge. */
function WatchRow({ app }: { app: SiteAppRow }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
          {app.name}
        </span>
        {app.riskRaw && app.riskRaw !== app.risk ? (
          <span style={{ ...dpiNoteStyle, fontSize: 'var(--nd-text-10)', marginLeft: 8 }}>
            {`plane risk: ${app.riskRaw}`}
          </span>
        ) : null}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={{ ...dpiNoteStyle, fontSize: 'var(--nd-text-10)' }}>
          {app.totalBytes !== null ? formatBytes(app.totalBytes) : 'bytes not reported'}
        </span>
        <Badge tone={DPI_BUCKET_TONE[app.risk]}>{app.risk}</Badge>
      </span>
    </div>
  );
}

/** A top-talker row: rank, name, the plane's categories, estimated bytes. */
function TalkerRow({ app, rank }: { app: SiteAppRow; rank: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <span style={{ ...dpiNoteStyle, fontSize: 'var(--nd-text-10)', width: 22, flex: '0 0 22px' }}>
        {rank}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
          {app.name}
        </span>
        {app.categories.length > 0 ? (
          <span style={{ ...dpiNoteStyle, fontSize: 'var(--nd-text-10)', marginLeft: 8 }}>
            {app.categories.join(' · ')}
          </span>
        ) : null}
      </span>
      <span style={{ ...dpiNoteStyle, fontSize: 'var(--nd-text-10)', flexShrink: 0 }}>
        {app.totalBytes !== null ? formatBytes(app.totalBytes) : '—'}
      </span>
    </div>
  );
}

/** The settled 'ok' table: risk strip, watchlist, top talkers, rollup. */
export function DpiApplicationsBody({ applications }: { applications: SiteApplicationsLive }) {
  const apps = applications.apps ?? [];
  const counts = riskBucketCounts(apps);
  const watchlist = watchlistSplit(apps);
  const flagged = watchlist.unclassified.length + watchlist.known.length;
  const knownShown = watchlist.known.slice(0, WATCHLIST_KNOWN_LIMIT);
  const talkers = apps.slice(0, TOP_TALKERS_LIMIT);
  const rollup = rollupAppCategories(apps);
  const span = windowSpan(applications.window);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ ...dpiNoteStyle, fontSize: 'var(--nd-text-10)' }}>
        {`CENTRAL · READ ${hhmm(applications.source.at)}${applications.source.cached ? ' · CACHED' : ''}`}
      </div>

      {/* The risk strip: every bucket, worst first, zero counts included —
          "no suspicious apps" is part of the answer, not a reason to re-key
          the strip. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {RISK_BUCKET_ORDER.map((bucket) => (
          <Badge key={bucket} tone={DPI_BUCKET_TONE[bucket]} dot>
            {`${counts[bucket]} ${bucket}`}
          </Badge>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SectionHeader
          label="Watchlist"
          meta={flagged > 0 ? countOf(flagged, 'flagged app').toUpperCase() : 'NOTHING FLAGGED'}
        />
        {flagged === 0 ? (
          <div style={dpiNoteStyle}>No application in the window is flagged suspicious or moderate.</div>
        ) : (
          <>
            {watchlist.unclassified.length > 0 ? (
              <>
                <div style={{ ...dpiNoteStyle, padding: '8px 0 2px' }}>
                  {"Unclassified — Aruba doesn't know what this is and doesn't like it:"}
                </div>
                {watchlist.unclassified.map((app) => (
                  <WatchRow key={app.id} app={app} />
                ))}
              </>
            ) : null}
            {knownShown.map((app) => (
              <WatchRow key={app.id} app={app} />
            ))}
            {watchlist.known.length > knownShown.length ? (
              <div style={{ ...dpiNoteStyle, padding: '8px 0' }}>
                {`+${countOf(watchlist.known.length - knownShown.length, 'more flagged, classified app')}`}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SectionHeader label="Top talkers" meta="BY ESTIMATED BYTES" />
        {talkers.map((app, i) => (
          <TalkerRow key={app.id} app={app} rank={i + 1} />
        ))}
        {apps.length > talkers.length ? (
          <div style={{ ...dpiNoteStyle, padding: '8px 0' }}>
            {`+${countOf(apps.length - talkers.length, 'more application')}`}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SectionHeader label="Categories" meta="SHARE OF LARGEST" />
        {rollup.map((row) => (
          <div
            key={row.category}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(140px, .9fr) minmax(120px, 1.1fr) auto',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
              {row.category}
            </span>
            <span
              style={{
                display: 'block',
                height: 6,
                background: 'var(--nd-bg-raised)',
                border: '1px solid var(--nd-border-subtle)',
              }}
            >
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${Math.round(row.share * 100)}%`,
                  background: 'var(--nd-accent)',
                }}
              />
            </span>
            <span style={{ ...dpiNoteStyle, fontSize: 'var(--nd-text-10)', textAlign: 'right' }}>
              {`${countOf(row.apps, 'app')} · ${formatBytes(row.bytes)}`}
            </span>
          </div>
        ))}
        <div style={{ ...dpiNoteStyle, fontSize: 10.5 }}>
          Bar length is the share of the largest category — an app's bytes count toward every
          category it carries, so these are not shares of the total.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ ...dpiNoteStyle, fontSize: 10.5 }}>
          {span
            ? `${span} window — the API refuses anything wider than 7 days; the default is 24 h.`
            : 'The API refuses a window wider than 7 days; the default is 24 h.'}
        </div>
        <div style={{ ...dpiNoteStyle, fontSize: 10.5 }}>{DPI_BYTES_ARE_ESTIMATES}</div>
        {applications.truncated ? (
          <div style={{ ...dpiNoteStyle, fontSize: 10.5 }}>
            {applications.source.note ??
              'The paged walk did not finish — the table is a prefix of the full ranking.'}
          </div>
        ) : null}
      </div>
    </div>
  );
}
