/**
 * web/src/screens/ScreenHeader.tsx — the compact header band every screen opens
 * with: title, one-line subtitle, right-aligned actions, hairline rule.
 *
 * The `overline` prop is kept because callers pass a "Group / Screen" path, but
 * it is no longer painted: the sticky topbar already renders the same trail as
 * breadcrumbs, and repeating it cost a whole row of vertical space on every
 * screen. It is exposed as `data-path` for tests and deep-link tooling.
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
    <div className="nt-screen-header" data-path={overline}>
      <div className="nt-screen-header__copy">
        <Heading level={1} className="nt-screen-header__title">
          {title}
        </Heading>
        <p className="nt-screen-header__subtitle">{subtitle}</p>
      </div>
      {actions ? <div className="nt-screen-header__actions">{actions}</div> : null}
    </div>
  );
}
