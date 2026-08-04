/**
 * web/src/screens/central/AlertsSection.tsx — the plane's recent alert
 * queue: the ACTIVE queue the route already cut to Central (silences
 * applied, webhook deliveries included), severity-sorted. The section shows
 * the leading rows and hands off to the full queue — /alerts?plane=CENTRAL,
 * the same filter the Alerts screen's own plane facet applies.
 *
 * Honest states, the standing rule: an unreported feed is named (never a
 * quiet estate wearing "no alerts"); a reported feed with nothing active is
 * the real answer, silences and all.
 */

import { Link } from 'react-router-dom';
import { Badge, SectionHeader } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { AlertRow } from '@hpe/shared';

/** How many rows the section shows before the remainder becomes the
 *  hand-off count — the queue itself always has the rest. */
const RECENT_LIMIT = 5;

export function AlertsSection({
  alerts,
  alertsReported,
}: {
  alerts: AlertRow[];
  alertsReported: boolean;
}) {
  const shown = alerts.slice(0, RECENT_LIMIT);
  const meta = !alertsReported
    ? 'NOT REPORTED'
    : alerts.length === 0
      ? 'NONE ACTIVE'
      : `${countOf(alerts.length, 'ALERT').toUpperCase()} · CENTRAL`;

  return (
    <div className="nt-stack nt-gap-2">
      <SectionHeader label="Recent alerts" meta={meta} />
      {!alertsReported ? (
        <div className="nt-service-note">
          Central did not report its alert feed this cycle — the estate may be louder than this
          screen knows. Connected systems has the plane&rsquo;s poll state.
        </div>
      ) : alerts.length === 0 ? (
        <div className="nt-service-note">
          Nothing active from Central — the reported feed has no open or acknowledged rows
          (silenced firings sit on the Alerts screen&rsquo;s bench, with their reasons).
        </div>
      ) : (
        <>
          {shown.map((a, i) => (
            <div
              key={`${a.plane}|${a.title}|${a.device}|${a.age}|${i}`}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 12,
                padding: '8px 0',
                borderBottom: '1px solid var(--nd-border-subtle)',
              }}
            >
              <Badge tone={a.tone}>{a.sev}</Badge>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
                  {a.title}
                </span>
                <span className="nt-hint-muted" style={{ marginLeft: 8 }}>
                  {a.siteName}
                  {a.state !== 'open' ? ` · ${a.state}` : ''}
                </span>
              </span>
              <span className="nt-hint-muted" style={{ flexShrink: 0 }}>
                {a.age}
              </span>
            </div>
          ))}
          <div className="nt-service-note" style={{ fontSize: 10.5, paddingTop: 6 }}>
            {alerts.length > shown.length
              ? `+${countOf(alerts.length - shown.length, 'more')} — the `
              : 'The '}
            <Link to="/alerts?plane=CENTRAL" style={{ color: 'var(--nd-accent)' }}>
              full queue, filtered to Central
            </Link>
            , has ack, silence and rule management.
          </div>
        </>
      )}
    </div>
  );
}
