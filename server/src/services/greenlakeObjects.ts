/**
 * server/src/services/greenlakeObjects.ts — HPE GreenLake platform writes.
 *
 * The route-facing layer over GreenLakeAdapter (server/src/planes/greenlake.ts):
 * resolves the linked adapter from the registry, enforces the review-confirmed
 * direct-write gate (ssidDirectWrite.ts's pattern — GreenLake has no ticket
 * queue), enforces the operator-declared write scope
 * (capabilities().directWrite), and records ONE audit line per action into the
 * broker's change-log.jsonl so the Configure "Change history" surface stays
 * one place for every direct write in the portal.
 *
 * WHY THIS IS SIMPLER THAN sseObjects.ts: SSE requires a tenant-wide Commit
 * after every mutation, so it needs a durable journal, an in-process mutex and
 * phase-specific recovery. GreenLake has no commit step — each endpoint either
 * applies the change or refuses it — so there is nothing that can be left
 * half-applied by this process and no journal to recover.
 *
 * WHAT IS NOT SYNCHRONOUS: the subscription endpoints answer 202 with a
 * transaction id and validate the key asynchronously. Those results are
 * reported as `accepted`, never `applied` — an operator must not read "key
 * submitted" as "subscription added". The adapter, not this service, decides
 * which outcome a given action produces.
 *
 * The inventory read is ALWAYS served from the poller's cache (the same
 * per-plane contribution ConfigInventory/assignments/sse already use) — never
 * a live call — so opening the GreenLake screen costs no extra tenant calls.
 *
 * Security: no route reaches a caller-supplied path, method or body. The
 * action is an allowlisted GREENLAKE_WRITE_ACTIONS member, and the adapter
 * assembles every request body field by field from named inputs.
 */

import {
  GREENLAKE_SECTION_KEYS,
  GREENLAKE_WRITE_ACTIONS,
  type GreenLakeInventory,
  type GreenLakeWriteAction,
  type GreenLakeWriteResult,
} from '../../../shared';
import { GreenLakeAdapter, GreenLakeWriteInputError } from '../planes/greenlake';
import { registry as defaultRegistry, type PlaneRegistry } from '../planes/registry';
import { poller as defaultPoller, type Poller } from './poller';
import { appendBrokerLog, brokerDataDir } from './writeBroker';

/** Generic message for a 5xx — an internal failure must not leak detail. */
const GREENLAKE_INTERNAL_ERROR_MESSAGE =
  'the GreenLake write could not be completed — see the server log';

export class GreenLakeObjectsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GreenLakeObjectsError';
  }
}

export function greenlakeObjectsErrorBody(err: GreenLakeObjectsError): { error: string } {
  return { error: err.status >= 500 ? GREENLAKE_INTERNAL_ERROR_MESSAGE : err.message };
}

export interface GreenLakeObjectsOptions {
  registry?: PlaneRegistry;
  pollerRef?: Poller;
  /** Test seam — an explicit adapter (or null for "not linked"). */
  plane?: GreenLakeAdapter | null;
  dataDir?: string;
  nowMs?: () => number;
}

export class GreenLakeObjectsService {
  private readonly registry: PlaneRegistry;
  private readonly pollerRef: Poller;
  private readonly planeOverride: GreenLakeAdapter | null | undefined;
  private readonly dataDir: string;
  private readonly nowMs: () => number;

