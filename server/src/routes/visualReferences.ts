/**
 * server/src/routes/visualReferences.ts — visual reference CRUD + asset stream.
 *
 *   GET    /api/visual-references?kind=&id=&plane=   list (optionally filtered)
 *   POST   /api/visual-references                    create url/native/product
 *   DELETE /api/visual-references/:id                remove one
 *   POST   /api/visual-assets                        binary upload (headers carry draft)
 *   GET    /api/visual-assets/:assetId               stream stored bytes
 */

import { Router, type Request, type Response } from 'express';
import {
  VISUAL_ASSET_MAX_BYTES,
  parseVisualReferenceDraft,
  type VisualReferenceDraft,
  type VisualTargetKind,
} from '@hpe/shared';
import { h } from './handler';
import { VisualReferenceError, visualReferences } from '../services/visualReferences';

export const visualReferencesRouter = Router();

function sendError(res: Response, err: unknown): boolean {
  if (err instanceof VisualReferenceError) {
    res.status(err.status).json({ error: err.message, code: 'VISUAL_REFERENCE' });
    return true;
  }
  if (err instanceof Error && /required|must be|unknown field|https/i.test(err.message)) {
    res.status(400).json({ error: err.message, code: 'VISUAL_REFERENCE_VALIDATION' });
    return true;
  }
  return false;
}

visualReferencesRouter.get(
  '/visual-references',
  h((req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    const plane = typeof req.query.plane === 'string' ? req.query.plane : undefined;
    if ((kind && !id) || (!kind && id)) {
      res.status(400).json({ error: 'kind and id must be supplied together', code: 'VISUAL_REFERENCE_VALIDATION' });
      return;
    }
    const references = visualReferences.list(
      kind && id
        ? {
            kind: kind as VisualTargetKind,
            id,
            ...(plane ? { plane } : {}),
          }
        : undefined,
    );
    res.json({ references });
  }),
);

visualReferencesRouter.post(
  '/visual-references',
  h((req, res) => {
    try {
      const reference = visualReferences.createFromDraft(req.body);
      res.status(201).json({ reference });
    } catch (err) {
      if (!sendError(res, err)) throw err;
    }
  }),
);

visualReferencesRouter.delete(
  '/visual-references/:id',
  h((req, res) => {
    try {
      const reference = visualReferences.delete(req.params.id);
      res.json({ ok: true, reference });
    } catch (err) {
      if (!sendError(res, err)) throw err;
    }
  }),
);

/**
 * Binary upload. Draft fields travel as headers so the body can stay raw:
 *   X-Visual-Target-Kind, X-Visual-Target-Id, X-Visual-Target-Plane?
 *   X-Visual-Kind, X-Visual-Title, X-Visual-Attribution?
 *   Content-Type = asset mime
 *
 * Body is Buffer when mounted behind express.raw (see createApp).
 */
visualReferencesRouter.post(
  '/visual-assets',
  h((req: Request, res: Response) => {
    try {
      const body = req.body;
      const bytes = Buffer.isBuffer(body)
        ? body
        : body instanceof Uint8Array
          ? Buffer.from(body)
          : Buffer.alloc(0);
      if (bytes.byteLength > VISUAL_ASSET_MAX_BYTES) {
        throw new VisualReferenceError(400, `upload exceeds ${VISUAL_ASSET_MAX_BYTES} bytes`);
      }
      const header = (name: string): string | undefined => {
        const raw = req.header(name);
        return raw && raw.trim() ? raw.trim() : undefined;
      };
      const draftInput = {
        target: {
          kind: header('x-visual-target-kind'),
          id: header('x-visual-target-id'),
          ...(header('x-visual-target-plane') ? { plane: header('x-visual-target-plane') } : {}),
        },
        kind: header('x-visual-kind'),
        title: header('x-visual-title'),
        source: 'upload' as const,
        ...(header('x-visual-attribution') ? { attribution: header('x-visual-attribution') } : {}),
      };
      const draft = parseVisualReferenceDraft(draftInput) as VisualReferenceDraft;
      const mimeType = (req.header('content-type') ?? '').split(';')[0]!.trim();
      const reference = visualReferences.createUpload({ draft, bytes, mimeType });
      res.status(201).json({ reference });
    } catch (err) {
      if (!sendError(res, err)) throw err;
    }
  }),
);

visualReferencesRouter.get(
  '/visual-assets/:assetId',
  h((req, res) => {
    try {
      const { mimeType, stream, reference } = visualReferences.openAsset(req.params.assetId);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${reference.id}"`);
      res.setHeader('Cache-Control', 'private, no-cache');
      stream.on('error', () => {
        if (!res.headersSent) res.status(404).json({ error: 'asset unavailable', code: 'VISUAL_ASSET_MISSING' });
        else res.destroy();
      });
      stream.pipe(res);
    } catch (err) {
      if (!sendError(res, err)) throw err;
    }
  }),
);
