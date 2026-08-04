/**
 * server/src/routes/debug.ts — operator-facing runtime diagnostics.
 *
 * Never exposes secrets, credentials, tokens, or request bodies. Answers
 * process/plane/poller facts useful when debugging a stuck or degraded portal.
 */

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { h } from './handler';
import { settings } from '../config/settings';
import { registry } from '../planes/registry';
import { PLANE_IDS } from '../planes/types';
import { poller } from '../services/poller';
import { notifier } from '../services/notifier';
import { terminalManager } from '../services/terminal';
import { brokerDataDir } from '../services/writeBroker';
import { sendCsv } from '../lib/csv';
import { liveDeviceData } from './screens/liveCore';

export const debugRouter = Router();

/** Reconcile counts only — never device names, serials, MACs, or secrets. */
function integritySummary(): {
  devices: number;
  doubleClaimed: number;
  unclaimed: number;
} {
  const { devices, doubleClaimed, unclaimed } = liveDeviceData();
  return { devices: devices.length, doubleClaimed, unclaimed };
}

type RuntimePlaneFilter = 'all' | 'linked' | 'unlinked' | 'healthy' | 'degraded' | 'stale';

const RUNTIME_PLANE_FILTERS = new Set<RuntimePlaneFilter>([
  'all',
  'linked',
  'unlinked',
  'healthy',
  'degraded',
  'stale',
]);

type PlaneRow = {
  id: string;
  linked: boolean;
  health: string;
  stale: boolean;
  reason: string | null;
  ageSec: number | null;
  lastSync: string | null;
  noteChars: number;
};

function planeRows(): PlaneRow[] {
  const planeStates = registry.states();
  return PLANE_IDS.map((id) => {
    const st = planeStates[id];
    return {
      id,
      linked: st.linked,
      health: st.health,
      stale: st.stale,
      reason: st.reason,
      ageSec: st.ageSec,
      lastSync: st.lastSync,
      // note can carry vendor free text with hostnames — include only length.
      noteChars: typeof st.note === 'string' ? st.note.length : 0,
    };
  });
}

/** Same vocabulary as Systems → Runtime debug `?rtFilter=`. */
function parseRuntimePlaneFilter(raw: unknown): RuntimePlaneFilter | { error: string } {
  if (raw === undefined || raw === null || raw === '') return 'all';
  if (typeof raw !== 'string') {
    return { error: "filter must be 'linked', 'unlinked', 'healthy', 'degraded', or 'stale'" };
  }
  const v = raw.trim().toLowerCase() as RuntimePlaneFilter;
  if (!RUNTIME_PLANE_FILTERS.has(v)) {
    return { error: "filter must be 'linked', 'unlinked', 'healthy', 'degraded', or 'stale'" };
  }
  return v;
}

function matchesRuntimePlaneFilter(p: PlaneRow, filter: RuntimePlaneFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'linked':
      return p.linked;
    case 'unlinked':
      return !p.linked;
    case 'healthy':
      return p.linked && p.health === 'healthy' && !p.stale;
    case 'degraded':
      return p.linked && (p.health === 'degraded' || p.health === 'warning');
    case 'stale':
      return p.stale;
    default:
      return true;
  }
}

debugRouter.get(
  '/debug/runtime',
  h((_req, res) => {
    const mem = process.memoryUsage();
    const dataDir = brokerDataDir();
    let dataDirWritable: boolean | 'unknown' = 'unknown';
    try {
      fs.accessSync(dataDir, fs.constants.W_OK);
      dataDirWritable = true;
    } catch {
      dataDirWritable = false;
    }

    const planes = planeRows();
    const integrity = integritySummary();

    const s = settings.get();
    res.json({
      ok: true,
      at: new Date().toISOString(),
      process: {
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        uptimeSec: Math.round(process.uptime()),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
      },
      portal: {
        demoMode: s.demoMode,
        blendLive: s.blendLive === true,
        auth: s.auth ? 'oidc' : 'none',
        pollIntervalSec: s.pollIntervalSec,
        configMode: s.configMode === true,
      },
      dataDir: {
        path: path.basename(dataDir) === 'data' ? 'data/' : dataDir,
        writable: dataDirWritable,
      },
      poller: {
        // Poller surface is intentionally thin — running flag if present.
        running: typeof (poller as { isRunning?: () => boolean }).isRunning === 'function'
          ? Boolean((poller as { isRunning: () => boolean }).isRunning())
          : null,
        contributionPlanes: [...poller.contributionsByPlane().keys()],
      },
      notifier: {
        sampling: notifier.status().sampling,
        deliveryLogSize: notifier.deliveries().length,
        outboxSize: notifier.outbox().length,
      },
      terminal: {
        openSessions: terminalManager.listSessions().length,
      },
      /** Cross-plane reconcile tallies from live inventory (counts only). */
      integrity,
      planes,
    });
  }),
);

/**
 * GET /api/debug/runtime/export — CSV of connector/plane integrity summary.
 * Integrity metric rows + one row per plane link/health fact.
 * Optional `?filter=` matches Systems Runtime debug (`linked|unlinked|healthy|
 * degraded|stale`) so server CSV matches the on-screen plane slice. Integrity
 * tallies always ship (estate-wide counts, not filter-dependent).
 * No notes, secrets, tokens, device identities, or request bodies.
 */
debugRouter.get(
  '/debug/runtime/export',
  h((req, res) => {
    const filter = parseRuntimePlaneFilter(req.query.filter);
    if (typeof filter === 'object' && 'error' in filter) {
      res.status(400).json({ error: filter.error });
      return;
    }
    const integrity = integritySummary();
    const planes = planeRows().filter((p) => matchesRuntimePlaneFilter(p, filter));
    sendCsv(
      res,
      'connector-integrity.csv',
      [
        'kind',
        'id',
        'linked',
        'health',
        'stale',
        'reason',
        'ageSec',
        'lastSync',
        'noteChars',
        'count',
      ],
      [
        ['integrity', 'devices', '', '', '', '', '', '', '', integrity.devices],
        ['integrity', 'doubleClaimed', '', '', '', '', '', '', '', integrity.doubleClaimed],
        ['integrity', 'unclaimed', '', '', '', '', '', '', '', integrity.unclaimed],
        ...planes.map((p) => [
          'plane',
          p.id,
          p.linked,
          p.health,
          p.stale,
          p.reason ?? '',
          p.ageSec ?? '',
          p.lastSync ?? '',
          p.noteChars,
          '',
        ]),
      ],
    );
  }),
);
