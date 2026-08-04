/**
 * shared/configRecommendations.ts — read-only config hygiene suggestions.
 *
 * Recommendations never push configuration. They surface observed gaps
 * (firmware target, reconciliation, client profiling) and optionally hand off
 * to existing Configure / ClearPass / Systems screens.
 */

import type { ClientType, DeviceType, EndpointRow, Plane, Tone } from './types';
import { classifyClient, classifyDevice } from './taxonomy';

export type RecommendationSeverity = 'info' | 'suggestion' | 'warning';
export type RecommendationCategory =
  | 'firmware'
  | 'configuration'
  | 'redundancy'
  | 'security'
  | 'performance'
  | 'compliance'
  | 'inventory';
export type RecommendationActionType = 'configure' | 'examine' | 'contact-vendor' | 'systems';

export interface ConfigRecommendation {
  id: string;
  ruleId: string;
  severity: RecommendationSeverity;
  title: string;
  detail: string;
  category: RecommendationCategory;
  actionType: RecommendationActionType;
  /** Optional handoff into an existing portal path (never a second write backend). */
  handoffPath?: string;
  tone?: Tone;
  device?: string;
  site?: string;
  clientMac?: string;
  plane?: Plane | string;
  evidence: 'observed' | 'computed' | 'partial';
  evidenceNote?: string;
  impactCount?: number;
}

export interface RecommendationQuery {
  device?: string;
  site?: string;
  clientMac?: string;
  category?: RecommendationCategory;
  severity?: RecommendationSeverity;
  limit?: number;
}

export interface DeviceRecommendationInput {
  name: string;
  type: DeviceType;
  model?: string;
  site?: string;
  siteName?: string;
  siteId?: string;
  plane: Plane | string;
  state?: string;
  firmware?: string;
  firmwareTarget?: string;
  firmwareApproved?: boolean;
  firmwareUpdate?: string;
  reconciliationIssue?: boolean;
  licence?: string;
  localShell?: boolean;
}

export interface ClientRecommendationInput {
  name: string;
  mac: string;
  type: ClientType;
  model?: string;
  site?: string;
  siteName?: string;
  siteId?: string;
  plane: Plane | string;
  ip?: string | 'pending';
  problem?: boolean;
  health?: string;
  auth?: string;
  role?: string;
  os?: string;
}

const SEVERITY_RANK: Record<RecommendationSeverity, number> = {
  warning: 0,
  suggestion: 1,
  info: 2,
};

function siteOf(d: DeviceRecommendationInput | ClientRecommendationInput): string | undefined {
  return d.siteName ?? d.site ?? d.siteId;
}

function stateWord(state: string | undefined): string {
  return (state ?? '').trim().toLowerCase();
}

