/**
 * Global search index: GET /api/search-index (+ CSV export).
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Entries blend raised tickets, live inventory rows (per-section source/blend),
 * and fixture SEARCH_INDEX hits that still apply. Envelope dataSource/syncedAt
 * describe what was actually served, not the portal-wide default alone.
 *
 * GET /search-index/export must stay ahead of any future /search-index/:param
 * so Express never treats "export" as a param. CSV is kind/label/meta/view/arg
 * only — never secrets or raw vendor bodies.
 */

import type { Request, Router } from 'express';
import {
  SEARCH_INDEX,
  type SearchIndexEntry,
  type ScreenSection,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryString } from '../../lib/query';
import { poller } from '../../services/poller';
import { ticketStore } from '../../services/tickets';
import {
  blendFor,
  dataSource,
  sourceFor,
  syncedAt,
  withBlended,
} from './context';
import { liveClients, liveMerged } from './liveCore';

/** Raised tickets as search entries — real user data, so searchable in both
 *  modes (arg carries the id so the hit deep-links to /tickets?sel=<id>). */
function ticketSearchEntries(): SearchIndexEntry[] {
  return ticketStore.list().map((t) => ({
    kind: 'ticket',
    label: `${t.id} — ${t.title}`,
    meta: `${t.pri} · ${t.state}`,
    view: 'tickets',
    arg: t.id,
  }));
}

/** Fixture search entries that belong to a source-selectable screen. */
function searchSection(entry: SearchIndexEntry): ScreenSection | null {
  if (entry.kind === 'site') return 'sites';
  if (entry.kind === 'device' || entry.kind === 'mac' || entry.kind === 'ip') return 'devices';
  if (entry.kind === 'client') return entry.view === 'auth' ? 'authEvents' : 'clients';
  if (entry.kind === 'config') return 'configure';
  return null;
}

/** Live-derived index rows, grouped so each section can follow sourceFor(). */
function liveSearchSections(): {
  sites: SearchIndexEntry[];
  devices: SearchIndexEntry[];
  clients: SearchIndexEntry[];
} {
  const live = liveMerged();
  return {
    sites: live.sites.map<SearchIndexEntry>((s) => ({
      kind: 'site',
      label: s.name,
      meta: `${s.devices} devices`,
      view: 'site',
      arg: s.name,
    })),
    devices: live.devices.map<SearchIndexEntry>((d) => ({
      kind: 'device',
      label: d.name,
      meta: `${d.model} · ${d.siteName}`,
      view: 'device',
      arg: d.name,
    })),
    clients: liveClients().map<SearchIndexEntry>((c) => ({
      kind: 'client',
      label: c.name,
      meta: `${c.mac} · ${c.siteName}`,
      view: 'clients',
      arg: c.mac,
    })),
  };
}

/** Build the same entry list the JSON envelope and CSV export share. */
export function buildSearchIndexEntries(): {
  entries: SearchIndexEntry[];
  liveContributed: boolean;
  fixtures: SearchIndexEntry[];
  blended: ScreenSection[];
} {
  const raised = ticketSearchEntries();
  const live = liveSearchSections();
  const liveRows = {
    sites: live.sites.length > 0,
    devices: live.devices.length > 0,
    clients: live.clients.length > 0,
  };
  const useLive = new Set<ScreenSection>();
  const blended: ScreenSection[] = [];
  for (const section of ['sites', 'devices', 'clients'] as const) {
    if (sourceFor(section) === 'live') {
      useLive.add(section);
    } else if (blendFor(section) && liveRows[section]) {
      useLive.add(section);
      blended.push(section);
    }
  }
  // Sections with no live search-row projection still must lose fixture hits
  // when pinned live; otherwise search can navigate into a live screen using
  // demo-only objects. Auth events also support blend mode.
  if (sourceFor('authEvents') === 'live') {
    useLive.add('authEvents');
  } else if (blendFor('authEvents') && poller.getCache().authEvents.length > 0) {
    useLive.add('authEvents');
    blended.push('authEvents');
  }
  if (sourceFor('configure') === 'live') useLive.add('configure');

  const raisedIds = new Set(raised.map((entry) => entry.arg));
  const fixtures = SEARCH_INDEX.filter((entry) => {
    if (entry.kind === 'ticket' && entry.arg !== null && raisedIds.has(entry.arg)) return false;
    const section = searchSection(entry);
    if (section === null) return dataSource() === 'demo';
    return sourceFor(section) === 'demo' && !useLive.has(section);
  });
  const entries = [
    ...raised,
    ...(useLive.has('sites') ? live.sites : []),
    ...(useLive.has('devices') ? live.devices : []),
    ...(useLive.has('clients') ? live.clients : []),
    ...fixtures,
  ];
  const liveContributed =
    useLive.size > 0 && (live.sites.length > 0 || live.devices.length > 0 || live.clients.length > 0);
  return { entries, liveContributed, fixtures, blended };
}

/**
 * Optional `?q=` substring (label/meta/kind/view/arg) and `?kind=` exact
 * (case-insensitive) filters for list parity on the CSV export. Empty values
 * leave the index alone — never invent emptiness from an unknown kind token.
 * Loop 122: shared `queryString` so non-string query bags are honest no-ops.
 */
export function applySearchIndexFilters(
  req: Request,
  entries: readonly SearchIndexEntry[],
): SearchIndexEntry[] {
  const q = queryString(req, 'q').toLowerCase();
  const kind = queryString(req, 'kind').toLowerCase();
  if (!q && !kind) return [...entries];
  return entries.filter((e) => {
    if (kind && String(e.kind ?? '').toLowerCase() !== kind) return false;
    if (q) {
      const hay = [e.label, e.meta, e.kind, e.view, e.arg ?? '']
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function registerSearchRoutes(router: Router): void {
  /**
   * GET /api/search-index/export — CSV of the global jump index (same blend
   * rules as JSON). Optional q/kind match operator filter intent. No secrets.
   */
  router.get('/search-index/export', (req, res) => {
    const { entries } = buildSearchIndexEntries();
    const filtered = applySearchIndexFilters(req, entries);
    sendCsv(
      res,
      'search-index.csv',
      ['kind', 'label', 'meta', 'view', 'arg'],
      filtered.map((e) => [e.kind, e.label, e.meta ?? '', e.view ?? '', e.arg ?? '']),
    );
  });

  router.get('/search-index', (_req, res) => {
    const { entries, liveContributed, fixtures, blended } = buildSearchIndexEntries();
    // The envelope must describe what was actually served, not the portal-wide
    // default: an index whose every entry came from the poller is a live index,
    // and its freshness is the poll time — stamping `now` from the global
    // demoMode would label live hits as demo furniture.
    const payload = {
      dataSource: liveContributed && fixtures.length === 0 ? 'live' : dataSource(),
      syncedAt: liveContributed ? poller.lastSyncFor('devices', 'sites', 'clients') : syncedAt(),
      entries,
    };
    res.json(blended.length > 0 ? withBlended(payload, blended) : payload);
  });
}
