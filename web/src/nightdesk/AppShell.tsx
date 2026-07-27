import type { ReactNode } from 'react';
import { cx } from './utils';

type AppShellProps = {
  sidebar?: ReactNode;
  topbar?: ReactNode;
  children: ReactNode;
};

function AppShellRoot({ sidebar, topbar, children }: AppShellProps) {
  return (
    <div className="nd-shell">
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
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('nd-navitem', active && 'nd-navitem--active')}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </button>
  );
}

export const AppShell = Object.assign(AppShellRoot, { NavItem });
