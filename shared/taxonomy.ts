/**
 * shared/taxonomy.ts — device/client category labels and pure classifiers.
 *
 * These never invent inventory. They only label fields the planes already
 * publish (type, model, endpoint category/family/os) so list/detail UIs share
 * one vocabulary for filters and badges.
 */

import type { ClientType, DeviceType, EndpointRow, Tone } from './types';

export const DEVICE_TYPES: readonly DeviceType[] = [
  'switch',
  'ap',
  'gateway',
  'controller',
  'sensor',
  'policy',
] as const;

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  switch: 'Switch',
  ap: 'Access point',
  gateway: 'Gateway',
  controller: 'Controller',
  sensor: 'Sensor',
  policy: 'Policy',
};

export const DEVICE_TYPE_TONES: Record<DeviceType, Tone> = {
  switch: 'info',
  ap: 'accent',
  gateway: 'warning',
  controller: 'neutral',
  sensor: 'success',
  policy: 'neutral',
};

export const CLIENT_TYPE_LABELS: Record<ClientType, string> = {
  laptop: 'Laptop',
  phone: 'Phone',
  tablet: 'Tablet',
  medical: 'Medical',
  imaging: 'Imaging',
  voip: 'VoIP',
  printer: 'Printer',
  media: 'Media',
  kiosk: 'Kiosk',
  building: 'Building',
  unknown: 'Unknown',
};

export const CLIENT_TYPE_TONES: Record<ClientType, Tone> = {
  laptop: 'info',
  phone: 'accent',
  tablet: 'accent',
  medical: 'danger',
  imaging: 'warning',
  voip: 'info',
  printer: 'neutral',
  media: 'neutral',
  kiosk: 'warning',
  building: 'neutral',
  unknown: 'neutral',
};

export type CategoryConfidence = 'profiled' | 'observed' | 'inferred' | 'unknown';

export interface DeviceTaxonomy {
  type: DeviceType;
  typeLabel: string;
  typeTone: Tone;
  /** Coarse family inferred from model string only — never a plane claim. */
  family: string | null;
  /** Soft role hint from name/type (core/access/edge) — display only. */
  roleHint: string | null;
}

export interface ClientTaxonomy {
  type: ClientType;
  typeLabel: string;
  typeTone: Tone;
  /** Best operator-facing category label. */
  effectiveCategory: string;
  categoryConfidence: CategoryConfidence;
  osFamily: string | null;
  profiledCategory: string | null;
  insightTags: string[];
}

export interface CategoryBucket {
  key: string;
  label: string;
  count: number;
  tone?: Tone;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t && t !== '—' && t.toLowerCase() !== 'unknown' ? t : null;
}

/** Infer a product family label from a model string (CX, AP, EX, AOS, …). */
export function inferDeviceFamily(model: string | null | undefined): string | null {
  const m = nonEmpty(model);
  if (!m) return null;
  const upper = m.toUpperCase();
  if (/\bCX\b/.test(upper) || upper.includes('6300') || upper.includes('8325') || upper.includes('6200') || upper.includes('6400')) {
    return 'AOS-CX';
  }
  if (upper.includes('EX4') || upper.includes('EX3') || upper.startsWith('EX')) return 'Juniper EX';
  if (/\bAP[-\s]?\d/.test(upper) || upper.startsWith('AP')) return 'Access point';
  if (upper.includes('AOS-10') || upper.includes('9240') || upper.includes('9000')) return 'AOS-10';
  if (upper.includes('AOS-8') || upper.includes('7210') || upper.includes('7205') || upper.includes('MM-')) return 'AOS-8';
  if (upper.includes('SENSOR') || upper.includes('UXI')) return 'Sensor';
  return null;
}

