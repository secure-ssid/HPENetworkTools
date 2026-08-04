/**
 * web/src/screens/StatRow.tsx — the headline figures band.
 *
 * One place so every screen's stats share a width cap and wrap rule instead of
 * each carrying its own inline `repeat(N, 1fr)` grid, which stretched four or
 * five short numbers across the whole content column.
 *
 * It also collapses the case where a plane reports nothing: when every tile
 * carries the identical caption ("no auth feed in this window" printed five
 * times beside five em-dashes), the caption is said once under the row. The
 * numbers still render — an empty figure is information — but the reason for
 * them being empty is stated once, because it is one fact, not five.
 *
 * A screen may hand a tile a destination with `linkForStat` (the Overview's
 * count tiles lead to the screen that lists what the tile counts — the
 * LibreNMS availability-map pattern). The link only wraps the tile; the
 * tile's own styling is untouched, and a label the mapper does not know
 * stays plain text rather than linking somewhere on a guess.
 */

import { Link } from 'react-router-dom';
import { Stat } from '../nightdesk';
import type { StatDef } from '@hpe/shared';

export function StatRow({
  stats,
  className,
  linkForStat,
}: {
  stats: StatDef[];
  className?: string;
  /** Label → in-app path for the tiles that have one; null keeps a tile plain. */
  linkForStat?: (label: string) => string | null;
}) {
  if (stats.length === 0) return null;

  const first = stats[0]!.delta.trim();
  const shared =
    first.length > 0 && stats.every((s) => s.delta.trim() === first) ? first : null;

  return (
    <div className={className ? `nt-stat-band nt-stat-band--cinema ${className}` : 'nt-stat-band nt-stat-band--cinema'}>
      <div className="nt-stat-grid">
        {stats.map((s) => {
          const href = linkForStat?.(s.label) ?? null;
          // Unlinked tiles keep the exact element they always rendered.
          if (href === null) {
            return (
              <Stat
                key={s.label}
                label={s.label}
                value={s.value}
                delta={shared ? undefined : s.delta}
                deltaTone={s.tone}
              />
            );
          }
          return (
            <Link key={s.label} to={href} className="nt-stat-link">
              <Stat
                label={s.label}
                value={s.value}
                delta={shared ? undefined : s.delta}
                deltaTone={s.tone}
              />
            </Link>
          );
        })}
      </div>
      {shared ? <p className="nt-stat-band__note">{shared}</p> : null}
    </div>
  );
}

export default StatRow;
