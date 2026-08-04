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

export const debugRouter = Router();

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

    const planeStates = registry.states();
    const planes = PLANE_IDS.map((id) => {
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
      planes,
    });
  }),
);

/**
 * GET /api/debug/runtime/export — CSV of plane link/health facts only.
 * No notes, secrets, tokens, or request bodies.
 */
debugRouter.get(
  '/debug/runtime/export',
  h((_req, res) => {
    const planeStates = registry.states();
    sendCsv(
      res,
      'runtime-planes.csv',
      ['id', 'linked', 'health', 'stale', 'reason', 'ageSec', 'lastSync', 'noteChars'],
      PLANE_IDS.map((id) => {
        const st = planeStates[id];
        return [
          id,
          st.linked,
          st.health,
          st.stale,
          st.reason ?? '',
          st.ageSec ?? '',
          st.lastSync ?? '',
          typeof st.note === 'string' ? st.note.length : 0,
        ];
      }),
    );
  }),
);
