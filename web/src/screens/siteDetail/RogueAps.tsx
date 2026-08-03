/**
 * web/src/screens/siteDetail/RogueAps.tsx — the site page's "Rogue & neighbor
 * APs" section: the BSSIDs the site's APs hear, from Mist's per-site
 * insights/rogues walk (the only plane that publishes one).
 *
 * The on-your-wire flag (seen_on_lan) is the alarm half and is rendered as
 * such: a rogue whose BSSID resolves to YOUR wired infrastructure leads the
 * section under a danger Alert, because that is the finding — a neighbor SSID
 * in earshot is noise by comparison. Rows sort on-LAN first, then strongest
 * signal first.
 *
 * The row rendering (sort, verdict badge, row) lives in ../mist/rogues.tsx,
 * shared with the Mist screen's across-sites section — one place decides
 * what the flag means.
 *
 * Honesty rules, matching the floor-plan and SLE sections:
 *  - `rogues` ABSENT -> the route did not say ("not reported").
 *  - `rogues` EMPTY  -> a real answer: the site's APs heard nothing (or no
 *                       plane publishes a report here — mistClaimed picks the
 *                       sentence), never a fabricated all-clear score.
 *  - seen_on_lan null -> "not reported", never an assumed safe-looking false.
 */

import { Alert, SectionHeader } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { MistRogueApRow } from '@hpe/shared';
import { byAlarmThenSignal, RogueRow } from '../mist/rogues';
import { noteStyle } from '../mist/style';

/**
 * The section. Rendered for every site — a site no plane watches gets the
 * honest not-reported line, never a "0 rogues" all-clear the portal cannot
 * stand behind.
 */
export function SiteRogueAps({
  rogues,
  mistClaimed,
}: {
  rogues: MistRogueApRow[] | undefined;
  /** True when a Mist badge claims the site — selects which honest empty
   *  sentence the section shows (Mist watched and heard nothing vs no plane
   *  publishes a rogue report here at all). */
  mistClaimed: boolean;
}) {
  const rows = rogues === undefined ? [] : [...rogues].sort(byAlarmThenSignal);
  const onLan = rows.filter((r) => r.seenOnLan === true);
  const meta =
    rogues === undefined
      ? 'NOT REPORTED'
      : rows.length === 0
        ? 'NONE HEARD'
        : `${onLan.length > 0 ? `${onLan.length} ON YOUR WIRE · ` : ''}${rows.length} HEARD · MIST`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader label="Rogue & neighbor APs" meta={meta} />
      {rogues === undefined ? (
        <div style={noteStyle}>The portal did not say whether this site reports rogue detection.</div>
      ) : rows.length === 0 ? (
        <div style={noteStyle}>
          {mistClaimed
            ? 'Mist reported no rogue or neighbor BSSIDs at this site this cycle — nothing in earshot is a real answer, not a failed read.'
            : 'No linked plane publishes rogue detection for this site.'}
        </div>
      ) : (
        <>
          {onLan.length > 0 ? (
            <Alert tone="danger" title={`${countOf(onLan.length, 'rogue BSSID')} on your wire`}>
              A rogue AP whose traffic reaches your wired infrastructure is the finding to act on —
              everything below it is only in earshot.{' '}
              {onLan.map((r) => r.ssid ?? r.bssid).join(' · ')}
            </Alert>
          ) : null}
          {rows.map((row) => (
            <RogueRow key={row.bssid} row={row} />
          ))}
        </>
      )}
    </div>
  );
}
