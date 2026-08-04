import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from '@hpe/shared';
import { cx } from './utils';

export type { Tone };

/* ---------- Stat ---------- */

export function Stat({
  label,
  value,
  delta,
  deltaTone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  delta?: string;
  deltaTone?: 'positive' | 'negative' | 'neutral';
}) {
  return (
    <div className="nd-stat nt-stat nt-metric-tile nt-stat-tile" data-delta={deltaTone}>
      <div className="nd-stat__rule nt-metric-tile__rule" />
      <div className="nd-micro-label nt-micro-label nt-metric-tile__k nt-stat__label">{label}</div>
      <div className="nd-stat__value nt-stat__value nt-metric-tile__v">{value}</div>
      {delta ? (
        <div
          className={`nd-stat__delta nd-stat__delta--${deltaTone} nt-stat__delta nt-metric-tile__note`}
          data-tone={deltaTone}
        >
          {delta}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Badge ---------- */

export function Badge({
  tone = 'neutral',
  dot,
  /** Plane / source chips stay monochrome — state owns hue. */
  plane,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  plane?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'nd-badge',
        plane ? 'nd-badge--plane nt-plane-chip' : `nd-badge--${tone}`,
        !plane && 'nt-status-chip',
      )}
      data-tone={plane ? undefined : tone}
      data-plane={plane ? 'true' : undefined}
    >
      {dot ? <span className="nd-badge__dot nt-status-dot" data-tone={tone} /> : null}
      {children}
    </span>
  );
}

/* ---------- Avatar ---------- */

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  const initials = name
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className={`nd-avatar nd-avatar--${size} nt-avatar`} title={name} data-size={size}>
      {initials}
    </span>
  );
}

/* ---------- Progress ---------- */

export function Progress({
  value,
  max = 100,
  label,
  note,
  tone = 'accent',
  className,
}: {
  value: number;
  max?: number;
  label?: string;
  note?: string;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  // An unknown share must never paint as a full bar. `value / max` is Infinity
  // when max is 0 and NaN when either side is not a number, and clamping those
  // used to yield 100% — i.e. "we have no idea" rendered as "fully utilised and
  // healthy", the same inversion the Licences utilisation bar was fixed for.
  // Unknown now renders empty, and the bar reports itself as indeterminate.
  const raw = (value / max) * 100;
  const known = Number.isFinite(raw);
  const pct = known ? Math.max(0, Math.min(100, raw)) : 0;
  return (
    <div className={cx('nd-progress', 'nt-progress-rail', className)} data-tone={tone}>
      {label || note ? (
        <div className="nd-progress__head nt-progress-rail__head">
          {label ? <span className="nd-micro-label nt-micro-label">{label}</span> : <span />}
          {note ? <span className="nd-progress__note nt-progress-rail__note">{note}</span> : null}
        </div>
      ) : null}
      <div
        className="nd-progress__track nt-progress-rail"
        role="progressbar"
        aria-valuenow={known ? value : undefined}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div className={`nd-progress__fill nd-progress__fill--${tone} nt-progress-rail__fill`} style={{ ["--nd-health" as string]: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ---------- EmptyState ---------- */

export function EmptyState({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('nd-empty', 'nt-empty', 'nt-empty-cinema', className)}>
      <div className="nt-empty-wake__mark" aria-hidden>ND</div>
      <div className="nd-empty__kicker nt-empty-cinema__kicker">NightDesk · quiet lane</div>
      <div className="nd-empty__title nt-empty-cinema__title">{title}</div>
      {description ? <div className="nd-empty__desc nt-empty-cinema__body">{description}</div> : null}
      {children}
    </div>
  );
}

/* ---------- Spinner / Skeleton ---------- */

export function Spinner({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      className={`nd-spinner nd-spinner--${size} nt-spinner`}
      role="status"
      aria-label="Loading"
      data-size={size}
    />
  );
}

export function Skeleton({
  width,
  height = 12,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  const cssVars = {
    width,
    height,
    ...(width !== undefined ? { ['--nd-skel-w' as string]: typeof width === 'number' ? `${width}px` : width } : {}),
    ...(height !== undefined ? { ['--nd-skel-h' as string]: typeof height === 'number' ? `${height}px` : height } : {}),
    ...style,
  } as CSSProperties;
  return <div className={cx('nd-skeleton', 'nt-skeleton-block', className)} style={cssVars} />;
}

/** Route/list first paint — copper-NOC skeleton choreography instead of a lone spinner. */
export function PageSkeleton({
  variant = 'list',
}: {
  variant?: 'list' | 'overview' | 'detail';
}) {
  if (variant === 'overview') {
    return (
      <div className="nd-page-skeleton nd-page-skeleton--war nt-page-skeleton nt-war-room-wake" aria-busy="true" aria-label="Loading overview">
        <div className="nd-page-skeleton__kicker nt-page-skeleton__kicker">NightDesk · waking the war room</div>
        <div className="nd-page-skeleton__header nt-page-skeleton__header">
          <Skeleton width={220} height={28} />
          <Skeleton width={140} height={28} />
        </div>
        <div className="nd-page-skeleton__stats nt-page-skeleton__stats">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={72} className="nd-page-skeleton__row nt-page-skeleton__row" />
          ))}
        </div>
        <div className="nd-page-skeleton__grid nt-page-skeleton__grid">
          <div className="nt-stack-8">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={40} className="nd-page-skeleton__row nt-page-skeleton__row" />
            ))}
          </div>
          <div className="nt-stack-8">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} height={36} className="nd-page-skeleton__row nt-page-skeleton__row" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'detail') {
    return (
      <div className="nd-page-skeleton nd-page-skeleton--war nt-page-skeleton nt-war-room-wake" aria-busy="true" aria-label="Loading detail">
        <div className="nd-page-skeleton__kicker nt-page-skeleton__kicker">NightDesk · resolving device</div>
        <div className="nd-page-skeleton__header nt-page-skeleton__header">
          <Skeleton width={280} height={28} />
          <Skeleton width={180} height={28} />
        </div>
        <Skeleton height={64} />
        <div className="nt-stack-8">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} height={36} className="nd-page-skeleton__row nt-page-skeleton__row" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="nd-page-skeleton nd-page-skeleton--war nt-page-skeleton nt-war-room-wake" aria-busy="true" aria-label="Loading NightDesk">
      <div className="nd-page-skeleton__kicker nt-page-skeleton__kicker">NightDesk · assembling the lane</div>
      <div className="nd-page-skeleton__header nt-page-skeleton__header">
        <Skeleton width={200} height={28} />
        <Skeleton width={160} height={28} />
      </div>
      <Skeleton height={40} />
      <div className="nt-stack-6">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} height={38} className="nd-page-skeleton__row nt-page-skeleton__row" />
        ))}
      </div>
    </div>
  );
}

