/**
 * web/src/screens/ScreenHeader.tsx — stacked header band for every screen.
 *
 * Overline (workflow path) + title + one-line subtitle, with optional actions
 * on the right. The sticky topbar still carries breadcrumbs; the overline is
 * a local section cue so each page reads as a designed surface, not a bare
 * H1. There is deliberately no product wordmark here — the sidebar and the
 * topbar already carry it, and a third copy on every screen bought a line of
 * header height for nothing.
 */

import type { ReactNode } from 'react';
import { Heading } from '../nightdesk';
import { ActionOverflow } from '../components/ActionOverflow';
import { splitHeaderActions } from './ScreenHeaderActions';

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
  /* Exports fold into a corner menu; the actions specific to this screen
     stay in the open. See ScreenHeaderActions for why the split is by
     label. */
  const { inline, overflow, filters } = splitHeaderActions(actions);
  return (
    <div className="nt-screen-header nd-screen-header nt-sticky-title nt-toolbar-glass" data-path={overline}>
      <div className="nt-screen-header__copy nt-screen-header__titles">
        <p className="nt-screen-header__overline nd-screen-header__overline">{overline}</p>
        <Heading level={1} className="nt-screen-header__title nd-screen-header__title">
          {title}
        </Heading>
        <p className="nt-screen-header__subtitle nd-screen-header__subtitle">{subtitle}</p>
      </div>
      {inline.length > 0 || overflow.length > 0 ? (
        <div className="nt-screen-header__actions nd-screen-header__actions">
          {inline}
          {overflow.length > 0 ? (
            <ActionOverflow label={`${title} exports and links`}>{overflow}</ActionOverflow>
          ) : null}
        </div>
      ) : null}
      {filters.length > 0 ? (
        <div className="nd-screen-filters" role="group" aria-label={`${title} filters`}>
          {filters}
        </div>
      ) : null}
    </div>
  );
}
