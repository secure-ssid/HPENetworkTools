/**
 * web/src/screens/central/PlaneHeader.tsx — the Central screen's plane
 * status strip: the plane's own health word, its last-sync stamp, and the
 * hand-off to Connected systems (scope, credentials and webhook management
 * live there — this screen reads, it does not manage).
 *
 * Every fact is the payload's own: the health badge is the registry word
 * verbatim (lower-case, never paraphrased), 'never' is a plane that has not
 * completed a pull, and an absent note shows nothing rather than padding.
 */

import { Link } from 'react-router-dom';
import { Badge } from '../../nightdesk';
import { hhmmLocal as hhmm } from '@hpe/shared';
import type { CentralPlaneStatus } from '@hpe/shared';

export function PlaneHeader({
  plane,
  dataSource,
}: {
  plane: CentralPlaneStatus;
  dataSource: 'demo' | 'live';
}) {
  return (
    <div
      className="nt-filter-bar nt-plane-head-rule nt-plane-head nt-toolbar-glass"
      data-tone={plane.tone}
      data-live={dataSource === 'live' ? '1' : '0'}
    >
      <Badge plane>Central</Badge>
      <Badge tone={plane.tone} dot>
        {plane.linked ? plane.health : 'not linked'}
      </Badge>
      <span className="nt-hint-muted nt-plane-head__meta">
        {dataSource === 'live' ? 'LIVE' : 'DEMO FIXTURE'}
        {' · '}
        {plane.linked
          ? `LAST SYNC ${plane.lastSync ? hhmm(plane.lastSync) : 'NEVER'}`
          : 'NO CREDENTIALS STORED'}
      </span>
      {plane.note ? (
        <span className="nt-hint-muted">{plane.note}</span>
      ) : null}
      <span className="nt-flex-only" />
      <Link to="/systems" className="nt-hint-muted nt-accent-text nt-plane-head__link">
        Scope, credentials and webhooks in Connected systems
      </Link>
    </div>
  );
}