/* ---------- Breadcrumbs ---------- */

export type Crumb = { label: string; onClick?: () => void };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="nd-crumbs nt-crumb nt-breadcrumbs" aria-label="Breadcrumbs">
      {items.map((item, i) => (
        <span key={i} className="nt-contents">
          {i > 0 ? <span className="nd-crumbs__sep nt-breadcrumbs__sep" aria-hidden>/</span> : null}
          {item.onClick ? (
            <button type="button" className="nd-crumbs__link nt-breadcrumbs__link" onClick={item.onClick}>
              {item.label}
            </button>
          ) : (
            <span className={cx('nd-crumbs__item', 'nt-breadcrumbs__item', i === items.length - 1 && 'nd-crumbs__item--current', i === items.length - 1 && 'nt-breadcrumbs__item--current')}>
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/* ---------- Pagination ---------- */

function pageList(page: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const set = new Set(
    [1, 2, page - 1, page, page + 1, total - 1, total].filter((p) => p >= 1 && p <= total),
  );
  const arr = [...set].sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  for (let i = 0; i < arr.length; i++) {
    if (i > 0 && arr[i] - arr[i - 1] > 1) out.push('…');
    out.push(arr[i]);
  }
  return out;
}

export function Pagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="nd-pagination nt-pagination nt-toolbar-glass" role="navigation" aria-label="Pagination">
      <button
        type="button"
        className="nd-pagebtn nt-pagebtn"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="Previous page"
      >
        ←
      </button>
      {pageList(page, total).map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} className="nd-pagination__gap nt-pagination__gap">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={cx('nd-pagebtn', 'nt-pagebtn', p === page && 'nd-pagebtn--current', p === page && 'nt-pagebtn--current')}
            onClick={() => onChange(p)}
            aria-label={p === page ? `Page ${p}, current` : `Page ${p}`}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </button>
        ),
      )}
      <button
        type="button"
        className="nd-pagebtn nt-pagebtn"
        disabled={page >= total}
        onClick={() => onChange(page + 1)}
        aria-label="Next page"
      >
        →
      </button>
    </div>
  );
}
