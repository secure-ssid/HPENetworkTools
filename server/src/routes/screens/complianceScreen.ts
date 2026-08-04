/**
 * Compliance screen routes: findings envelope + CSV export.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Honesty: CSV exports finding metadata only — never the full config diff body.
 * Optional `?baseline=` / `?sev=` / `?plane=` / `?fix=` / `?q=` narrow findings[]
 * (and export) to the same slice the Compliance filter row shows; stats/baselines
 * stay full so a filtered view cannot pretend the estate pass-rate changed.
 * Unknown sev / fix values 400 rather than silently returning everything. `q` is
 * a case-insensitive substring over title/detail/rule/device/plane/baseline.
 */

import type { Request, Router } from 'express';
import {
  BASELINE_PROGRESS,
  COMPLIANCE_DIFF,
  COMPLIANCE_STATS,
  FINDINGS,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryString } from '../../lib/query';
import { configBackups } from '../../services/configBackup';
import {
  blendFor,
  datasetReported,
  envelopeFor,
  sourceFor,
  withBlended,
} from './context';
import { liveComplianceData } from './complianceModel';
import { liveDeviceData, planesMissingDataset } from './liveCore';

const COMPLIANCE_SEV = new Set(['high', 'med', 'low']);
/** Fix-class vocabulary on FindingRow.fix (exact, case-insensitive). */
const COMPLIANCE_FIX = new Set(['auto', 'manual', 'window', 'ssh scan']);

const COMPLIANCE_Q_FIELDS = ['title', 'detail', 'rule', 'device', 'plane', 'baseline'] as const;

/**
 * Honest finding filters matching the Compliance screen Selects + free-text q.
 * Loop 122: shared `queryString` (non-string → honest no-op). Returns
 * `{ error }` when sev/fix is named but not in the vocabulary.
 */
export function applyComplianceFindingFilters(
  req: Request,
  body: Record<string, unknown>,
): { body: Record<string, unknown> } | { error: string } {
  const list = body.findings;
  if (!Array.isArray(list)) return { body };

  // Loop 122: shared queryString — arrays/numbers never become filter tokens.
  const baselineRaw = queryString(req, 'baseline');
  const sevRaw = queryString(req, 'sev').toLowerCase();
  const planeRaw = queryString(req, 'plane');
  const fixRaw = queryString(req, 'fix').toLowerCase();
  const qRaw = queryString(req, 'q').toLowerCase();

  if (sevRaw && !COMPLIANCE_SEV.has(sevRaw)) {
    return { error: "sev must be 'high', 'med', or 'low'" };
  }
  if (fixRaw && !COMPLIANCE_FIX.has(fixRaw)) {
    return { error: "fix must be 'auto', 'manual', 'window', or 'ssh scan'" };
  }
  if (!baselineRaw && !sevRaw && !planeRaw && !fixRaw && !qRaw) return { body };

  const planeWant = planeRaw.toLowerCase();
  const filtered = (list as Record<string, unknown>[]).filter((row) => {
    if (baselineRaw) {
      if (String(row.baseline ?? '') !== baselineRaw) return false;
    }
    if (sevRaw) {
      if (String(row.sev ?? '').toLowerCase() !== sevRaw) return false;
    }
    if (planeWant) {
      if (String(row.plane ?? '').toLowerCase() !== planeWant) return false;
    }
    if (fixRaw) {
      if (String(row.fix ?? '').toLowerCase() !== fixRaw) return false;
    }
    if (qRaw) {
      const hay = COMPLIANCE_Q_FIELDS.map((k) => String(row[k] ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(qRaw)) return false;
    }
    return true;
  });
  return { body: { ...body, findings: filtered } };
}

function complianceBody(): Record<string, unknown> {
  if (sourceFor('compliance') === 'demo') {
    // Blend: the authored findings describe the demo estate's drift. Once a
    // plane reports inventory, serve the live evidence-coverage run instead —
    // Compliance was the last screen still pinned to fixtures under a blend.
    if (blendFor('compliance') && datasetReported('devices')) {
      const blendMissing = planesMissingDataset('devices');
      const blendCompliance = liveComplianceData(liveDeviceData().devices, blendMissing, configBackups.summary());
      return withBlended(
        envelopeFor('compliance', {
          ...blendCompliance,
          missingInventories: blendMissing,
          evidenceMode: 'coverage',
        }),
        ['compliance'],
        'compliance',
      );
    }
    return envelopeFor('compliance', {
      stats: COMPLIANCE_STATS,
      findings: FINDINGS,
      baselines: BASELINE_PROGRESS,
      diff: COMPLIANCE_DIFF,
      evidenceMode: 'baseline',
    });
  }
  const devicesReported = datasetReported('devices');
  // datasetReported is true as soon as ONE plane answers. Naming the planes
  // that did not keeps a coverage run over a fraction of the estate from
  // reading as a verdict on all of it.
  const missingInventories = planesMissingDataset('devices');
  const compliance = devicesReported
    ? liveComplianceData(liveDeviceData().devices, missingInventories, configBackups.summary())
    : { stats: [], findings: [], baselines: [], diff: '' };
  return envelopeFor('compliance', {
    ...compliance,
    missingInventories,
    evidenceMode: devicesReported ? 'coverage' : 'unavailable',
  });
}

export function registerComplianceRoutes(router: Router): void {
  router.get('/compliance', (req, res) => {
    const filtered = applyComplianceFindingFilters(req, complianceBody());
    if ('error' in filtered) {
      res.status(400).json({ error: filtered.error });
      return;
    }
    res.json(filtered.body);
  });

  /** GET /api/compliance/export — CSV of findings (no full diff dump; optional filters). */
  router.get('/compliance/export', (req, res) => {
    const filtered = applyComplianceFindingFilters(req, complianceBody());
    if ('error' in filtered) {
      res.status(400).json({ error: filtered.error });
      return;
    }
    const findings = (filtered.body.findings as Array<Record<string, unknown>>) ?? [];
    sendCsv(
      res,
      'compliance-findings.csv',
      ['sev', 'title', 'detail', 'rule', 'plane', 'count', 'fix', 'device', 'baseline'],
      findings.map((f) => [
        f.sev,
        f.title,
        f.detail,
        f.rule,
        f.plane,
        f.count,
        f.fix,
        f.device,
        f.baseline,
      ]),
    );
  });
}
