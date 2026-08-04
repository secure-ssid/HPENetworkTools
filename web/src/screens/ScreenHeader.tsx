/**
 * web/src/screens/ScreenHeader.tsx — stacked header band for every screen.
 *
 * Overline (workflow path) + title + one-line subtitle, with optional actions
 * on the right. The sticky topbar still carries breadcrumbs; the overline is
 * a local section cue so each page reads as a designed surface, not a bare
 * H1.
 */

import type { ReactNode } from 'react';
import { Heading } from '../nightdesk';

export function ScreenHeader({
  overline,
  title,
  subtitle,
  actions,
}: {
  overline: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <div className="nt-screen-header nt-sticky-title nt-toolbar-glass" data-path={overline}>
      <div className="nt-screen-header__copy nt-screen-header__titles">
        <p className="nt-screen-header__brand nt-screen-kicker" aria-hidden>
          NightDesk · Copper NOC
        </p>
        <p className="nt-screen-header__overline">{overline}</p>
        <Heading level={1} className="nt-screen-header__title">
          {title}
        </Heading>
        <p className="nt-screen-header__subtitle">{subtitle}</p>
      </div>
      {actions ? <div className="nt-screen-header__actions">{actions}</div> : null}
    </div>
  );
}
