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
 */

import { Stat } from '../nightdesk';
import type { StatDef } from '@hpe/shared';

export function StatRow({ stats, className }: { stats: StatDef[]; className?: string }) {
  if (stats.length === 0) return null;

  const first = stats[0]!.delta.trim();
  const shared =
    first.length > 0 && stats.every((s) => s.delta.trim() === first) ? first : null;

  return (
    <div className={className ? `nt-stat-band ${className}` : 'nt-stat-band'}>
      <div className="nt-stat-grid">
        {stats.map((s) => (
          <Stat
            key={s.label}
            label={s.label}
            value={s.value}
            delta={shared ? undefined : s.delta}
            deltaTone={s.tone}
          />
        ))}
      </div>
      {shared ? <p className="nt-stat-band__note">{shared}</p> : null}
    </div>
  );
}

export default StatRow;
