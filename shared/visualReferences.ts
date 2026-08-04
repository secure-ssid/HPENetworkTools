/**
 * shared/visualReferences.ts — operator-supplied visual context and
 * capability-gated configuration action contracts.
 *
 * Visual references are NOT telemetry. They are floorplans, port maps, docs,
 * and native-console links an operator attaches to a site/device/client/etc.
 * Configuration action capabilities declare which products expose a real
 * preview → review → push path so detail screens never invent write buttons.
 */

import type { Plane, Tone } from './types';

export const VISUAL_TARGET_KINDS = [
  'site',
  'device',
  'client',
  'alert',
  'ssid',
  'connector',
  'change',
  'estate',
  'endpoint',
  'service',
  'license',
] as const;
export type VisualTargetKind = (typeof VISUAL_TARGET_KINDS)[number];

export const VISUAL_KINDS = [
  'topology',
  'port-map',
  'trend',
  'floorplan',
  'map',
  'image',
  'document',
  'native-link',
] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

export const VISUAL_SOURCES = ['upload', 'url', 'native', 'product'] as const;
export type VisualSource = (typeof VISUAL_SOURCES)[number];

export const VISUAL_UPLOAD_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
] as const;
export type VisualUploadMime = (typeof VISUAL_UPLOAD_MIME_TYPES)[number];

/** Hard ceiling for uploaded assets (10 MiB). */
export const VISUAL_ASSET_MAX_BYTES = 10 * 1024 * 1024;

export interface VisualTarget {
  kind: VisualTargetKind;
  id: string;
  /** Optional owning plane when the target is plane-scoped. */
  plane?: Plane | string;
}

export interface VisualReference {
  id: string;
  target: VisualTarget;
  kind: VisualKind;
  title: string;
  source: VisualSource;
  owner: string;
  updatedAt: string;
  /** External or native URL when source is url/native/product. */
  url?: string;
  /** Stored asset id when source is upload. */
  assetId?: string;
  mimeType?: string;
  attribution?: string;
  /** True when a previously stored asset can no longer be read. */
  unavailable?: boolean;
}

export interface VisualReferenceDraft {
  target: VisualTarget;
  kind: VisualKind;
  title: string;
  source: Exclude<VisualSource, 'upload'> | 'upload';
  url?: string;
  mimeType?: string;
  attribution?: string;
}

export type ConfigActionName =
  | 'ssid-edit'
  | 'port-vlan'
  | 'clearpass-endpoint'
  | 'clearpass-local-user'
  | 'sse-object';

export interface ConfigActionCapability {
  id: string;
  plane: Plane | string;
  targetKind: VisualTargetKind | 'device' | 'ssid' | 'client' | 'connector' | 'change';
  action: ConfigActionName;
  label: string;
  /** Whether a dry-run step exists before review. */
  dryRun: boolean;
  /** Whether an explicit review/ticket gate is required before push. */
  reviewRequired: boolean;
  /** Configure (or product screen) handoff path; may include query params. */
  handoffPath: string;
  tone?: Tone;
  /** When set, the product is intentionally read-only for config pushes. */
  readOnlyReason?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('expected a string');
  return value.trim();
}

function assertOneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${field} must be one of ${allowed.join(', ')}`);
}

/** Loopback HTTP is allowed in the lab; every other external URL needs HTTPS. */
export function isSafeExternalUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function parseVisualTarget(input: unknown): VisualTarget {
  if (!isObject(input)) throw new Error('target is required');
  const kind = assertOneOf(requireString(input.kind, 'target.kind'), VISUAL_TARGET_KINDS, 'target.kind');
  const id = requireString(input.id, 'target.id');
  const plane = optionalString(input.plane);
  const unknown = Object.keys(input).filter((k) => !['kind', 'id', 'plane'].includes(k));
  if (unknown.length) throw new Error(`unknown target field: ${unknown[0]}`);
  return plane ? { kind, id, plane } : { kind, id };
}

export function parseVisualReferenceDraft(input: unknown): VisualReferenceDraft {
  if (!isObject(input)) throw new Error('draft is required');
  const allowed = ['target', 'kind', 'title', 'source', 'url', 'mimeType', 'attribution'];
  const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new Error(`unknown field: ${unknown[0]}`);

  const target = parseVisualTarget(input.target);
  const kind = assertOneOf(requireString(input.kind, 'kind'), VISUAL_KINDS, 'kind');
  const title = requireString(input.title, 'title');
  const source = assertOneOf(requireString(input.source, 'source'), VISUAL_SOURCES, 'source');
  const url = optionalString(input.url);
  const mimeType = optionalString(input.mimeType);
  const attribution = optionalString(input.attribution);

  if (source === 'url' || source === 'native' || source === 'product') {
    if (!url) throw new Error('url is required for url/native/product sources');
    if (source === 'url' && !isSafeExternalUrl(url)) {
      throw new Error('url must be https (or loopback http in the lab)');
    }
  }
  if (source === 'upload' && url) {
    throw new Error('upload drafts must not carry a url');
  }
  if (mimeType && source === 'upload') {
    assertOneOf(mimeType, VISUAL_UPLOAD_MIME_TYPES, 'mimeType');
  }

  return {
    target,
    kind,
    title,
    source,
    ...(url ? { url } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(attribution ? { attribution } : {}),
  };
}

/** Product-supported configuration actions only — no fantasy write buttons. */
export const CONFIG_ACTION_CAPABILITIES: readonly ConfigActionCapability[] = [
  {
    id: 'central-ssid-edit',
    plane: 'CENTRAL',
    targetKind: 'ssid',
    action: 'ssid-edit',
    label: 'Edit Central SSID',
    dryRun: true,
    reviewRequired: true,
    handoffPath: '/configure?edit=ssid&plane=CENTRAL',
    tone: 'accent',
  },
  {
    id: 'mist-ssid-edit',
    plane: 'MIST',
    targetKind: 'ssid',
    action: 'ssid-edit',
    label: 'Edit Mist SSID',
    dryRun: true,
    reviewRequired: true,
    handoffPath: '/configure?edit=ssid&plane=MIST',
    tone: 'accent',
  },
  {
    id: 'central-port-vlan',
    plane: 'CENTRAL',
    targetKind: 'device',
    action: 'port-vlan',
    label: 'Central port / VLAN change',
    dryRun: true,
    reviewRequired: true,
    handoffPath: '/configure',
    tone: 'accent',
  },
  {
    id: 'clearpass-endpoint',
    plane: 'CLEARPASS',
    targetKind: 'client',
    action: 'clearpass-endpoint',
    label: 'ClearPass endpoint edit',
    dryRun: false,
    reviewRequired: true,
    handoffPath: '/clearpass',
    tone: 'info',
  },
  {
    id: 'clearpass-local-user',
    plane: 'CLEARPASS',
    targetKind: 'connector',
    action: 'clearpass-local-user',
    label: 'ClearPass local user',
    dryRun: false,
    reviewRequired: true,
    handoffPath: '/clearpass',
    tone: 'info',
  },
  {
    id: 'sse-object',
    plane: 'SSE',
    targetKind: 'connector',
    action: 'sse-object',
    label: 'SSE object change',
    dryRun: false,
    reviewRequired: true,
    handoffPath: '/systems',
    tone: 'accent',
  },
  {
    id: 'opsramp-readonly',
    plane: 'OPSRAMP',
    targetKind: 'device',
    action: 'port-vlan',
    label: 'OpsRamp configuration',
    dryRun: false,
    reviewRequired: true,
    handoffPath: '/systems',
    readOnlyReason: 'OpsRamp is inventory and alerts only — the portal does not push configuration to it.',
  },
  {
    id: 'uxi-readonly',
    plane: 'UXI',
    targetKind: 'device',
    action: 'port-vlan',
    label: 'UXI configuration',
    dryRun: false,
    reviewRequired: true,
    handoffPath: '/uxi',
    readOnlyReason: 'UXI sensors are read-only in this portal.',
  },
  {
    id: 'edgeconnect-readonly',
    plane: 'EDGECONNECT',
    targetKind: 'device',
    action: 'port-vlan',
    label: 'EdgeConnect configuration',
    dryRun: false,
    reviewRequired: true,
    handoffPath: '/systems',
    readOnlyReason: 'EdgeConnect is inventory and alarms only — configuration stays in Orchestrator.',
  },
  {
    id: 'greenlake-readonly',
    plane: 'GREENLAKE',
    targetKind: 'connector',
    action: 'port-vlan',
    label: 'GreenLake configuration',
    dryRun: false,
    reviewRequired: true,
    handoffPath: '/greenlake',
    readOnlyReason: 'GreenLake subscriptions are observed here; assignment changes run in GreenLake.',
  },
  {
    id: 'aos8-readonly',
    plane: 'AOS-8',
    targetKind: 'device',
    action: 'port-vlan',
    label: 'AOS-8 configuration',
    dryRun: false,
    reviewRequired: true,
    handoffPath: '/configure',
    readOnlyReason: 'AOS-8 configuration push is not exposed as a portal write path.',
  },
  {
    id: 'local-readonly',
    plane: 'LOCAL',
    targetKind: 'device',
    action: 'port-vlan',
    label: 'Local AOS-CX configuration',
    dryRun: false,
    reviewRequired: true,
    handoffPath: '/devices',
    readOnlyReason: 'Local switches use the recorded SSH terminal and config backups, not a generic push.',
  },
] as const;

export function configCapabilitiesFor(filter: {
  plane?: string;
  targetKind?: string;
}): ConfigActionCapability[] {
  const plane = filter.plane?.toUpperCase();
  return CONFIG_ACTION_CAPABILITIES.filter((cap) => {
    if (plane && String(cap.plane).toUpperCase() !== plane) return false;
    if (filter.targetKind && cap.targetKind !== filter.targetKind) return false;
    return true;
  });
}
