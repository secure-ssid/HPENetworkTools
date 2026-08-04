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
import { Badge, Button, SectionHeader, useToast } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { AlertRow } from '@hpe/shared';
import { exportTableCsv } from '../../lib/csv';

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
  const { toast } = useToast();
  const shown = alerts.slice(0, RECENT_LIMIT);
  const meta = !alertsReported
    ? 'NOT REPORTED'
    : alerts.length === 0
      ? 'NONE ACTIVE'
      : `${countOf(alerts.length, 'ALERT').toUpperCase()} · CENTRAL`;

  const copySectionLink = () => {
    const url = `${window.location.origin}/central?section=alerts#alerts`;
    void navigator.clipboard.writeText(url).then(
      () => toast('Alerts section link copied', { description: 'section=alerts', tone: 'success' }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  const exportCsv = () => {
    if (alerts.length === 0) return;
    const n = exportTableCsv(
      'central-alerts.csv',
      ['sev', 'title', 'site', 'plane', 'age', 'device', 'state'],
      alerts.map((a) => [
        a.sev,
        a.title,
        a.siteName,
        a.plane,
        a.age,
        a.device ?? '',
        a.state ?? '',
      ]),
    );
    toast(`Exported ${n} alert${n === 1 ? '' : 's'}`, {
      description: 'central-alerts.csv — Central-cut queue on this screen.',
    });
  };

  return (
    <div id="central-section-alerts" className="nt-stack nt-gap-2 nt-central-section nt-section-panel">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">HPE Network Tools · Central alerts lane · severity owns hue</div>
      <div className="nt-status-ribbon nt-status-ribbon--compact nt-central-alerts-ribbon" role="status" aria-label="Central alerts status ribbon">
        <span className="nt-status-ribbon__item">Central alerts</span>
        <span className="nt-status-ribbon__item">severity owns hue</span>
      </div>
      <div className="nt-row-between-12">
        <SectionHeader label="Recent alerts" meta={meta} />
        <div className="nt-wrap-6">
          <Button variant="ghost" size="sm" onClick={copySectionLink}>
            Copy section link
          </Button>
          {alerts.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
          ) : null}
        </div>
      </div>
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
              className="nt-alert-base-row"
            >
              <Badge tone={a.tone}>{a.sev}</Badge>
              <span className="nt-flex-1">
                <span className="nt-fs-12-pri">
                  {a.title}
                </span>
                <span className="nt-hint-muted nt-ml-8">
                  {a.siteName}
                  {a.state !== 'open' ? ` · ${a.state}` : ''}
                </span>
              </span>
              <span className="nt-hint-muted nt-shrink-0">
                {a.age}
              </span>
            </div>
          ))}
          <div className="nt-service-note nt-fs-105-pt6">
            {alerts.length > shown.length
              ? `+${countOf(alerts.length - shown.length, 'more')} — the `
              : 'The '}
            <Link to="/alerts?plane=CENTRAL" className="nt-accent-text">
              full queue, filtered to Central
            </Link>
            , has ack, silence and rule management.
          </div>
        </>
      )}
    </div>
  );
}
