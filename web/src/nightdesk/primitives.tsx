import type { CSSProperties, ReactNode } from 'react';
import { cx } from './utils';

export function NightdeskProvider({ children }: { children: ReactNode }) {
  return <div className="nd-root nt-root">{children}</div>;
}

type StackProps = {
  children: ReactNode;
  direction?: 'row' | 'column';
  gap?: number;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  wrap?: boolean;
  style?: CSSProperties;
  className?: string;
};

export function Stack({
  direction = 'column',
  gap,
  align,
  justify,
  wrap,
  style,
  className,
  children,
}: StackProps) {
  const s: CSSProperties = { display: 'flex', flexDirection: direction, minWidth: 0, ...style };
  if (gap !== undefined) s.gap = gap;
  if (align) s.alignItems = align;
  if (justify) s.justifyContent = justify;
  if (wrap) s.flexWrap = 'wrap';
  return (
    <div
      className={cx(
        'nd-stack',
        'nt-stack',
        direction === 'row' ? 'nt-stack--row' : 'nt-stack--col',
        wrap && 'nt-stack--wrap',
        className,
      )}
      style={s}
    >
      {children}
    </div>
  );
}

export function Card({
  variant = 'soft',
  className,
  style,
  dataPhase,
  children,
}: {
  variant?: 'soft' | 'plain';
  className?: string;
  style?: CSSProperties;
  /** Brokered-write ritual phase for Copper NOC chrome. */
  dataPhase?: 'review' | 'confirm' | 'executing' | 'done';
  children: ReactNode;
}) {
  return (
    <div
      className={cx('nd-card', `nd-card--${variant}`, 'nt-card', `nt-card--${variant}`, 'nt-card-lift', 'nt-panel-glass', className)}
      style={style}
      data-phase={dataPhase}
    >
      {children}
    </div>
  );
}

export function Divider({ variant = 'default' }: { variant?: 'default' | 'flair' }) {
  return <div role="separator" className={`nd-divider nd-divider--${variant}${variant === 'flair' ? ' nt-divider-flair' : ''}`} />;
}

export function SectionHeader({ label, meta }: { label: ReactNode; meta?: ReactNode }) {
  return (
    <div className="nd-section-header nt-table-toolbar nt-toolbar-glass">
      <span className="nd-micro-label nt-micro-label">{label}</span>
      {meta ? <span className="nd-section-header__meta nt-table-toolbar__meta">{meta}</span> : null}
    </div>
  );
}

type HeadingProps = {
  level?: 1 | 2 | 3 | 4;
  overline?: string;
  className?: string;
  children: ReactNode;
};

export function Heading({ level = 2, overline, className, children }: HeadingProps) {
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
  return (
    <div className={className}>
      {overline ? <span className="nd-micro-label nt-micro-label nd-heading__overline nt-heading__overline">{overline}</span> : null}
      <Tag className={`nd-heading nt-heading nd-heading--${level} nt-heading--${level}`}>{children}</Tag>
    </div>
  );
}

type TextProps = {
  children: ReactNode;
  size?: 10 | 11 | 12 | 14 | 16 | 18 | 22 | 26 | 34 | 44;
  tone?: 'primary' | 'secondary' | 'muted' | 'accent';
  mono?: boolean;
  serif?: boolean;
  italic?: boolean;
  as?: 'span' | 'p' | 'div';
  style?: CSSProperties;
  className?: string;
};

export function Text({
  size = 14,
  tone = 'primary',
  mono,
  serif,
  italic,
  as,
  style,
  className,
  children,
}: TextProps) {
  const Tag = as ?? 'span';
  const s: CSSProperties = {
    fontSize: `var(--nd-text-${size})`,
    color: tone === 'accent' ? 'var(--nd-accent-text)' : `var(--nd-text-${tone})`,
    ...style,
  };
  if (mono) s.fontFamily = 'var(--nd-font-mono)';
  if (serif) s.fontFamily = 'var(--nd-font-display)';
  if (italic) s.fontStyle = 'italic';
  return (
    <Tag className={className} style={s}>
      {children}
    </Tag>
  );
}

export function Code({
  block,
  className,
  children,
}: {
  block?: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (block) {
    return (
      <pre className={cx('nd-code-block', 'nt-code-frame', className)}>
        <code>{children}</code>
      </pre>
    );
  }
  return <code className={cx('nd-code', 'nt-code-inline', className)}>{children}</code>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="nd-kbd nt-kbd">{children}</kbd>;
}
