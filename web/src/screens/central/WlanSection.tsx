/**
 * web/src/screens/central/WlanSection.tsx — the Central screen's WLAN
 * summary: the WLAN inventory the plane's config read reported (the same
 * /network-config walk the Configure screen renders), each row's scope text
 * verbatim, with the count in the meta and the edit path left where it
 * belongs — Configure, linked from every state.
 *
 * Three states, the screen's standing rule: not-reported means the read did
 * not happen this cycle (never an implied empty org); present-and-empty is
 * Central's real "no WLANs" answer.
 */

import { Link } from 'react-router-dom';
import { Badge, SectionHeader } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { SsidObject } from '@hpe/shared';
import { noteStyle } from './style';

function WlanRow({ row }: { row: SsidObject }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
          {row.name}
          {row.enabled !== undefined ? (
            <>
              {' '}
              <Badge tone={row.enabled ? 'success' : 'neutral'}>
                {row.enabled ? 'enabled' : 'disabled'}
              </Badge>
            </>
          ) : null}
        </span>
        <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)' }}>
          {row.targets}
          {row.note ? ` · ${row.note}` : ''}
        </span>
      </span>
      <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', textAlign: 'right' }}>
        {row.security} · {row.vlan}
      </span>
    </div>
  );
}

export function WlanSection({
  wlans,
  wlansReported,
}: {
  wlans: SsidObject[];
  wlansReported: boolean;
}) {
  const meta = !wlansReported
    ? 'NOT REPORTED'
    : wlans.length === 0
      ? 'NONE'
      : `${countOf(wlans.length, 'WLAN').toUpperCase()} · CENTRAL`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader label="WLANs" meta={meta} />
      {!wlansReported ? (
        <div style={noteStyle}>
          The WLAN inventory was not read this cycle — a failed read, no linked Central plane, or
          the gateway named it unavailable.{' '}
          <Link to="/configure" style={{ color: 'var(--nd-accent)' }}>
            Configure
          </Link>{' '}
          carries the same read when it is available.
        </div>
      ) : wlans.length === 0 ? (
        <div style={noteStyle}>Central reported no WLANs — a real answer, not a failed read.</div>
      ) : (
        <>
          {wlans.map((row) => (
            <WlanRow key={`${row.name}|${row.vlan}|${row.targets}`} row={row} />
          ))}
          <div style={{ ...noteStyle, fontSize: 10.5, paddingTop: 6 }}>
            Scope text as Central reports it — the same WLAN at several scopes is one row naming
            them all. Edits go through{' '}
            <Link to="/configure" style={{ color: 'var(--nd-accent)' }}>
              Configure
            </Link>
            .
          </div>
        </>
      )}
    </div>
  );
}
