/**
 * web/src/screens/mist/wlans.tsx — the Mist screen's WLAN summary: the WLAN
 * inventory the plane's config read reported (the same site-scoped walk the
 * Configure screen renders), each row's scope text verbatim, with the count
 * in the meta and the edit path left where it belongs — Configure's Mist
 * flow, linked from every row state.
 *
 * Three states, the screen's standing rule: absent/null means the read did
 * not happen or the plane named it unavailable (never an implied empty
 * org); present-and-empty is Mist's real "no WLANs" answer.
 */

import { Link } from 'react-router-dom';
import { Badge, SectionHeader } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { SsidObject } from '@hpe/shared';
import { buildSsidDeepLink } from '../configure/deepLink';
import { noteStyle } from './style';

function WlanRow({ row }: { row: SsidObject }) {
  const to = buildSsidDeepLink(row, 'MIST') ?? '/configure';
  return (
    <Link
      to={to}
      aria-label={`Edit WLAN ${row.name} in Configure`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
        textDecoration: 'none',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
          {row.name}
          {row.enabled !== undefined ? (
            <Badge tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? 'enabled' : 'disabled'}</Badge>
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
    </Link>
  );
}

export function WlanSummary({ wlans }: { wlans: SsidObject[] | null | undefined }) {
  const meta =
    wlans == null ? 'NOT REPORTED' : wlans.length === 0 ? 'NONE' : `${countOf(wlans.length, 'WLAN').toUpperCase()} · MIST`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader label="WLANs" meta={meta} />
      {wlans == null ? (
        <div style={noteStyle}>
          The WLAN inventory was not read this cycle — a failed read, no linked Mist plane, or the
          plane named it unavailable.{' '}
          <Link to="/configure" style={{ color: 'var(--nd-accent)' }}>
            Configure
          </Link>{' '}
          carries the same read when it is available.
        </div>
      ) : wlans.length === 0 ? (
        <div style={noteStyle}>Mist reported no WLANs — a real answer, not a failed read.</div>
      ) : (
        <>
          {wlans.map((row) => (
            <WlanRow key={`${row.name}|${row.vlan}|${row.targets}`} row={row} />
          ))}
          <div style={{ ...noteStyle, fontSize: 10.5, paddingTop: 6 }}>
            Scope text as Mist reports it — the same WLAN at several sites is one row naming them
            all. Edits go through{' '}
            <Link to="/configure" style={{ color: 'var(--nd-accent)' }}>
              Configure's Mist flow
            </Link>
            .
          </div>
        </>
      )}
    </div>
  );
}
