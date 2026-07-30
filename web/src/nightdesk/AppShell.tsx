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
    <div className={cx('nd-shell', className)}>
      {sidebar ? <aside className="nd-shell__sidebar">{sidebar}</aside> : null}
      <div className="nd-shell__main">
        {topbar ? <header className="nd-shell__topbar">{topbar}</header> : null}
        <main className="nd-shell__content">{children}</main>
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
      className={cx('nd-navitem', active && 'nd-navitem--active')}
      aria-current={active ? 'page' : undefined}
      title={label}
      aria-label={label}
    >
      {icon ? (
        <span className="nd-navitem__icon" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span className="nd-navitem__label">{label}</span>
    </button>
  );
}

export const AppShell = Object.assign(AppShellRoot, { NavItem });
