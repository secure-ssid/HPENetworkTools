/**
 * Configure screen read model: GET /api/configure (+ inventory CSV export).
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Brokered-write mutations and GET /configure/history(+export) stay on
 * routes/configure.ts — this module serves the Configure screen envelope
 * (stats, inventory examples, queue snapshot, capability matrix) and the
 * inventory summary CSV (`GET /configure/export?part=ssids|ports|vlans`).
 */

import type { Request, Router } from 'express';
import {
  CAPABILITY_MATRIX,
  CONFIG_PORTS,
  CONFIGURE_EXPORT_PARTS,
  SSIDS,
  VLANS,
  type CapabilityRow,
  type ConfigureExportPart,
  type PortObject,
  type SsidObject,
  type VlanObject,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryString } from '../../lib/query';
import { settings } from '../../config/settings';
import { registry } from '../../planes/registry';
import { PLANE_IDS } from '../../planes/types';
import { evaluateWriteAdmission } from '../../services/writeAdmission';
import { liveComplianceData } from './complianceModel';
import {
  demoConfigureQueue,
  demoConfigureStats,
  liveConfigureInventory,
  liveConfigureQueue,
  liveConfigureStats,
} from './configureModel';
import {
  blendFor,
  datasetReported,
  envelopeFor,
  sourceFor,
  withBlended,
} from './context';
import { liveDeviceData, planesMissingDevices } from './liveCore';
import { SYSTEM_DISPLAY } from './systemsModel';

/**
 * "Where a change can go" for the real deployment: one row per registry
 * plane. Configuration write modes come from the same server-side admission
 * predicate that guards the mutation routes. SSH remains a separate local
 * shell capability and never implies configuration-write admission.
 */
function liveCapabilityMatrix(): CapabilityRow[] {
  const states = registry.states();
  const stored = settings.get().planes;
  return PLANE_IDS.filter((id) => SYSTEM_DISPLAY[id]).map((id) => {
    const state = states[id];
    const linked = state.linked;
    const brokerAdmitted =
      id === 'central' && evaluateWriteAdmission({ operation: 'central-broker', plane: 'central' }).ok;
    const directSsidAdmitted =
      (id === 'central' || id === 'mist') && evaluateWriteAdmission({ operation: 'ssid', plane: id }).ok;
    const shellAdmitted =
      linked && stored[id]?.scopes?.includes('ssh') === true && state.capabilities?.localShell === true;
    const mode: CapabilityRow['mode'] =
      brokerAdmitted ? 'brokered' : directSsidAdmitted ? 'direct' : shellAdmitted ? 'ssh' : 'read only';
    const note = !linked
      ? 'not linked — no credentials stored'
      : state.health === 'degraded'
        ? 'linked, but the plane is not answering'
        : mode === 'brokered'
          ? 'Central broker write admitted'
          : mode === 'ssh'
            ? 'recorded shell, window only'
            : mode === 'direct'
              ? 'direct SSID write admitted'
              : 'payload pre-filled in the plane console';
    return {
      plane: stored[id]?.displayName ?? SYSTEM_DISPLAY[id]!,
      note,
      mode,
      canBrokerWrite: brokerAdmitted,
      canDirectWrite: directSsidAdmitted,
      tone: mode === 'read only' ? 'neutral' : 'accent',
      linked,
      planeId: id,
    };
  });
}

/** Resolve the same SSID/port/VLAN inventory the Configure envelope uses. */
export function configureInventorySlices(): {
  ssids: SsidObject[];
  ports: PortObject[];
  vlans: VlanObject[];
} {
  if (sourceFor('configure') === 'demo') {
    const inventory = liveConfigureInventory();
    if (blendFor('configure') && inventory.mode !== 'unavailable') {
      return { ssids: inventory.ssids, ports: inventory.ports, vlans: inventory.vlans };
    }
    return { ssids: SSIDS, ports: CONFIG_PORTS, vlans: VLANS };
  }
  const inventory = liveConfigureInventory();
  return { ssids: inventory.ssids, ports: inventory.ports, vlans: inventory.vlans };
}

/**
 * Loop 121: shared queryString for part (trim; empty/non-string → ssids default).
 * Singular aliases (ssid/port/vlan) still resolve. Named-unknown → null → 400.
 */
export function parseConfigureExportPart(req: Request): ConfigureExportPart | null {
  const v = queryString(req, 'part').toLowerCase() || 'ssids';
  if (v === 'ssid') return 'ssids';
  if (v === 'port') return 'ports';
  if (v === 'vlan') return 'vlans';
  if ((CONFIGURE_EXPORT_PARTS as readonly string[]).includes(v)) return v as ConfigureExportPart;
  return null;
}

/** Optional substring filter over Configure inventory export rows. */
export function filterConfigureExportRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  q: string,
  fields: readonly (keyof T)[],
): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => {
    const hay = fields
      .map((f) => {
        const v = row[f];
        if (v === null || v === undefined) return '';
        if (typeof v === 'boolean') return v ? 'yes' : 'no';
        return String(v);
      })
      .join(' ')
      .toLowerCase();
    return hay.includes(needle);
  });
}

