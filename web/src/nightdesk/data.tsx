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
    <div className="nd-stat">
      <div className="nd-stat__rule" />
      <div className="nd-micro-label">{label}</div>
      <div className="nd-stat__value">{value}</div>
      {delta ? <div className={`nd-stat__delta nd-stat__delta--${deltaTone}`}>{delta}</div> : null}
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
    <span className={cx('nd-badge', plane ? 'nd-badge--plane' : `nd-badge--${tone}`)}>
      {dot ? <span className="nd-badge__dot" /> : null}
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
    <span className={`nd-avatar nd-avatar--${size}`} title={name}>
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
    <div className={cx('nd-progress', className)}>
      {label || note ? (
        <div className="nd-progress__head">
          {label ? <span className="nd-micro-label">{label}</span> : <span />}
          {note ? <span className="nd-progress__note">{note}</span> : null}
        </div>
      ) : null}
      <div
        className="nd-progress__track"
        role="progressbar"
        aria-valuenow={known ? value : undefined}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div className={`nd-progress__fill nd-progress__fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ---------- EmptyState ---------- */

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="nd-empty">
      <div className="nd-empty__title">{title}</div>
      {description ? <div className="nd-empty__desc">{description}</div> : null}
      {children}
    </div>
  );
}

/* ---------- Spinner / Skeleton ---------- */

export function Spinner({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return <span className={`nd-spinner nd-spinner--${size}`} role="status" aria-label="Loading" />;
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
  return <div className={cx('nd-skeleton', className)} style={{ width, height, ...style }} />;
}

/** Route/list first paint — copper-NOC skeleton choreography instead of a lone spinner. */
export function PageSkeleton({
  variant = 'list',
}: {
  variant?: 'list' | 'overview' | 'detail';
}) {
  if (variant === 'overview') {
    return (
      <div className="nd-page-skeleton" aria-busy="true" aria-label="Loading overview">
        <div className="nd-page-skeleton__header">
          <Skeleton width={220} height={28} />
          <Skeleton width={140} height={28} />
        </div>
        <div className="nd-page-skeleton__stats">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={72} className="nd-page-skeleton__row" />
          ))}
        </div>
        <div className="nd-page-skeleton__grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={40} className="nd-page-skeleton__row" />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} height={36} className="nd-page-skeleton__row" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'detail') {
    return (
      <div className="nd-page-skeleton" aria-busy="true" aria-label="Loading detail">
        <div className="nd-page-skeleton__header">
          <Skeleton width={280} height={28} />
          <Skeleton width={180} height={28} />
        </div>
        <Skeleton height={64} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} height={36} className="nd-page-skeleton__row" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="nd-page-skeleton" aria-busy="true" aria-label="Loading NightDesk">
      <div className="nd-page-skeleton__header">
        <Skeleton width={200} height={28} />
        <Skeleton width={160} height={28} />
      </div>
      <Skeleton height={40} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} height={38} className="nd-page-skeleton__row" />
        ))}
      </div>
    </div>
  );
}

/* ---------- Breadcrumbs ---------- */

export type Crumb = { label: string; onClick?: () => void };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="nd-crumbs" aria-label="Breadcrumbs">
      {items.map((item, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 ? <span className="nd-crumbs__sep">/</span> : null}
          {item.onClick ? (
            <button type="button" className="nd-crumbs__link" onClick={item.onClick}>
              {item.label}
            </button>
          ) : (
            <span className={cx('nd-crumbs__item', i === items.length - 1 && 'nd-crumbs__item--current')}>
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
    <div className="nd-pagination">
      <button
        type="button"
        className="nd-pagebtn"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="Previous page"
      >
        ←
      </button>
      {pageList(page, total).map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} className="nd-pagination__gap">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={cx('nd-pagebtn', p === page && 'nd-pagebtn--current')}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        ),
      )}
      <button
        type="button"
        className="nd-pagebtn"
        disabled={page >= total}
        onClick={() => onChange(page + 1)}
        aria-label="Next page"
      >
        →
      </button>
    </div>
  );
}
