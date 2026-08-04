/**
 * Operator visual references for a site/device/client target.
 * Complements live topology/ports/trends — never treated as telemetry.
 */

import { useCallback, useEffect, useState } from 'react';
import type { VisualKind, VisualReference, VisualTarget } from '@hpe/shared';
import {
  createVisualReference,
  deleteVisualReference,
  listVisualReferences,
  uploadVisualReference,
  visualAssetUrl,
} from '../api/visualReferences';
import { Alert, Button, EmptyState, Input, SectionHeader, Spinner } from '../nightdesk';

const KIND_OPTIONS: Array<{ value: VisualKind; label: string }> = [
  { value: 'floorplan', label: 'Floorplan' },
  { value: 'map', label: 'Map' },
  { value: 'image', label: 'Image' },
  { value: 'document', label: 'Document' },
  { value: 'port-map', label: 'Port map' },
  { value: 'topology', label: 'Topology sketch' },
  { value: 'native-link', label: 'Native console' },
  { value: 'trend', label: 'Trend capture' },
];

export function VisualReferencePanel({
  target,
  editable = true,
  initialReferences,
}: {
  target: VisualTarget;
  editable?: boolean;
  /** Test seam — skip the network when provided. */
  initialReferences?: VisualReference[];
}) {
  const [references, setReferences] = useState<VisualReference[] | null>(initialReferences ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<VisualKind>('floorplan');
  const [attribution, setAttribution] = useState('');

  const reload = useCallback(async () => {
    if (initialReferences) {
      setReferences(initialReferences);
      return;
    }
    try {
      setError(null);
      setReferences(await listVisualReferences(target));
    } catch (err) {
      setError((err as Error).message || 'Could not load visual references');
      setReferences([]);
    }
  }, [target, initialReferences]);

  useEffect(() => {
    if (initialReferences) return;
    let active = true;
    void listVisualReferences(target)
      .then((data) => {
        if (active) {
          setError(null);
          setReferences(data);
        }
      })
      .catch((err) => {
        if (active) {
          setError((err as Error).message || 'Could not load visual references');
          setReferences([]);
        }
      });
    return () => {
      active = false;
    };
  }, [target, initialReferences]);

  const addLink = async () => {
    if (!title.trim() || !url.trim()) return;
    setBusy(true);
    try {
      await createVisualReference({
        target,
        kind,
        title: title.trim(),
        source: kind === 'native-link' ? 'native' : 'url',
        url: url.trim(),
        ...(attribution.trim() ? { attribution: attribution.trim() } : {}),
      });
      setTitle('');
      setUrl('');
      setAttribution('');
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (file: File | null) => {
    if (!file || !title.trim()) return;
    setBusy(true);
    try {
      await uploadVisualReference({
        target,
        kind,
        title: title.trim(),
        attribution: attribution.trim() || undefined,
        file,
      });
      setTitle('');
      setAttribution('');
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await deleteVisualReference(id);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHeader
        label="Visual references"
        meta="OPERATOR CONTEXT · NOT TELEMETRY"
      />

      {error ? (
        <Alert tone="warning" title="Visual references unavailable">
          <span style={{ fontSize: 13 }}>{error}</span>
        </Alert>
      ) : null}

      {references === null ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <Spinner size="sm" />
        </div>
      ) : references.length === 0 ? (
        <EmptyState
          title="No visual references"
          description="Attach a floorplan, port map, document, or native console link. These never replace live topology or telemetry."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {references.map((ref) => (
            <li
              key={ref.id}
              style={{
                border: '1px solid var(--nd-border-default)',
                background: 'var(--nd-bg-raised)',
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <strong style={{ fontSize: 13 }}>{ref.title}</strong>
                <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 11, color: 'var(--nd-text-muted)' }}>
                  {ref.kind} · {ref.source}
                </span>
              </div>
              {ref.unavailable ? (
                <Alert tone="danger" title="Asset unavailable">
                  <span style={{ fontSize: 12 }}>The stored file is missing; re-upload or remove this reference.</span>
                </Alert>
              ) : ref.assetId && ref.mimeType?.startsWith('image/') ? (
                <img
                  src={visualAssetUrl(ref.assetId)}
                  alt={ref.title}
                  style={{ maxWidth: '100%', maxHeight: 220, objectFit: 'contain', background: 'var(--nd-bg-inset)' }}
                />
              ) : ref.url ? (
                <a href={ref.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                  {ref.source === 'native' ? 'Open native console' : ref.url}
                </a>
              ) : ref.assetId ? (
                <a href={visualAssetUrl(ref.assetId)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                  Open document
                </a>
              ) : null}
              <div style={{ fontSize: 11, color: 'var(--nd-text-muted)', fontFamily: 'var(--nd-font-mono)' }}>
                {ref.source === 'upload' ? 'Uploaded' : 'Linked'} by {ref.owner}
                {ref.attribution ? ` · ${ref.attribution}` : ''}
                {ref.updatedAt ? ` · ${new Date(ref.updatedAt).toLocaleString()}` : ''}
              </div>
              {editable ? (
                <div>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(ref.id)}>
                    Remove
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <div
          style={{
            border: '1px solid var(--nd-border-subtle)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--nd-text-muted)' }}>
            Add visual reference
          </div>
          <Input size="sm" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select
            aria-label="Reference kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as VisualKind)}
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 12,
              padding: '6px 8px',
              background: 'var(--nd-bg-inset)',
              color: 'var(--nd-text-primary)',
              border: '1px solid var(--nd-border-default)',
            }}
          >
            {KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <Input
            size="sm"
            mono
            placeholder="https://… or leave blank to upload"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Input
            size="sm"
            placeholder="Attribution (optional)"
            value={attribution}
            onChange={(e) => setAttribution(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" size="sm" disabled={busy || !title.trim() || !url.trim()} onClick={() => void addLink()}>
              Add link
            </Button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,text/markdown"
                disabled={busy || !title.trim()}
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  void onUpload(file);
                }}
              />
              Upload file
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