export function registerConfigureScreenRoutes(router: Router): void {
  /**
   * GET /api/configure/export?part=ssids|ports|vlans — inventory summary CSV
   * (same slices as the Configure screen). Optional `q=` substring. No config
   * bodies, PSKs, or secrets. Must stay ahead of any future /configure/:param.
   * Loop 121: shared queryString for part/q.
   */
  router.get('/configure/export', (req, res) => {
    const part = parseConfigureExportPart(req);
    if (part === null) {
      res.status(400).json({
        error: "part must be 'ssids', 'ports', or 'vlans'",
        code: 'CONFIGURE_EXPORT_PART',
      });
      return;
    }
    const q = queryString(req, 'q');
    const inv = configureInventorySlices();
    if (part === 'ssids') {
      const rows = filterConfigureExportRows(inv.ssids as unknown as Array<Record<string, unknown>>, q, [
        'name',
        'vlan',
        'security',
        'targets',
        'plane',
        'origin',
        'note',
      ]);
      sendCsv(
        res,
        'configure-ssids.csv',
        ['name', 'vlan', 'security', 'targets', 'plane', 'origin', 'enabled', 'note'],
        rows.map((w) => [
          w.name ?? '',
          w.vlan ?? '',
          w.security ?? '',
          w.targets ?? '',
          w.plane ?? '',
          w.origin ?? '',
          w.enabled === true ? 'yes' : w.enabled === false ? 'no' : '',
          w.note ?? '',
        ]),
      );
      return;
    }
    if (part === 'ports') {
      const rows = filterConfigureExportRows(inv.ports as unknown as Array<Record<string, unknown>>, q, [
        'device',
        'port',
        'desc',
        'summary',
        'state',
        'plane',
        'serial',
        'origin',
      ]);
      sendCsv(
        res,
        'configure-ports.csv',
        ['device', 'port', 'desc', 'summary', 'state', 'plane', 'serial', 'origin'],
        rows.map((p) => [
          p.device ?? '',
          p.port ?? '',
          p.desc ?? '',
          p.summary ?? '',
          p.state ?? '',
          p.plane ?? '',
          p.serial ?? '',
          p.origin ?? '',
        ]),
      );
      return;
    }
    const rows = filterConfigureExportRows(inv.vlans as unknown as Array<Record<string, unknown>>, q, [
      'id',
      'name',
      'detail',
      'role',
      'plane',
      'scope',
      'origin',
    ]);
    sendCsv(
      res,
      'configure-vlans.csv',
      ['id', 'name', 'detail', 'role', 'plane', 'scope', 'origin'],
      rows.map((v) => [
        v.id ?? '',
        v.name ?? '',
        v.detail ?? '',
        v.role ?? '',
        v.plane ?? '',
        v.scope ?? '',
        v.origin ?? '',
      ]),
    );
  });

  /**
   * GET /api/configure — Configure screen envelope.
   * Key names follow the web client's ConfigureData contract (queued /
   * capabilities). The broker queue is authoritative in every source mode;
   * demo fixtures only supply the read-only inventory examples.
   */
  router.get('/configure', (_req, res) => {
    if (sourceFor('configure') === 'demo') {
      // Blend: configured API reads or live client evidence replace the authored
      // SSID/port/VLAN examples as one coherent live section.
      const inventory = liveConfigureInventory();
      if (blendFor('configure') && inventory.mode !== 'unavailable') {
        const blendQueue = liveConfigureQueue();
        const blendDriftMissing = planesMissingDevices();
        const blendCompliance = datasetReported('devices')
          ? liveComplianceData(liveDeviceData().devices, blendDriftMissing)
          : null;
        res.json(
          withBlended(
            envelopeFor('configure', {
              stats: liveConfigureStats(
                blendQueue,
                inventory.ssids.length + inventory.ports.length + inventory.vlans.length,
                inventory.detail,
                blendCompliance ? blendCompliance.findings.length : null,
                blendDriftMissing,
              ),
              ssids: inventory.ssids,
              ports: inventory.ports,
              vlans: inventory.vlans,
              inventoryMode: inventory.mode,
              queued: blendQueue,
              capabilities: liveCapabilityMatrix(),
            }),
            ['configure'],
            'configure',
          ),
        );
        return;
      }
      const queued = demoConfigureQueue();
      res.json(
        envelopeFor('configure', {
          stats: demoConfigureStats(queued),
          ssids: SSIDS,
          ports: CONFIG_PORTS,
          vlans: VLANS,
          inventoryMode: 'configured',
          queued,
          capabilities: CAPABILITY_MATRIX,
        }),
      );
      return;
    }
    const queued = liveConfigureQueue();
    const inventory = liveConfigureInventory();
    const configObjects = inventory.ssids.length + inventory.ports.length + inventory.vlans.length;
    const driftMissing = planesMissingDevices();
    const compliance = datasetReported('devices')
      ? liveComplianceData(liveDeviceData().devices, driftMissing)
      : null;
    res.json(
      // The capability matrix describes the portal's own write model — in live
      // mode that means what THIS deployment's linked planes can accept, not
      // the fixture estate's.
      envelopeFor('configure', {
        stats: liveConfigureStats(
          queued,
          inventory.mode === 'unavailable' ? null : configObjects,
          inventory.detail,
          compliance ? compliance.findings.length : null,
          driftMissing,
        ),
        ssids: inventory.ssids,
        ports: inventory.ports,
        vlans: inventory.vlans,
        inventoryMode: inventory.mode,
        queued,
        capabilities: liveCapabilityMatrix(),
      }),
    );
  });
}
