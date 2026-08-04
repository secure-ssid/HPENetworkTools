/**
 * server/src/services/visualReferences.ts — owner-only visual reference store.
 *
 * Metadata: HPE_DATA_DIR/visual-references.json (mode 0600).
 * Assets:   HPE_DATA_DIR/visual-assets/<uuid> (mode 0600, dir 0700).
 *
 * Uploaded paths are never taken from the client. External URLs are validated
 * by the shared draft parser (https, or loopback http in the lab).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  VISUAL_ASSET_MAX_BYTES,
  VISUAL_UPLOAD_MIME_TYPES,
  parseVisualReferenceDraft,
  type VisualReference,
  type VisualReferenceDraft,
  type VisualTarget,
  type VisualUploadMime,
} from '@hpe/shared';
import { currentActor } from './auth';
import { appendBrokerLog, brokerDataDir } from './writeBroker';

export class VisualReferenceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'VisualReferenceError';
  }
}

interface StoreFile {
  references: VisualReference[];
}

function sameTarget(a: VisualTarget, b: VisualTarget): boolean {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    (a.plane ?? '') === (b.plane ?? '')
  );
}

export class VisualReferenceStore {
  constructor(private readonly dataDir: string = process.env.HPE_DATA_DIR ?? brokerDataDir()) {}

  private get metaFile(): string {
    return path.join(this.dataDir, 'visual-references.json');
  }

  private get assetsDir(): string {
    return path.join(this.dataDir, 'visual-assets');
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.assetsDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.dataDir, 0o700);
    } catch {
      /* best-effort on platforms that ignore mode */
    }
    try {
      fs.chmodSync(this.assetsDir, 0o700);
    } catch {
      /* best-effort */
    }
  }

  private readAll(): VisualReference[] {
    this.ensureDirs();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) as StoreFile;
      return Array.isArray(parsed.references) ? parsed.references : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private writeAll(references: VisualReference[]): void {
    this.ensureDirs();
    const tmp = `${this.metaFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ references }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.metaFile);
    try {
      fs.chmodSync(this.metaFile, 0o600);
    } catch {
      /* best-effort */
    }
  }

  list(filter?: Partial<VisualTarget>): VisualReference[] {
    const rows = this.readAll().map((row) => this.withAvailability(row));
    if (!filter?.kind || !filter.id) return rows;
    const target: VisualTarget = {
      kind: filter.kind,
      id: filter.id,
      ...(filter.plane ? { plane: filter.plane } : {}),
    };
    return rows.filter((row) => sameTarget(row.target, target));
  }

  get(id: string): VisualReference | null {
    const row = this.readAll().find((r) => r.id === id);
    return row ? this.withAvailability(row) : null;
  }

  createFromDraft(raw: unknown, owner = currentActor()): VisualReference {
    const draft = parseVisualReferenceDraft(raw);
    if (draft.source === 'upload') {
      throw new VisualReferenceError(400, 'upload references must use the binary asset route');
    }
    const row: VisualReference = {
      id: randomUUID(),
      target: draft.target,
      kind: draft.kind,
      title: draft.title,
      source: draft.source,
      owner,
      updatedAt: new Date().toISOString(),
      ...(draft.url ? { url: draft.url } : {}),
      ...(draft.mimeType ? { mimeType: draft.mimeType } : {}),
      ...(draft.attribution ? { attribution: draft.attribution } : {}),
    };
    const all = this.readAll();
    all.push(row);
    this.writeAll(all);
    this.audit('visual-reference-create', row);
    return row;
  }

  createUpload(opts: {
    draft: VisualReferenceDraft;
    bytes: Buffer;
    mimeType: string;
    owner?: string;
  }): VisualReference {
    if (opts.draft.source !== 'upload') {
      throw new VisualReferenceError(400, 'binary uploads require source=upload');
    }
    if (opts.bytes.byteLength === 0) {
      throw new VisualReferenceError(400, 'empty upload');
    }
    if (opts.bytes.byteLength > VISUAL_ASSET_MAX_BYTES) {
      throw new VisualReferenceError(400, `upload exceeds ${VISUAL_ASSET_MAX_BYTES} bytes`);
    }
    if (!(VISUAL_UPLOAD_MIME_TYPES as readonly string[]).includes(opts.mimeType)) {
      throw new VisualReferenceError(400, `unsupported mime type: ${opts.mimeType}`);
    }
    // Reject path-like titles that look like traversal attempts in the name.
    if (opts.draft.title.includes('..') || opts.draft.title.includes('/') || opts.draft.title.includes('\\')) {
      throw new VisualReferenceError(400, 'title must not contain path separators');
    }

    this.ensureDirs();
    const assetId = randomUUID();
    const assetPath = path.join(this.assetsDir, assetId);
    // Defend against any future join that could escape the assets dir.
    if (path.dirname(assetPath) !== this.assetsDir) {
      throw new VisualReferenceError(400, 'invalid asset path');
    }
    fs.writeFileSync(assetPath, opts.bytes, { mode: 0o600 });
    try {
      fs.chmodSync(assetPath, 0o600);
    } catch {
      /* best-effort */
    }

    const row: VisualReference = {
      id: randomUUID(),
      target: opts.draft.target,
      kind: opts.draft.kind,
      title: opts.draft.title,
      source: 'upload',
      owner: opts.owner ?? currentActor(),
      updatedAt: new Date().toISOString(),
      assetId,
      mimeType: opts.mimeType as VisualUploadMime,
      ...(opts.draft.attribution ? { attribution: opts.draft.attribution } : {}),
    };
    const all = this.readAll();
    all.push(row);
    this.writeAll(all);
    this.audit('visual-reference-upload', row);
    return row;
  }

  delete(id: string): VisualReference {
    const all = this.readAll();
    const idx = all.findIndex((r) => r.id === id);
    if (idx < 0) throw new VisualReferenceError(404, 'unknown visual reference');
    const [removed] = all.splice(idx, 1);
    this.writeAll(all);
    if (removed!.assetId) {
      const assetPath = path.join(this.assetsDir, removed!.assetId);
      try {
        if (path.dirname(assetPath) === this.assetsDir) fs.unlinkSync(assetPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    this.audit('visual-reference-delete', removed!);
    return removed!;
  }

  openAsset(assetId: string): { mimeType: string; stream: fs.ReadStream; reference: VisualReference } {
    if (!/^[0-9a-f-]{36}$/i.test(assetId)) {
      throw new VisualReferenceError(400, 'invalid asset id');
    }
    const reference = this.readAll().find((r) => r.assetId === assetId);
    if (!reference) throw new VisualReferenceError(404, 'unknown asset');
    const assetPath = path.join(this.assetsDir, assetId);
    if (path.dirname(assetPath) !== this.assetsDir) {
      throw new VisualReferenceError(400, 'invalid asset path');
    }
    if (!fs.existsSync(assetPath)) {
      throw new VisualReferenceError(404, 'asset unavailable');
    }
    return {
      mimeType: reference.mimeType ?? 'application/octet-stream',
      stream: fs.createReadStream(assetPath),
      reference,
    };
  }

  private withAvailability(row: VisualReference): VisualReference {
    if (row.source !== 'upload' || !row.assetId) return { ...row };
    const assetPath = path.join(this.assetsDir, row.assetId);
    if (path.dirname(assetPath) !== this.assetsDir || !fs.existsSync(assetPath)) {
      return { ...row, unavailable: true };
    }
    return { ...row, unavailable: false };
  }

  private audit(event: string, row: VisualReference): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date().toISOString(),
      event,
      changeId: row.id,
      ticket: '—',
      kind: row.kind,
      result: `${row.source} ${row.target.kind}:${row.target.id} “${row.title}”`,
      who: currentActor(),
      plane: typeof row.target.plane === 'string' ? row.target.plane : undefined,
      device: row.target.kind === 'device' ? row.target.id : undefined,
    });
  }
}

export const visualReferences = new VisualReferenceStore();