/** Pure device rules — only fire on fields the caller already observed. */
export function recommendationsForDevice(device: DeviceRecommendationInput): ConfigRecommendation[] {
  const out: ConfigRecommendation[] = [];
  const site = siteOf(device);
  const tax = classifyDevice({ type: device.type, name: device.name, model: device.model });
  const st = stateWord(device.state);

  if (device.reconciliationIssue) {
    out.push({
      id: `rec-recon-${device.name}`,
      ruleId: 'inventory.reconciliation',
      severity: 'warning',
      title: 'Resolve multi-plane claim',
      detail: `${device.name} is flagged for reconciliation (double-claimed or missing a cloud plane). Fix ownership before configuration changes so the wrong plane is not edited.`,
      category: 'inventory',
      actionType: 'systems',
      handoffPath: '/systems',
      tone: 'danger',
      device: device.name,
      site,
      plane: device.plane,
      evidence: 'observed',
      impactCount: 1,
    });
  }

  if (st.includes('double-claim')) {
    out.push({
      id: `rec-double-${device.name}`,
      ruleId: 'inventory.double-claim',
      severity: 'warning',
      title: 'Double-claimed device',
      detail: `${device.name} reports state "${device.state}". Pick a single managing plane and clear the stale claim before pushing config.`,
      category: 'inventory',
      actionType: 'systems',
      handoffPath: '/systems',
      tone: 'danger',
      device: device.name,
      site,
      plane: device.plane,
      evidence: 'observed',
    });
  }

  if (st.includes('no heartbeat') || st === 'down' || st.includes('unreachable')) {
    out.push({
      id: `rec-down-${device.name}`,
      ruleId: 'availability.down',
      severity: 'warning',
      title: 'Device not answering',
      detail: `${device.name} is "${device.state}". Configuration pushes are unsafe until reachability is restored — start with diagnostics and the managing plane console.`,
      category: 'performance',
      actionType: 'examine',
      handoffPath: `/devices/${encodeURIComponent(device.name)}`,
      tone: 'danger',
      device: device.name,
      site,
      plane: device.plane,
      evidence: 'observed',
    });
  } else if (st.includes('degraded') || st.includes('flapping')) {
    out.push({
      id: `rec-degraded-${device.name}`,
      ruleId: 'availability.degraded',
      severity: 'suggestion',
      title: 'Stabilize before config change',
      detail: `${device.name} is "${device.state}". Prefer read-only checks and staged changes; avoid bulk pushes while the device is unstable.`,
      category: 'performance',
      actionType: 'examine',
      handoffPath: `/devices/${encodeURIComponent(device.name)}`,
      tone: 'warning',
      device: device.name,
      site,
      plane: device.plane,
      evidence: 'observed',
    });
  }

  if (
    device.firmwareTarget &&
    device.firmware &&
    device.firmware !== device.firmwareTarget &&
    device.firmwareApproved === false
  ) {
    out.push({
      id: `rec-fw-${device.name}`,
      ruleId: 'firmware.target-gap',
      severity: 'warning',
      title: `Firmware target ${device.firmwareTarget}`,
      detail: `${device.name} runs ${device.firmware}; the plane recommends ${device.firmwareTarget}. Review release notes in the vendor console before upgrading — this portal does not push firmware.`,
      category: 'firmware',
      actionType: 'examine',
      handoffPath: `/devices/${encodeURIComponent(device.name)}`,
      tone: 'warning',
      device: device.name,
      site,
      plane: device.plane,
      evidence: 'observed',
      ...(device.firmwareUpdate ? { evidenceNote: `Plane upgrade state: ${device.firmwareUpdate}` } : {}),
    });
  } else if (device.firmwareApproved === false && device.firmware && !device.firmwareTarget) {
    out.push({
      id: `rec-fw-unapproved-${device.name}`,
      ruleId: 'firmware.unapproved-train',
      severity: 'suggestion',
      title: 'Firmware train not approved',
      detail: `${device.name} is on ${device.firmware} without an approved train flag. Confirm the train with the site standard before broad rollout.`,
      category: 'firmware',
      actionType: 'examine',
      handoffPath: `/devices/${encodeURIComponent(device.name)}`,
      tone: 'warning',
      device: device.name,
      site,
      plane: device.plane,
      evidence: 'observed',
    });
  }

  if (device.type === 'switch' && tax.roleHint === 'core' && device.localShell === false) {
    out.push({
      id: `rec-core-shell-${device.name}`,
      ruleId: 'configuration.core-access',
      severity: 'info',
      title: 'Core switch is cloud-mediated',
      detail: `${device.name} looks like a core switch but has no local shell in this portal. Use the managing plane for changes; keep a break-glass path documented outside the portal.`,
      category: 'configuration',
      actionType: 'examine',
      handoffPath: '/configure',
      tone: 'info',
      device: device.name,
      site,
      plane: device.plane,
      evidence: 'computed',
    });
  }

  if (String(device.plane).toUpperCase() === 'LOCAL' && device.type === 'switch') {
    out.push({
      id: `rec-local-backup-${device.name}`,
      ruleId: 'configuration.local-backup',
      severity: 'info',
      title: 'Confirm config backup coverage',
      detail: `${device.name} is local-managed. Prefer recorded terminal + config backups over ad-hoc edits so changes stay auditable.`,
      category: 'compliance',
      actionType: 'examine',
      handoffPath: '/compliance',
      tone: 'info',
      device: device.name,
      site,
      plane: device.plane,
      evidence: 'computed',
    });
  }

  return out;
}

