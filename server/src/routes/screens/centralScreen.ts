/**
 * Central plane dashboard routes + CSV export.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * GET /central/export is registered before GET /central (and any future
 * /central/:param) so Express never treats "export" as a param. No secrets.
 *
 * Device rows reuse devicesBody() filtered to Central-claimed inventory
 * (claimedBy includes CENTRAL, else plane === CENTRAL). Site summary rows
 * reuse the shared centralSiteRows / demoCentralSections rollup.
 */

import type { Router } from 'express';
import {
  ALERTS,
  CENTRAL_EXPORT_PARTS,
  centralSections,
  centralSiteRows,
  demoCentralSections,
  type AlertRow,
  type CentralDataset,
  type CentralExportPart,
  type CentralFirmwareRow,
  type CentralPlaneStatus,
  type SsidObject,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { poller } from '../../services/poller';
import { registry } from '../../planes/registry';
import { alertQueueView } from '../../services/silences';
import { blending, dataSource, sourceFor } from './context';
import { sortLiveAlerts } from './liveCore';
import { SYSTEM_HEALTH_TONE } from './systemsModel';
import { withWebhookAlerts } from './webhookAlerts';
import { devicesBody } from './devicesScreen';

const DEVICE_HEADER = ['name', 'type', 'model', 'site', 'state', 'firmware', 'serial'] as const;
const FIRMWARE_HEADER = ['name', 'model', 'type', 'site', 'serial', 'firmware', 'target', 'update'] as const;
const WLAN_HEADER = ['name', 'vlan', 'security', 'targets', 'plane', 'enabled'] as const;
const ALERT_HEADER = ['sev', 'title', 'site', 'plane', 'age', 'device', 'state'] as const;

function parseCentralExportPart(raw: unknown): CentralExportPart | 'all' | null {
  const partRaw = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (partRaw === '' || partRaw === 'all') return 'all';
  if (partRaw === 'devices') return 'device';
  if (partRaw === 'sites') return 'site';
  if (partRaw === 'wlan' || partRaw === 'ssid' || partRaw === 'ssids') return 'wlans';
  if ((CENTRAL_EXPORT_PARTS as readonly string[]).includes(partRaw)) {
    return partRaw as CentralExportPart;
  }
  return null;
}

function centralClaimedFromInventory(): Array<Record<string, unknown>> {
  const body = devicesBody();
  const devices = (body.devices as Array<Record<string, unknown>>) ?? [];
  return devices.filter((d) => {
    const claimed = Array.isArray(d.claimedBy)
      ? (d.claimedBy as unknown[]).map((p) => String(p).toUpperCase())
      : null;
    if (claimed) return claimed.includes('CENTRAL');
    return String(d.plane ?? '').toUpperCase() === 'CENTRAL';
  });
}

function centralSiteSummaryRows(): Array<Record<string, unknown>> {
  if (sourceFor('devices') === 'demo') {
    return demoCentralSections().sites as unknown as Array<Record<string, unknown>>;
  }
  const pull = poller.contributionsByPlane().get('central');
  if (pull?.devices === undefined && pull?.sites === undefined) {
    return [];
  }
  return centralSiteRows({
    devices: pull?.devices ?? [],
    clients: pull?.clients ?? null,
    alerts: pull?.alerts ?? null,
    siteIds: (pull?.sites ?? []).map((s) => s.id),
  }) as unknown as Array<Record<string, unknown>>;
}

/**
 * The Central plane's own status block for the screen header, straight off
 * the registry — the health word, the last-sync stamp (null when the plane
 * never completed a pull) and the pull note are the plane's own, never
 * recomputed here. The demo branch reads the authored SYSTEMS row instead
 * (shared/central.ts demoCentralPlaneStatus), so the two modes cannot tell
 * two stories about the same estate.
 */
function liveCentralPlaneStatus(): CentralPlaneStatus {
  const state = registry.state('central');
  return {
    linked: state.linked,
    health: state.health,
    tone: SYSTEM_HEALTH_TONE[state.health],
    lastSync: state.lastSync,
    note: state.note,
  };
}

/**
 * The live payload, composed from the Central plane's OWN contribution —
 * pull.devices / clients / alerts / sites / config.ssids. The reconciled
 * merge is deliberately NOT read here: the firmware section's verdict
 * (firmwareApproved / firmwareTarget) lives on Central's own rows, and a
 * reconciled row claimed by two planes could be wearing another plane's
 * fields. A dataset the pull did not carry is named in `notReported` — an
 * absent key is a failed or unsupported read, never an implied empty estate.
 *
 * The alert section is the ACTIVE queue (silences applied, received webhook
 * deliveries prepended — real inbound data in every mode) cut to this plane
 * and severity-sorted, so a firing benched on the Alerts screen cannot
 * headline here.
 */
function liveCentralSections(): ReturnType<typeof centralSections> & { notReported: CentralDataset[] } {
  const pull = poller.contributionsByPlane().get('central');
  const notReported: CentralDataset[] = [];
  if (pull?.devices === undefined) notReported.push('devices');
  if (pull?.sites === undefined) notReported.push('sites');
  if (pull?.clients === undefined) notReported.push('clients');
  if (pull?.alerts === undefined) notReported.push('alerts');
  if (pull?.config?.ssids === undefined) notReported.push('wlans');
  const alerts =
    pull?.alerts === undefined
      ? null
      : sortLiveAlerts(
          alertQueueView(withWebhookAlerts(pull.alerts)).alerts.filter((a) => a.plane === 'CENTRAL'),
        );
  const sections = centralSections({
    plane: liveCentralPlaneStatus(),
    devices: pull?.devices ?? [],
    clients: pull?.clients ?? null,
    alerts,
    wlans: pull?.config?.ssids ?? null,
    siteIds: (pull?.sites ?? []).map((s) => s.id),
  });
  // Tiles over an unread dataset say so rather than painting a zero the
  // plane never claimed — the stats derive from rows, and rows the pull did
  // not carry are not a fleet of none.
  const stats = sections.stats.map((tile) => {
    if (tile.label === 'Devices' && notReported.includes('devices')) {
      return { ...tile, value: '—', delta: 'no device inventory reported', tone: 'neutral' as const };
    }
    if (tile.label === 'Sites' && notReported.includes('sites')) {
      return { ...tile, delta: 'sites of the reported rows only' };
    }
    return tile;
  });
  return { ...sections, stats, notReported };
}

/**
 * GET /api/central body — plane status, fleet rollup, per-site summary,
 * firmware-behind-train rows, WLAN inventory and recent alert queue.
 * Every section is a projection of reads the poller ALREADY made.
 */
export function centralBody(): Record<string, unknown> {
  if (dataSource() === 'demo') {
    if (blending() && poller.contributionsByPlane().get('central')?.devices !== undefined) {
      const { notReported, ...sections } = liveCentralSections();
      return {
        dataSource: 'demo',
        syncedAt: registry.state('central').lastSync,
        blended: ['central'],
        ...sections,
        notReported,
      };
    }
    // Received Central webhook alerts are real inbound data in demo mode too,
    // and the active-queue partition keeps a silenced firing off this screen
    // exactly like the Alerts screen — the stats count the same queue.
    const alerts = sortLiveAlerts(
      alertQueueView(withWebhookAlerts(ALERTS.filter((a) => a.plane === 'CENTRAL'))).alerts.filter(
        (a) => a.plane === 'CENTRAL',
      ),
    );
    return {
      dataSource: 'demo',
      syncedAt: new Date().toISOString(),
      ...demoCentralSections(alerts),
    };
  }
  return {
    dataSource: 'live',
    syncedAt: registry.state('central').lastSync,
    ...liveCentralSections(),
  };
}

export function registerCentralRoutes(router: Router): void {
  /**
   * GET /api/central/export — CSV of Central dashboard slices. Must stay ahead
   * of GET /central and any /central/:param. No secrets / raw vendor bodies.
   *
   * `?part=` (CENTRAL_EXPORT_PARTS):
   *   omit / all  → combined device + site rows (section column)
   *   device|site → one block of that combined layout
   *   firmware    → behind-train rows only (dedicated columns)
   *   wlans       → WLAN inventory (dedicated columns; never PSKs)
   *   alerts      → recent Central alert queue (summary columns)
   */
  router.get('/central/export', (req, res) => {
    const part = parseCentralExportPart(req.query.part);
    if (part === null) {
      res.status(400).json({
        error: "part must be 'device', 'site', 'firmware', 'wlans', 'alerts', or omitted",
        code: 'CENTRAL_EXPORT_PART',
      });
      return;
    }

    if (part === 'firmware' || part === 'wlans' || part === 'alerts') {
      const body = centralBody() as {
        firmware?: CentralFirmwareRow[];
        wlans?: SsidObject[];
        alerts?: AlertRow[];
      };
      if (part === 'firmware') {
        const rows = Array.isArray(body.firmware) ? body.firmware : [];
        sendCsv(
          res,
          'central-firmware.csv',
          [...FIRMWARE_HEADER],
          rows.map((f) => [
            f.name,
            f.model,
            f.type,
            f.siteName,
            f.serial ?? '',
            f.firmware,
            f.target ?? '',
            f.update ?? '',
          ]),
        );
        return;
      }
      if (part === 'wlans') {
        const rows = Array.isArray(body.wlans) ? body.wlans : [];
        sendCsv(
          res,
          'central-wlans.csv',
          [...WLAN_HEADER],
          rows.map((w) => [
            w.name,
            w.vlan,
            w.security,
            w.targets,
            w.plane,
            w.enabled === undefined ? '' : w.enabled ? 'yes' : 'no',
          ]),
        );
        return;
      }
      const rows = Array.isArray(body.alerts) ? body.alerts : [];
      sendCsv(
        res,
        'central-alerts.csv',
        [...ALERT_HEADER],
        rows.map((a) => [
          a.sev,
          a.title,
          a.siteName,
          a.plane,
          a.age,
          a.device ?? '',
          a.state ?? '',
        ]),
      );
      return;
    }

    const devices = part === 'site' ? [] : centralClaimedFromInventory();
    const sites = part === 'device' ? [] : centralSiteSummaryRows();
    sendCsv(
      res,
      part === 'device' ? 'central-devices.csv' : part === 'site' ? 'central-sites.csv' : 'central-export.csv',
      [
        'section',
        ...DEVICE_HEADER,
        'siteId',
        'siteName',
        'devices',
        'clients',
        'healthPct',
        'openAlerts',
      ],
      [
        ...devices.map((d) => [
          'device',
          d.name,
          d.type,
          d.model,
          d.siteName ?? d.site,
          d.state,
          d.firmware,
          d.serial ?? '',
          '',
          '',
          '',
          '',
          '',
          '',
        ]),
        ...sites.map((s) => [
          'site',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          s.siteId,
          s.siteName,
          s.devices,
          s.clients ?? '',
          s.healthPct ?? '',
          s.openAlerts ?? '',
        ]),
      ],
    );
  });

  /**
   * GET /api/central — one payload for the plane's operational dashboard:
   * plane status, fleet rollup, per-site summary, firmware-behind-train rows,
   * the WLAN inventory and the recent alert queue. DPI application visibility
   * and hardware trends stay on-demand behind /api/sites/:siteId/applications
   * and /api/devices/:name/trends/* — paged, budget-gated reads are not
   * poll-cheap. Webhook and scope MANAGEMENT stay in Connected systems.
   */
  router.get('/central', (_req, res) => {
    res.json(centralBody());
  });
}
