/** Typed browser client for operator visual references. */

import type { VisualReference, VisualReferenceDraft, VisualTarget } from '@hpe/shared';
import { apiFetch } from './core';

export async function listVisualReferences(target?: VisualTarget): Promise<VisualReference[]> {
  const params = new URLSearchParams();
  if (target) {
    params.set('kind', target.kind);
    params.set('id', target.id);
    if (target.plane) params.set('plane', String(target.plane));
  }
  const qs = params.toString();
  const res = await apiFetch(`/api/visual-references${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(await res.text());
  const body = (await res.json()) as { references?: VisualReference[] };
  return Array.isArray(body.references) ? body.references : [];
}

export async function createVisualReference(draft: VisualReferenceDraft): Promise<VisualReference> {
  const res = await apiFetch('/api/visual-references', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { reference: VisualReference };
  return body.reference;
}

export async function deleteVisualReference(id: string): Promise<void> {
  const res = await apiFetch(`/api/visual-references/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
}

export async function uploadVisualReference(opts: {
  target: VisualTarget;
  kind: VisualReferenceDraft['kind'];
  title: string;
  attribution?: string;
  file: File;
}): Promise<VisualReference> {
  const headers: Record<string, string> = {
    'content-type': opts.file.type || 'application/octet-stream',
    'x-visual-target-kind': opts.target.kind,
    'x-visual-target-id': opts.target.id,
    'x-visual-kind': opts.kind,
    'x-visual-title': opts.title,
  };
  if (opts.target.plane) headers['x-visual-target-plane'] = String(opts.target.plane);
  if (opts.attribution) headers['x-visual-attribution'] = opts.attribution;
  const res = await apiFetch('/api/visual-assets', {
    method: 'POST',
    headers,
    body: opts.file,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { reference: VisualReference };
  return body.reference;
}

export function visualAssetUrl(assetId: string): string {
  return `/api/visual-assets/${encodeURIComponent(assetId)}`;
}