/** Soft role hint from naming conventions — never treated as inventory truth. */
export function inferDeviceRoleHint(input: {
  name?: string | null;
  type?: DeviceType | null;
  model?: string | null;
}): string | null {
  const name = (input.name ?? '').toLowerCase();
  const type = input.type ?? null;
  if (/core|spine|agg/.test(name)) return 'core';
  if (/acc|access|tor|leaf/.test(name)) return 'access';
  if (/edge|gw-|gateway|wan/.test(name)) return 'edge';
  if (/dist|distribution/.test(name)) return 'distribution';
  if (type === 'ap') return 'wireless edge';
  if (type === 'gateway') return 'edge';
  if (type === 'controller') return 'control plane';
  if (type === 'sensor') return 'experience sensor';
  if (type === 'switch') return 'switching';
  return null;
}

export function classifyDevice(input: {
  type: DeviceType;
  name?: string | null;
  model?: string | null;
}): DeviceTaxonomy {
  const type = input.type;
  return {
    type,
    typeLabel: DEVICE_TYPE_LABELS[type] ?? type,
    typeTone: DEVICE_TYPE_TONES[type] ?? 'neutral',
    family: inferDeviceFamily(input.model),
    roleHint: inferDeviceRoleHint(input),
  };
}

export function classifyClient(
  input: {
    type: ClientType;
    model?: string | null;
    os?: string | null;
  },
  endpoint?: Pick<EndpointRow, 'category' | 'family' | 'os' | 'insightTags'> | null,
): ClientTaxonomy {
  const type = input.type ?? 'unknown';
  const profiledCategory = nonEmpty(endpoint?.category ?? null);
  const osFamily =
    nonEmpty(endpoint?.family) ??
    nonEmpty(endpoint?.os) ??
    nonEmpty(input.os) ??
    null;
  const insightTags = Array.isArray(endpoint?.insightTags)
    ? endpoint!.insightTags!.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];

  let effectiveCategory: string;
  let categoryConfidence: CategoryConfidence;
  if (profiledCategory) {
    effectiveCategory = profiledCategory;
    categoryConfidence = 'profiled';
  } else if (type && type !== 'unknown') {
    effectiveCategory = CLIENT_TYPE_LABELS[type] ?? type;
    categoryConfidence = 'observed';
  } else if (insightTags.length > 0) {
    effectiveCategory = insightTags[0]!;
    categoryConfidence = 'inferred';
  } else if (nonEmpty(input.model)) {
    effectiveCategory = input.model!.trim();
    categoryConfidence = 'inferred';
  } else {
    effectiveCategory = CLIENT_TYPE_LABELS.unknown;
    categoryConfidence = 'unknown';
  }

  return {
    type,
    typeLabel: CLIENT_TYPE_LABELS[type] ?? type,
    typeTone: CLIENT_TYPE_TONES[type] ?? 'neutral',
    effectiveCategory,
    categoryConfidence,
    osFamily,
    profiledCategory,
    insightTags,
  };
}

export function bucketByKey(
  items: Array<{ key: string; label: string; tone?: Tone }>,
): CategoryBucket[] {
  const map = new Map<string, CategoryBucket>();
  for (const item of items) {
    const existing = map.get(item.key);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(item.key, {
        key: item.key,
        label: item.label,
        count: 1,
        ...(item.tone ? { tone: item.tone } : {}),
      });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function deviceTypeBuckets(
  devices: Array<{ type: DeviceType }>,
): CategoryBucket[] {
  return bucketByKey(
    devices.map((d) => ({
      key: d.type,
      label: DEVICE_TYPE_LABELS[d.type] ?? d.type,
      tone: DEVICE_TYPE_TONES[d.type],
    })),
  );
}

export function clientTypeBuckets(
  clients: Array<{ type: ClientType }>,
): CategoryBucket[] {
  return bucketByKey(
    clients.map((c) => ({
      key: c.type,
      label: CLIENT_TYPE_LABELS[c.type] ?? c.type,
      tone: CLIENT_TYPE_TONES[c.type],
    })),
  );
}
