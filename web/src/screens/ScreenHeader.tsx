/**
 * web/src/screens/ScreenHeader.tsx — the header block every screen opens with:
 * Heading level={1} with a mono overline ("Group / Screen"), one serif-italic
 * 15px subtitle line, and right-aligned actions.
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
    <div
      className="nt-screen-header"
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 24,
        flexWrap: 'wrap',
      }}
    >
      <div className="nt-screen-header__copy">
        <Heading level={1} overline={overline}>
          {title}
        </Heading>
        <div
          style={{
            maxWidth: 760,
            fontFamily: 'var(--nd-font-body)',
            fontSize: 14,
            lineHeight: 1.5,
            color: 'var(--nd-text-secondary)',
            marginTop: 8,
          }}
        >
          {subtitle}
        </div>
      </div>
      {actions ? (
        <div className="nt-screen-header__actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