export function recommendationsForClient(
  client: ClientRecommendationInput,
  endpoint?: Pick<EndpointRow, 'category' | 'family' | 'os' | 'insightTags' | 'status' | 'profile'> | null,
): ConfigRecommendation[] {
  const out: ConfigRecommendation[] = [];
  const site = siteOf(client);
  const tax = classifyClient(
    { type: client.type, model: client.model, os: client.os },
    endpoint ?? null,
  );
  const macQ = encodeURIComponent(client.mac);

  if (client.problem) {
    out.push({
      id: `rec-client-problem-${client.mac}`,
      ruleId: 'client.problem',
      severity: 'warning',
      title: 'Client marked with a problem',
      detail: `${client.name} (${client.mac}) carries a problem flag. Review RF/auth path and recent auth events before changing role or VLAN assignments.`,
      category: 'performance',
      actionType: 'examine',
      handoffPath: `/clients?mac=${macQ}`,
      tone: 'warning',
      clientMac: client.mac,
      device: client.name,
      site,
      plane: client.plane,
      evidence: 'observed',
    });
  }

  if (client.ip === 'pending' || !client.ip) {
    out.push({
      id: `rec-client-ip-${client.mac}`,
      ruleId: 'client.pending-ip',
      severity: 'suggestion',
      title: 'Address still pending',
      detail: `${client.name} has no completed IP assignment yet. Check DHCP scope capacity and auth posture before enforcing a tighter role.`,
      category: 'performance',
      actionType: 'examine',
      handoffPath: `/clients?mac=${macQ}`,
      tone: 'warning',
      clientMac: client.mac,
      site,
      plane: client.plane,
      evidence: 'observed',
    });
  }

  if (tax.categoryConfidence === 'unknown' || client.type === 'unknown') {
    out.push({
      id: `rec-client-cat-${client.mac}`,
      ruleId: 'client.uncategorized',
      severity: 'info',
      title: 'Categorize this endpoint',
      detail: `${client.name} has no strong category. ${
        endpoint
          ? 'ClearPass has seen the MAC but Device Insight has not classified it yet.'
          : 'No ClearPass endpoint category is attached in this view.'
      } Profiling improves policy targeting; it is not applied automatically here.`,
      category: 'compliance',
      actionType: 'examine',
      handoffPath: '/clearpass',
      tone: 'info',
      clientMac: client.mac,
      site,
      plane: client.plane,
      evidence: endpoint ? 'observed' : 'partial',
      ...(endpoint ? {} : { evidenceNote: 'Endpoint repository row not supplied to this evaluation' }),
    });
  } else if (tax.categoryConfidence === 'profiled' && !endpoint?.profile) {
    out.push({
      id: `rec-client-profile-${client.mac}`,
      ruleId: 'client.missing-enforcement-profile',
      severity: 'suggestion',
      title: 'Profiled but no enforcement profile',
      detail: `${client.name} is categorized as ${tax.effectiveCategory} without an enforcement profile on the endpoint row. Confirm the intended ClearPass role mapping.`,
      category: 'security',
      actionType: 'examine',
      handoffPath: '/clearpass',
      tone: 'warning',
      clientMac: client.mac,
      site,
      plane: client.plane,
      evidence: 'observed',
    });
  }

  if ((client.auth ?? '').toLowerCase().includes('fail') || (client.health ?? '').toLowerCase().includes('poor')) {
    out.push({
      id: `rec-client-auth-${client.mac}`,
      ruleId: 'client.auth-health',
      severity: 'suggestion',
      title: 'Review auth / experience',
      detail: `${client.name}: auth="${client.auth ?? '—'}", health="${client.health ?? '—'}". Prefer Auth events and the attach device diagnostics before role changes.`,
      category: 'security',
      actionType: 'examine',
      handoffPath: `/clients?mac=${macQ}`,
      tone: 'warning',
      clientMac: client.mac,
      site,
      plane: client.plane,
      evidence: 'observed',
    });
  }

  return out;
}

export function recommendationsForDevices(devices: DeviceRecommendationInput[]): ConfigRecommendation[] {
  return devices.flatMap(recommendationsForDevice);
}

export function recommendationsForClients(
  clients: ClientRecommendationInput[],
  endpointByMac?: Map<string, EndpointRow | Pick<EndpointRow, 'category' | 'family' | 'os' | 'insightTags' | 'status' | 'profile'>>,
): ConfigRecommendation[] {
  return clients.flatMap((c) =>
    recommendationsForClient(c, endpointByMac?.get(c.mac.toLowerCase()) ?? endpointByMac?.get(c.mac) ?? null),
  );
}

export function sortRecommendations(list: ConfigRecommendation[]): ConfigRecommendation[] {
  return [...list].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    return a.title.localeCompare(b.title);
  });
}

export function filterRecommendations(
  list: ConfigRecommendation[],
  query: RecommendationQuery = {},
): ConfigRecommendation[] {
  let out = list;
  if (query.device) {
    const d = query.device.toLowerCase();
    out = out.filter((r) => (r.device ?? '').toLowerCase() === d);
  }
  if (query.site) {
    const s = query.site.toLowerCase();
    out = out.filter((r) => (r.site ?? '').toLowerCase().includes(s));
  }
  if (query.clientMac) {
    const m = query.clientMac.toLowerCase();
    out = out.filter((r) => (r.clientMac ?? '').toLowerCase() === m);
  }
  if (query.category) out = out.filter((r) => r.category === query.category);
  if (query.severity) out = out.filter((r) => r.severity === query.severity);
  out = sortRecommendations(out);
  if (query.limit && query.limit > 0) out = out.slice(0, query.limit);
  return out;
}

export function recommendationCounts(list: ConfigRecommendation[]): {
  total: number;
  bySeverity: Record<RecommendationSeverity, number>;
  byCategory: Partial<Record<RecommendationCategory, number>>;
} {
  const bySeverity: Record<RecommendationSeverity, number> = {
    info: 0,
    suggestion: 0,
    warning: 0,
  };
  const byCategory: Partial<Record<RecommendationCategory, number>> = {};
  for (const r of list) {
    bySeverity[r.severity] += 1;
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  }
  return { total: list.length, bySeverity, byCategory };
}
