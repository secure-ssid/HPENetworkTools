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
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { Alert, Button, EmptyState, Input, SectionHeader, Skeleton, useToast } from '../nightdesk';

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
  const { toast } = useToast();
  const [references, setReferences] = useState<VisualReference[] | null>(initialReferences ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * The composer is a five-field form. Left permanently open it cost ~250px on
   * every editable screen for an action taken rarely, so it starts collapsed.
   */
  const [composerOpen, setComposerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<VisualKind>('floorplan');
  const [attribution, setAttribution] = useState('');

  const downloadServerCsv = () => {
    void (async () => {
      const qs = new URLSearchParams();
      qs.set('kind', target.kind);
      qs.set('id', target.id);
      if (target.plane) qs.set('plane', String(target.plane));
      const res = await downloadApiCsv(
        `/api/visual-references/export?${qs.toString()}`,
        'visual-references.csv',
      );
      if (!res.ok) {
        toast('Server export failed', { description: res.error, tone: 'danger' });
        return;
      }
      toast('Downloaded server CSV', {
        description: 'visual-references.csv — metadata only (no binary assets).',
        tone: 'success',
      });
    })();
  };

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
      setComposerOpen(false);
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
      setComposerOpen(false);
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

  /*
   * A read-only panel with nothing in it has nothing to say: the empty state
   * asks the operator to attach a floorplan, but `editable={false}` gives them
   * no control to do it, and the CSV button downloads an empty file. It was
   * repeating on ten screens. Errors and the loading state still render —
   * "references failed to load" is not the same claim as "there are none".
   */
  if (!editable && !error && references !== null && references.length === 0) return null;

  return (
    <div className="nt-visual-ref nt-recon-reveal nt-visual-ref-shell nt-section-panel">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">HPE Network Tools · visual lane · operator sketches · never telemetry</div>
      <div className="nt-row-between-12">
        <SectionHeader
          label="Visual references"
          meta="OPERATOR CONTEXT · NOT TELEMETRY"
        />
        <Button variant="secondary" size="sm" onClick={downloadServerCsv}>
          Download references CSV
        </Button>
        {editable ? (
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={composerOpen}
            onClick={() => setComposerOpen((v) => !v)}
          >
            {composerOpen ? 'Cancel' : 'Add visual reference'}
          </Button>
        ) : null}
      </div>

      {error ? (
        <Alert tone="warning" title="Visual references unavailable">
          <span className="nt-fs-13">{error}</span>
        </Alert>
      ) : null}

      {references === null ? (
        <div className="nt-visual-ref__loading nt-debug-wake" aria-busy="true" aria-live="polite">
          <span className="nt-chat-pending__pulse" aria-hidden />
          <div className="nt-stack nt-gap-8 nt-flex-1">
            <Skeleton height={14} width="38%" />
            <Skeleton height={64} />
            <Skeleton height={64} />
          </div>
          <span className="nt-hint-muted nt-chat-pending__label">HPE Network Tools · visual lane…</span>
        </div>
      ) : references.length === 0 ? (
        <EmptyState
          title="No visual references"
          description="Attach a floorplan, port map, document, or native console link. These never replace live topology or telemetry."
        >
          {editable && !composerOpen ? (
            <Button variant="secondary" size="sm" onClick={() => setComposerOpen(true)}>
              Add visual reference
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <ul className="nt-visual-ref__list">
          {references.map((ref) => (
            <li key={ref.id} className="nt-visual-ref__card nt-card-lift nt-panel-glass">
              <div className="nt-visual-ref__card-head">
                <strong className="nt-visual-ref__title">{ref.title}</strong>
                <span className="nt-visual-ref__meta">
                  {ref.kind} · {ref.source}
                </span>
              </div>
              {ref.unavailable ? (
                <Alert tone="danger" title="Asset unavailable">
                  <span className="nt-fs-12">The stored file is missing; re-upload or remove this reference.</span>
                </Alert>
              ) : ref.assetId && ref.mimeType?.startsWith('image/') ? (
                <img
                  src={visualAssetUrl(ref.assetId)}
                  alt={ref.title}
                  className="nt-visual-ref__img"
                />
              ) : ref.url ? (
                <a href={ref.url} target="_blank" rel="noreferrer" className="nt-visual-ref__link">
                  {ref.source === 'native' ? 'Open native console' : ref.url}
                </a>
              ) : ref.assetId ? (
                <a href={visualAssetUrl(ref.assetId)} target="_blank" rel="noreferrer" className="nt-visual-ref__link">
                  Open document
                </a>
              ) : null}
              <div className="nt-visual-ref__owner">
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

      {editable && composerOpen ? (
        <div className="nt-visual-ref__composer">
          <div className="nt-visual-ref__composer-label">Add visual reference</div>
          <Input size="sm" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select
            aria-label="Reference kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as VisualKind)}
            className="nt-visual-ref__select"
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
          <div className="nt-visual-ref__actions">
            <Button variant="secondary" size="sm" disabled={busy || !title.trim() || !url.trim()} onClick={() => void addLink()}>
              Add link
            </Button>
            <label className="nt-visual-ref__upload">
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
