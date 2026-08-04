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
 * The row rendering (sort, verdict badge, columns) lives in ../mist/rogues.tsx,
 * shared with the Mist screen's across-sites section — one place decides
 * what the flag means.
 *
 * Multi-select (Loop 193) raises **Export selected**, **Copy BSSIDs**,
 * **Copy selection link** (`?bssids=` + section=rogues; clearable chip), and
 * Clear.
 *
 * Honesty rules, matching the floor-plan and SLE sections:
 *  - `rogues` ABSENT -> the route did not say ("not reported").
 *  - `rogues` EMPTY  -> a real answer: the site's APs heard nothing (or no
 *                       plane publishes a report here — mistClaimed picks the
 *                       sentence), never a fabricated all-clear score.
 *  - seen_on_lan null -> "not reported", never an assumed safe-looking false.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, DataTable, SectionHeader, useToast } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { MistRogueApRow } from '@hpe/shared';
import { namesFilterForParam } from '../../app/nav';
import { exportTableCsv } from '../../lib/csv';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import {
  byAlarmThenSignal,
  rogueColumns,
  rogueCsvRows,
  rogueRowKey,
  ROGUE_CSV_HEADERS,
} from '../mist/rogues';

/** Canonical share target for the site rogues section. */
export function siteRoguesSectionUrl(
  pathname: string = typeof window !== 'undefined' ? window.location.pathname : '',
): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const base = pathname || '/sites';
  return `${origin}${base}?section=rogues#rogues`;
}

/** Server CSV path for this site's Mist rogue/neighbor BSSIDs. */
export function siteRoguesExportPath(siteKey: string): string {
  const key = siteKey.trim();
  if (!key) return '/api/sites/export';
  return `/api/sites/${encodeURIComponent(key)}/rogues/export`;
}

/**
 * The section. Rendered for every site — a site no plane watches gets the
 * honest not-reported line, never a "0 rogues" all-clear the portal cannot
 * stand behind.
 */
