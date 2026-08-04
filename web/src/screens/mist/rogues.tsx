/**
 * web/src/screens/mist/rogues.tsx — the rogue/neighbor AP row rendering,
 * shared by the site page's per-site section (siteDetail/RogueAps.tsx) and
 * the Mist screen's across-sites section below.
 *
 * The row bits (sort, verdict badge, row) are extracted here unchanged so the
 * two screens can never drift on what the on-your-wire flag means: true is
 * the alarm (a rogue whose BSSID resolves to YOUR wired infrastructure),
 * false is a neighbor, null reads "not reported" — never an assumed safe.
 * `EstateRogueAps` adds the across-sites wrapper: on-your-wire rows lead
 * under a danger Alert, each row naming its site, with the same honesty
 * rules as the site section (absent = not reported, empty = a real answer).
 */

import { Link } from 'react-router-dom';
import { Alert, Badge, SectionHeader } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { MistRogueApRow } from '@hpe/shared';
import { noteStyle } from './style';

/** On-LAN first, then strongest signal first; a row with no reported signal
 *  settles after every reported one rather than reading as the weakest. */
export function byAlarmThenSignal(a: MistRogueApRow, b: MistRogueApRow): number {
  const alarmA = a.seenOnLan === true ? 0 : 1;
  const alarmB = b.seenOnLan === true ? 0 : 1;
  if (alarmA !== alarmB) return alarmA - alarmB;
  return (b.avgRssi ?? -Infinity) - (a.avgRssi ?? -Infinity);
}

export function VerdictBadge({ row }: { row: MistRogueApRow }) {
  if (row.seenOnLan === true) return <Badge tone="danger">ON YOUR WIRE</Badge>;
  if (row.seenOnLan === false) return <Badge tone="neutral">neighbor</Badge>;
  return <Badge tone="neutral">not reported</Badge>;
}

export function RogueRow({ row, siteLabel = false }: { row: MistRogueApRow; siteLabel?: boolean }) {
  const facts = [
    row.channel !== null ? `ch ${row.channel}` : null,
    row.avgRssi !== null ? `${row.avgRssi} dBm` : null,
    row.numAps !== null ? `heard by ${countOf(row.numAps, 'AP')}` : null,
  ]
    .filter((f): f is string => f !== null)
    .join(' · ');
  return (
    <Link
      to={`/sites/${encodeURIComponent(row.siteId)}`}
      aria-label={`Open site ${row.siteName} for rogue ${row.bssid}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
        textDecoration: 'none',
      }}
    >
      <VerdictBadge row={row} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
          {row.ssid ?? 'SSID not broadcast'}
        </span>
        <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)' }}>
          {row.bssid}
          {siteLabel ? ` · ${row.siteName}` : ''}
        </span>
      </span>
      <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', textAlign: 'right' }}>
        {facts || 'no readings reported'}
      </span>
    </Link>
  );
}

/**
 * The Mist screen's across-sites section: every site's rogue/neighbor report
 * in one list, on-your-wire first. `rogues` ABSENT means the walk was not
 * reported this cycle (a failed read, or no linked Mist plane) — worded as
 * such, never as an all-clear; present-and-empty is the real all-clear.
 */
export function EstateRogueAps({ rogues }: { rogues: MistRogueApRow[] | undefined }) {
  const rows = rogues === undefined ? [] : [...rogues].sort(byAlarmThenSignal);
  const onLan = rows.filter((r) => r.seenOnLan === true);
  const sites = new Set(rows.map((r) => r.siteId)).size;
  const meta =
    rogues === undefined
      ? 'NOT REPORTED'
      : rows.length === 0
        ? 'NONE HEARD'
        : `${onLan.length > 0 ? `${onLan.length} ON YOUR WIRE · ` : ''}${rows.length} HEARD · ${countOf(sites, 'SITE').toUpperCase()} · MIST`;

  return (
    <div className="nt-stack nt-gap-2">
      <SectionHeader label="Rogue & neighbor APs" meta={meta} />
      {rogues === undefined ? (
        <div style={noteStyle}>
          The rogue/neighbor walk was not reported this cycle — a failed read, or no linked Mist
          plane. Nothing below is an all-clear.
        </div>
      ) : rows.length === 0 ? (
        <div style={noteStyle}>
          Mist reported no rogue or neighbor BSSIDs at any site this cycle — nothing in earshot is a
          real answer, not a failed read.
        </div>
      ) : (
        <>
          {onLan.length > 0 ? (
            <Alert tone="danger" title={`${countOf(onLan.length, 'rogue BSSID')} on your wire`}>
              A rogue AP whose traffic reaches your wired infrastructure is the finding to act on —
              everything below it is only in earshot.{' '}
              {onLan.map((r) => `${r.ssid ?? r.bssid} (${r.siteName})`).join(' · ')}
            </Alert>
          ) : null}
          {rows.map((row) => (
            <RogueRow key={`${row.siteId}:${row.bssid}`} row={row} siteLabel />
          ))}
        </>
      )}
    </div>
  );
}