  constructor(opts: GreenLakeObjectsOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.pollerRef = opts.pollerRef ?? defaultPoller;
    this.planeOverride = opts.plane;
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /** An unknown action is refused before any credential is touched. */
  static assertAction(value: string): GreenLakeWriteAction {
    if (!(GREENLAKE_WRITE_ACTIONS as readonly string[]).includes(value)) {
      throw new GreenLakeObjectsError(404, `unknown GreenLake write action '${value}'`);
    }
    return value as GreenLakeWriteAction;
  }

  /**
   * The cached platform inventory — the poller's last good pull, never a live
   * call. Before the first sync every section is reported unavailable rather
   * than as empty arrays: an operator must not read "not yet fetched" as "this
   * workspace has no users".
   */
  inventory(): GreenLakeInventory {
    const adapter = this.adapter(); // 409 before ever touching the cache
    const pull = this.pollerRef.contributionsByPlane().get('greenlake');
    return (
      pull?.greenlake ?? {
        users: [],
        locations: [],
        roleAssignments: [],
        unavailable: [...GREENLAKE_SECTION_KEYS],
        readStatus: {},
        source: `${adapter.id} linked — first sync pending`,
      }
    );
  }

  /** True when the workspace credential declares a write scope. */
  canWrite(): boolean {
    return this.adapter().capabilities().directWrite === true;
  }

  /**
   * Perform one reviewed platform write.
   *
   * Gate order matters and mirrors sseObjects: the review confirmation is
   * checked FIRST so an unconfirmed request is refused identically whether or
   * not the credential happens to hold a write scope, then the declared write
   * scope, then the action's own required inputs.
   */
  async write(
    action: GreenLakeWriteAction,
    input: Record<string, unknown>,
    reviewConfirmedRaw: unknown,
  ): Promise<GreenLakeWriteResult> {
    this.requireReview(reviewConfirmedRaw);
    const adapter = this.requireWrite();
    try {
      const result = await adapter.write(action, input);
      this.audit(action, 'greenlake-write', result.outcome, result.detail);
      return result;
    } catch (err) {
      if (err instanceof GreenLakeWriteInputError) {
        this.audit(action, 'greenlake-write', 'rejected', err.message);
        throw new GreenLakeObjectsError(400, err.message);
      }
      const status = statusOf(err);
      this.audit(action, 'greenlake-write', 'failed', `HTTP ${status ?? 'network error'}`);
      if (status !== null && status >= 400 && status < 500) {
        throw new GreenLakeObjectsError(status, describeStatus(status, action));
      }
      console.error(`greenlake write '${action}' failed: ${(err as Error).message}`);
      throw new GreenLakeObjectsError(502, `the GreenLake workspace refused the ${action} request`);
    }
  }

  // -- internals -------------------------------------------------------------

  private adapter(): GreenLakeAdapter {
    const a = this.planeOverride !== undefined ? this.planeOverride : this.registry.get('greenlake');
    if (!(a instanceof GreenLakeAdapter)) {
      throw new GreenLakeObjectsError(
        409,
        'greenlake is not linked — connect it from Connected systems first',
      );
    }
    return a;
  }

  /** The direct-write review gate — must be exactly `true` (ssidDirectWrite's
   *  own pattern), standing in for a ticket reference this plane has none of. */
  private requireReview(reviewConfirmedRaw: unknown): void {
    if (reviewConfirmedRaw !== true) {
      throw new GreenLakeObjectsError(
        400,
        'GreenLake writes require an explicit review confirmation',
      );
    }
  }

  private requireWrite(): GreenLakeAdapter {
    const adapter = this.adapter();
    if (adapter.capabilities().directWrite !== true) {
      throw new GreenLakeObjectsError(
        403,
        'this workspace credential is read-only — no write scope was declared for it',
      );
    }
    return adapter;
  }

  /** One audit line per action. Never a payload, an email body or a key. */
  private audit(action: string, event: string, result: string, detail: string): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event,
      changeId: `greenlake-${action}-${this.nowMs()}`,
      ticket: '(none — direct apply, review-confirmed)',
      kind: `greenlake:${action}`,
      result: `${result} — ${detail}`,
      plane: 'greenlake',
    });
  }
}

/** HttpStatusError carries `status`; anything else is a transport failure. */
function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

/** Operator-facing reason for a 4xx. The vendor body is never echoed. */
function describeStatus(status: number, action: GreenLakeWriteAction): string {
  if (status === 401 || status === 403) {
    return `The workspace credential is not permitted to ${action} (HTTP ${status}). The write scope may be declared in the portal but not granted to the API client in GreenLake.`;
  }
  if (status === 404) {
    return `The GreenLake workspace has no endpoint for ${action} (HTTP 404) — this workspace may not be entitled to that API.`;
  }
  if (status === 405) {
    return `GreenLake does not allow ${action} on this workspace (HTTP 405 — the endpoint exists but refuses the method).`;
  }
  if (status === 409) {
    return `GreenLake reports a conflict for ${action} (HTTP 409) — the object may already exist.`;
  }
  return `GreenLake rejected the ${action} request (HTTP ${status}) — check the supplied fields.`;
}

/** Process-wide singleton, matching writeBroker's / sseObjects' pattern. */
export const greenlakeObjects = new GreenLakeObjectsService();
