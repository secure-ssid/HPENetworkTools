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
      className="nt-filter-bar" style={{ paddingBottom: 4,
        borderBottom: '1px solid var(--nd-border-subtle)' }}
    >
      <Badge tone={plane.tone} dot>
        {plane.linked ? plane.health : 'not linked'}
      </Badge>
      <span className="nt-hint-muted">
        {dataSource === 'live' ? 'LIVE' : 'DEMO FIXTURE'}
        {' · '}
        {plane.linked
          ? `LAST SYNC ${plane.lastSync ? hhmm(plane.lastSync) : 'NEVER'}`
          : 'NO CREDENTIALS STORED'}
      </span>
      {plane.note ? (
        <span className="nt-hint-muted">{plane.note}</span>
      ) : null}
      <span style={{ flex: 1 }} />
      <Link to="/systems" className="nt-hint-muted" style={{ color: "var(--nd-accent)" }}>
        Scope, credentials and webhooks in Connected systems
      </Link>
    </div>
  );
}
