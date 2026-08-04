import type { ReactNode } from 'react';
import { cx } from './utils';

type AppShellProps = {
  sidebar?: ReactNode;
  topbar?: ReactNode;
  children: ReactNode;
  /** Shell-level modifier, e.g. the collapsed navigation rail. */
  className?: string;
};

function AppShellRoot({ sidebar, topbar, children, className }: AppShellProps) {
  return (
    <div className={cx('nd-shell', 'nt-shell', className)}>
      <a className="nt-skip-link" href="#nd-main">
        Skip to content
      </a>
      {sidebar ? <aside className="nd-shell__sidebar nt-shell__sidebar">{sidebar}</aside> : null}
      <div className="nd-shell__main nt-shell__main">
        {topbar ? <header className="nd-shell__topbar nt-shell__topbar nt-toolbar-glass nt-topbar">{topbar}</header> : null}
        <main id="nd-main" className="nd-shell__content nt-main-canvas nt-shell__content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

function NavItem({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  /** Optional glyph. It is the only visible content in the collapsed rail, so
   *  the label stays on the button as `title`/`aria-label` for both sighted
   *  hover and assistive tech. */
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('nd-navitem', 'nt-sidebar-nav__item', 'nt-navitem', active && 'nd-navitem--active', active && 'nt-navitem--active')}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      title={label}
      aria-label={label}
    >
      {icon ? (
        <span className="nd-navitem__icon nt-navitem__icon" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span className="nd-navitem__label nt-navitem__label">{label}</span>
    </button>
  );
}

export const AppShell = Object.assign(AppShellRoot, { NavItem });