export function SiteRogueAps({
  rogues,
  mistClaimed,
  siteKey,
  live = false,
}: {
  rogues: MistRogueApRow[] | undefined;
  /** True when a Mist badge claims the site — selects which honest empty
   *  sentence the section shows (Mist watched and heard nothing vs no plane
   *  publishes a rogue report here at all). */
  mistClaimed: boolean;
  /** Canonical site id for server CSV (live/blend only). */
  siteKey?: string;
  /** True when the parent site envelope is live/blend — gates server CSV. */
  live?: boolean;
}) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /sites/:id?section=rogues&bssids=aa\nbb (bulk Copy selection link). */
  const bssidsFilter = namesFilterForParam(searchParams.get('bssids'));

  const sorted = rogues === undefined ? [] : [...rogues].sort(byAlarmThenSignal);
  const rows =
    bssidsFilter === null
      ? sorted
      : sorted.filter((r) => bssidsFilter.includes(r.bssid));
  const bssidsPresent =
    bssidsFilter === null
      ? 0
      : bssidsFilter.filter((b) => sorted.some((r) => r.bssid === b)).length;
  const onLan = rows.filter((r) => r.seenOnLan === true);
  const meta =
    rogues === undefined
      ? 'NOT REPORTED'
      : sorted.length === 0
        ? 'NONE HEARD'
        : bssidsFilter !== null
          ? `${countOf(rows.length, 'HEARD').toUpperCase()} OF ${sorted.length} · MIST`
          : `${onLan.length > 0 ? `${onLan.length} ON YOUR WIRE · ` : ''}${rows.length} HEARD · MIST`;

  const copySectionLink = () => {
    const url = siteRoguesSectionUrl();
    void navigator.clipboard.writeText(url).then(
      () => toast('Rogues section link copied', { description: 'section=rogues', tone: 'success' }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  const exportCsv = () => {
    if (rows.length === 0) return;
    const n = exportTableCsv(
      'site-rogues.csv',
      [...ROGUE_CSV_HEADERS],
      rogueCsvRows(rows),
    );
    toast(`Exported ${n} rogue${n === 1 ? '' : 's'}`, {
      description: 'site-rogues.csv — BSSIDs currently in this section (on-wire first).',
    });
  };

  const downloadServerCsv = () => {
    if (!siteKey?.trim()) return;
    void (async () => {
      const path = siteRoguesExportPath(siteKey);
      const res = await downloadApiCsv(path, `site-rogues-${siteKey.trim()}.csv`);
      if (res.ok) {
        toast('Server CSV downloaded', {
          description: 'site-rogues.csv — Mist rogue/neighbor BSSIDs for this site.',
          tone: 'success',
        });
      } else {
        toast('Server CSV failed', {
          description: res.error ?? 'Could not download export',
          tone: 'warning',
        });
      }
    })();
  };

  return (
    <div className="nt-site-section nt-section-panel nt-stack nt-gap-2">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · RF theater · rogue · neighbor APs</div>
      <div className="nt-row-between-8">
        <SectionHeader label="Rogue & neighbor APs" meta={meta} />
        <div className="nt-wrap-6">
          <Button variant="ghost" size="sm" onClick={copySectionLink}>
            Copy section link
          </Button>
          {rows.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
          ) : null}
          {live && siteKey?.trim() && rogues !== undefined ? (
            <Button variant="ghost" size="sm" onClick={downloadServerCsv}>
              Download server CSV
            </Button>
          ) : null}
        </div>
      </div>
      {rogues === undefined ? (
        <div className="nt-service-note">The portal did not say whether this site reports rogue detection.</div>
      ) : sorted.length === 0 ? (
        <div className="nt-service-note">
          {mistClaimed
            ? 'Mist reported no rogue or neighbor BSSIDs at this site this cycle — nothing in earshot is a real answer, not a failed read.'
            : 'No linked plane publishes rogue detection for this site.'}
        </div>
      ) : (
        <>
          {bssidsFilter !== null ? (
            <div className="nt-chip-row" role="group" aria-label="Rogue selection deep link">
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('bssids');
                  setSearchParams(next, { replace: true });
                  setSelectedKeys([]);
                }}
                title={bssidsFilter.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {bssidsPresent === bssidsFilter.length
                  ? `${bssidsFilter.length} selected BSSID${bssidsFilter.length === 1 ? '' : 's'}`
                  : `${bssidsPresent} of ${bssidsFilter.length} selected BSSIDs present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          {onLan.length > 0 ? (
            <Alert tone="danger" title={`${countOf(onLan.length, 'rogue BSSID')} on your wire`}>
              A rogue AP whose traffic reaches your wired infrastructure is the finding to act on —
              everything below it is only in earshot.{' '}
              {onLan.map((r) => r.ssid ?? r.bssid).join(' · ')}
            </Alert>
          ) : null}
          {rows.length === 0 ? (
            <div className="nt-service-note">
              No rogue BSSIDs match the selection deep link — clear the chip to restore the full
              site list.
            </div>
          ) : (
            <DataTable
              ariaLabel="Site rogue and neighbor APs"
              columns={rogueColumns(false)}
              rows={rows}
              rowKey={rogueRowKey}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
            />
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Site rogue selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy BSSIDs, or share a selection link for only the rogues you marked — full
                list export stays in the header
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = rows.filter((r) => selected.has(rogueRowKey(r)));
                    if (picked.length === 0) {
                      toast('No selected rogues still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'site-rogues-selected.csv',
                      [...ROGUE_CSV_HEADERS],
                      rogueCsvRows(picked),
                    );
                    toast(`Exported ${countOf(n, 'selected rogue')}`, {
                      description: 'site-rogues-selected.csv — BSSID inventory fields only.',
                      tone: 'success',
                    });
                  }}
                >
                  Export selected
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((r) => selected.has(rogueRowKey(r)));
                      if (picked.length === 0) {
                        toast('No selected rogues still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const bssids = [
                        ...new Set(
                          picked
                            .map((r) => (r.bssid ?? '').trim())
                            .filter((b) => b.length > 0),
                        ),
                      ];
                      if (bssids.length === 0) {
                        toast('No BSSIDs on the selected rogues', {
                          description: 'Export CSV for row detail instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = bssids.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(bssids.length, 'BSSID')}`, {
                          description:
                            bssids.length < picked.length
                              ? `${picked.length - bssids.length} selected without a BSSID skipped`
                              : 'newline-joined · paste into a ticket or change window',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy BSSIDs', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy BSSIDs
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = rows.filter((r) => selected.has(rogueRowKey(r)));
                      if (picked.length === 0) {
                        toast('No selected rogues still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const bssids = [
                        ...new Set(
                          picked
                            .map((r) => (r.bssid ?? '').trim())
                            .filter((b) => b.length > 0),
                        ),
                      ];
                      if (bssids.length === 0) {
                        toast('No BSSIDs on the selected rogues', {
                          description: 'Export CSV for row detail instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('bssids', bssids.join('\n'));
                      next.set('section', 'rogues');
                      const qs = next.toString();
                      const path = window.location.pathname || '/sites';
                      const url = `${window.location.origin}${path}${qs ? `?${qs}` : ''}#rogues`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${bssids.length} BSSID${bssids.length === 1 ? '' : 's'} · bssids=`,
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy link', { description: url, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy selection link
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                  Clear
                </Button>
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
