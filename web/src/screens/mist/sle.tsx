/**
 * web/src/screens/mist/sle.tsx — the Mist screen's "SLE across sites"
 * section: one row per site Mist scores, worst-first, each linking to the
 * site page whose wireless-experience section carries the per-metric
 * drill-down.
 *
 * The badge thresholds are the SLE badge's own (≥0.9 good, 0.7–0.9 moderate,
 * below poor) — the same rule siteDetail/Sle.tsx applies, kept in the one
 * vocabulary. A site whose window held no countable samples carries
 * `overall: null` and settles AFTER every scored site: "not reported" is not
 * the worst score, it is no score.
 */

import { Link } from 'react-router-dom';
import { Badge, Button, SectionHeader, useToast } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { MistSleRow, Tone } from '@hpe/shared';
import { buildMistShareUrl } from './share';

function sleTone(success: number | null): Tone {
  if (success === null) return 'neutral';
  if (success >= 0.9) return 'success';
  if (success >= 0.7) return 'warning';
  return 'danger';
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

/** Worst-first; an unscored row settles after every scored one. */
function byWorstFirst(a: MistSleRow, b: MistSleRow): number {
  return (a.overall ?? Infinity) - (b.overall ?? Infinity);
}

/** The site's weakest scored dimension as one display phrase ('roaming 79%'),
 *  from the per-metric detail when the row carries it, else the headline
 *  fractions. null when nothing was scored — the row then says so instead of
 *  naming a "worst" nothing earned. */
function weakestLabel(sle: MistSleRow): string | null {
  const candidates: Array<{ k: string; v: number | null }> =
    sle.metrics && sle.metrics.length > 0
      ? sle.metrics.map((m) => ({ k: m.name.replace(/-/g, ' '), v: m.success }))
      : [
          { k: 'coverage', v: sle.coverage },
          { k: 'capacity', v: sle.capacity },
          { k: 'roaming', v: sle.roaming },
          { k: 'AP health', v: sle.apHealth },
          { k: 'WAN', v: sle.wan },
        ];
  const scored = candidates.filter((c): c is { k: string; v: number } => c.v !== null);
  if (scored.length === 0) return null;
  const worst = scored.reduce((a, b) => (a.v <= b.v ? a : b));
  return `${worst.k} ${pct(worst.v)}`;
}

export function SleAcrossSites({ sleBySiteId }: { sleBySiteId: Partial<Record<string, MistSleRow>> | undefined }) {
  const { toast } = useToast();
  const rows =
    sleBySiteId === undefined
      ? []
      : Object.values(sleBySiteId)
          .filter((sle): sle is MistSleRow => sle !== undefined)
          .sort(byWorstFirst);
  const meta =
    sleBySiteId === undefined
      ? 'NOT REPORTED'
      : rows.length === 0
        ? 'NONE SCORED'
        : `${countOf(rows.length, 'SITE').toUpperCase()} SCORED · MIST SLE`;

  return (
    <div id="mist-section-sle" className="nt-mist-section nt-section-panel nt-stack nt-gap-2">
      <div className="nt-row-between-12">
        <div className="nt-plane-theater nt-plane-theater--compact" role="note">HPE Network Tools · Mist SLE theater · experience owns hue</div>
        <SectionHeader label="Wireless experience across sites" meta={meta} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const url = buildMistShareUrl('sle');
            void navigator.clipboard.writeText(url).then(
              () => toast('SLE section link copied', { description: 'section=sle', tone: 'success' }),
              () => toast('Could not copy link', { description: url, tone: 'warning' }),
            );
          }}
        >
          Copy section link
        </Button>
      </div>
      {sleBySiteId === undefined ? (
        <div className="nt-service-note">
          The SLE walk was not reported this cycle — a failed read, or no linked Mist plane. No score
          below is an all-clear or an alarm.
        </div>
      ) : rows.length === 0 ? (
        <div className="nt-service-note">
          Mist reported no SLE scores for any site this cycle — an unscored window is "not reported",
          never a 0%.
        </div>
      ) : (
        <>
          {rows.map((sle) => {
            const weakest = weakestLabel(sle);
            return (
              <Link
                key={sle.siteId}
                to={`/sites/${encodeURIComponent(sle.siteId)}`}
                className="nt-mist-row"
              >
                <span className="nt-flex-1">
                  <span className="nt-fs-12-pri">
                    {sle.siteName}
                  </span>
                  <span className="nt-fs-10">
                    {weakest !== null ? `weakest: ${weakest}` : 'no dimension scored this window'}
                  </span>
                </span>
                <Badge tone={sleTone(sle.overall)}>{pct(sle.overall)}</Badge>
                <span className="nt-note-11 nt-service-note">drill →</span>
              </Link>
            );
          })}
          <div className="nt-fs-105 nt-hint-muted">
            Worst-first. A site opens its own page, where each scored metric drills into classifiers,
            impacted clients and APs.
          </div>
        </>
      )}
    </div>
  );
}
