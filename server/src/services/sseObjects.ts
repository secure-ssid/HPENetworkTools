/**
 * server/src/services/sseObjects.ts — HPE Aruba Networking SSE object CRUD.
 *
 * The route-facing layer over SseAdapter (server/src/planes/sse.ts): resolves
 * the linked adapter from the registry, conditionally enforces the hardened
 * review-confirmed direct-write gate (SSE has no ticket queue either), and
 * enforces the token's declared write scope
 * (capabilities().directWrite), validates the one field every kind actually
 * requires, and records ONE audit-log line per action (no payload, no
 * secret) into the broker's own change-log.jsonl so the Configure "Change
 * history" surface stays one place for every direct write in the portal —
 * Central's SSID applies and SSE's object CRUD alike.
 *
 * The inventory read is ALWAYS served from the poller's cache (the same
 * per-plane contribution ConfigInventory/assignments already use) — never a
 * live call — so opening the Systems Configuration tab costs nothing extra.
 * An accepted mutation + commit forces one fresh full pull. "Refreshed" is
 * reported only for a complete readable target kind and, when an id makes it
 * deterministic, only when the create/update/delete is visible.
 *
 * Serialization: every mutation (create/update/delete), commit-only retry,
 * and manually reconciled cleanup runs through `withLock()`, an in-process
 * mutex (a promise chain, the same shape as a simple FIFO queue) — SSE's
 * mandatory commit is TENANT-WIDE and its one write path (mutate → commit)
 * has no server-side compare-and-set of its own, so concurrent requests from
 * this process must never interleave journal inspection, mutation, recovery,
 * refresh, or durable cleanup.
 *
 * Durable mutation journal: a secret-free phase record is atomically saved
 * BEFORE the outbound mutation. Only `commit-rejected` proves both that the
 * mutation succeeded and that Commit definitely answered non-2xx, so it is
 * the ONLY phase eligible for a tenant-wide Commit retry. Every in-flight,
 * transport-unknown, accepted-but-unrecorded, rejected-mutation, corrupt, or
 * otherwise ambiguous record fails closed without calling Commit. Once
 * Commit is accepted, the journal is moved to a TERMINAL, non-retryable
 * `commit-accepted` phase BEFORE the cache is refreshed or the journal is
 * deleted — phase-specific recovery for that phase may only refresh/verify and
 * clean up. A definite mutation rejection is similarly moved to terminal
 * `mutation-rejected` BEFORE deletion, so a failed cleanup can never turn
 * that retained record into commit eligibility. If persisting an accepted
 * terminal phase fails, a non-retryable `commit-accepted-unrecorded` marker
 * is attempted; if even that cannot be saved, the prior `commit-in-flight`
 * marker remains ambiguous and recovery still never replays Commit. Update
 * verification never trusts "the id still exists" alone — it compares
 * allowlisted, secret-free fields (name/description/enabled) from the
 * submitted update against the refreshed row, or honestly reports the update
 * as unverified when nothing safely comparable was sent. The journal is
 * bound to a hash fingerprint of normalized base URL + token, survives
 * restarts, and may be cleared only after phase-specific recovery,
 * an explicit manually reconciled cleanup, or a definite mutation rejection.
 * Every save/delete error propagates fail-closed.
 */

import {
  SSE_OBJECT_KINDS,
  type SseCacheRefreshOutcome,
  type SseCommitOutcome,
  type SseCommitRetryResult,
  type SseInventory,
  type SseManualCleanupResult,
  type SseMutationAction,
  type SseMutationOutcome,
  type SseMutationResult,
  type SseObjectKind,
  type SseObjectSummary,
} from '@hpe/shared';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { SSE_KIND_SPEC, SseAdapter } from '../planes/sse';
import { Poller, poller as defaultPoller } from './poller';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { allowsLabDirectWrites } from './labWritePolicy';
import { currentActor } from './auth';

/** Durable, secret-free phase record — never a payload or token.
 *  Commit retry eligibility is deliberately represented by exactly one
 *  phase: `commit-rejected`. All other phases are non-commit recovery states. */
type SseJournalPhase =
  | 'mutation-in-flight'
  | 'mutation-transport-unknown'
  | 'mutation-rejected'
  | 'commit-in-flight'
  | 'commit-transport-unknown'
  | 'commit-rejected'
  | 'commit-accepted'
  | 'commit-accepted-unrecorded';

const SSE_MANUAL_CLEANUP_PHASES: readonly SseJournalPhase[] = [
  'mutation-in-flight',
  'mutation-transport-unknown',
  'commit-in-flight',
  'commit-transport-unknown',
  'commit-accepted-unrecorded',
];

const SSE_JOURNAL_PHASES: readonly SseJournalPhase[] = [
  'mutation-in-flight',
  'mutation-transport-unknown',
  'mutation-rejected',
  'commit-in-flight',
  'commit-transport-unknown',
  'commit-rejected',
  'commit-accepted',
  'commit-accepted-unrecorded',
];

interface SsePendingCommit {
  version: 1;
  phase: SseJournalPhase;
  kind: SseObjectKind;
  action: SseMutationAction;
  objectId?: string;
  clientCorrelation?: string;
  at: string;
  tenantFingerprint: string;
}

function isKnownAction(v: unknown): v is SseMutationAction {
  return v === 'create' || v === 'update' || v === 'delete';
}

function is2xx(httpCode: number | null): boolean {
  return httpCode !== null && httpCode >= 200 && httpCode < 300;
}

function isDefiniteMutationAccepted(outcome: SseMutationOutcome): boolean {
  return outcome.ok && outcome.acceptance === 'accepted' && is2xx(outcome.httpCode);
}

function isDefiniteMutationRejected(outcome: SseMutationOutcome): boolean {
  return !outcome.ok && outcome.acceptance === 'rejected' && outcome.httpCode !== null && !is2xx(outcome.httpCode);
}

function isDefiniteCommitAccepted(outcome: SseCommitOutcome): boolean {
  return outcome.ok && outcome.acceptance === 'accepted' && is2xx(outcome.httpCode);
}

function isDefiniteCommitRejected(outcome: SseCommitOutcome): boolean {
  return !outcome.ok && outcome.acceptance === 'rejected' && outcome.httpCode !== null && !is2xx(outcome.httpCode);
}

/** Stable machine-readable codes for the API boundary — never message-text
 *  matching. `SSE_PENDING_MUTATION` covers every "a durable SSE journal
 *  entry already blocks this action" 409 (pending, unknown-outcome, or a
 *  committed-but-not-yet-cleaned-up record), whatever its phase.
 *  `SSE_JOURNAL_PERSIST_FAILED` is the fail-closed outcome when durable state
 *  could not be saved or removed. `SSE_MANUAL_RECONCILIATION_REQUIRED`
 *  means the retained phase cannot prove Commit is safe to replay.
 *  `SSE_COMMIT_ACCEPTED_UNRECORDED` means Commit definitely succeeded but
 *  its normal terminal marker could not be persisted. */
export type SseObjectsErrorCode =
  | 'SSE_PENDING_MUTATION'
  | 'SSE_JOURNAL_PERSIST_FAILED'
  | 'SSE_MANUAL_RECONCILIATION_REQUIRED'
  | 'SSE_MANUAL_CLEANUP_NOT_ALLOWED'
  | 'SSE_COMMIT_ACCEPTED_UNRECORDED';

export const SSE_INTERNAL_ERROR_MESSAGE = 'internal error';

export class SseObjectsError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: SseObjectsErrorCode,
    readonly result?: SseManualCleanupResult,
  ) {
    super(message);
    this.name = 'SseObjectsError';
  }
}

export function sseObjectsErrorBody(
  err: SseObjectsError,
): { error: string; code?: SseObjectsErrorCode; result?: SseManualCleanupResult } {
  return {
    error: err.status >= 500 ? SSE_INTERNAL_ERROR_MESSAGE : err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.result ? { result: err.result } : {}),
  };
}

function safeMutationOutcome(outcome: SseMutationOutcome): SseMutationOutcome {
  const message =
    outcome.acceptance === 'accepted'
      ? `mutation accepted${outcome.httpCode === null ? '' : ` — HTTP ${outcome.httpCode}`}`
      : outcome.acceptance === 'rejected'
        ? `mutation rejected${outcome.httpCode === null ? '' : ` — HTTP ${outcome.httpCode}`}`
        : 'mutation request outcome is unknown';
  return { ...outcome, message };
}

function safeCommitOutcome(outcome: SseCommitOutcome): SseCommitOutcome {
  const message =
    outcome.acceptance === 'accepted'
      ? `Commit accepted${outcome.httpCode === null ? '' : ` — HTTP ${outcome.httpCode}`}`
      : outcome.acceptance === 'rejected'
        ? `Commit rejected${outcome.httpCode === null ? '' : ` — HTTP ${outcome.httpCode}`}`
        : outcome.acceptance === 'not-attempted'
          ? 'Commit was not attempted'
          : 'Commit request outcome is unknown';
  return { ...outcome, message };
}

function isKnownKind(v: unknown): v is SseObjectKind {
  return typeof v === 'string' && (SSE_OBJECT_KINDS as readonly string[]).includes(v);
}

/** One kind's slice of the cached inventory, for the object-browser list. */
export interface SseKindListing {
  rows: SseObjectSummary[];
  total: number | null;
  truncated: boolean;
  /** True when the kind was never read (401/403/404, or no sync yet) — the
   *  browser must render "unavailable", never an empty list. */
  unavailable: boolean;
}

export interface SseObjectsOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  pollerRef?: Poller; // default: the process-wide singleton
  plane?: SseAdapter | null; // test override — undefined resolves from the registry
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number;
  journalStore?: SseJournalStore;
  /** Test seam; production always reads the shared persisted lab policy. */
  allowsLabDirectWrites?: () => boolean;
}

export interface SseJournalStore {
  exists(): boolean;
  read(): string;
  write(record: SsePendingCommit): void;
  remove(): void;
}

class FileSseJournalStore implements SseJournalStore {
  constructor(
    private readonly dataDir: string,
    private readonly file = path.join(dataDir, 'sse-pending-commit.json'),
  ) {}

  exists(): boolean {
    try {
      fs.statSync(this.file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  read(): string {
    return fs.readFileSync(this.file, 'utf8');
  }

  write(record: SsePendingCommit): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  remove(): void {
    fs.unlinkSync(this.file);
  }
}

export class SseObjectsService {
  private readonly registry: PlaneRegistry;
  private readonly pollerRef: Poller;
  private readonly planeOverride: SseAdapter | null | undefined;
  private readonly dataDir: string;
  private readonly nowMs: () => number;
  private readonly journal: SseJournalStore;
  private readonly allowsLabDirectWrites: () => boolean;
  /** In-process mutex serializing every mutation and recovery operation —
   *  a promise chain, not a boolean flag, so a caller queues behind the
   *  current operation instead of being told "busy, try again". */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(opts: SseObjectsOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.pollerRef = opts.pollerRef ?? defaultPoller;
    this.planeOverride = opts.plane;
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.journal = opts.journalStore ?? new FileSseJournalStore(this.dataDir);
    this.allowsLabDirectWrites = opts.allowsLabDirectWrites ?? allowsLabDirectWrites;
  }

  static assertKind(value: string): SseObjectKind {
    if (!isKnownKind(value)) throw new SseObjectsError(404, `unknown SSE object kind '${value}'`);
    return value;
  }

  /** Runs `fn` after every previously queued mutation/recovery has settled —
   *  the ONLY path create/update/remove/retryCommit/manual cleanup run
   *  through, so journal inspection, mutation, Commit, refresh, and deletion
   *  can never interleave with another in-process caller. A failed run must
   *  not jam the queue for the next caller, so the chain link always resolves. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private adapter(): SseAdapter {
    const a = this.planeOverride !== undefined ? this.planeOverride : this.registry.get('sse');
    if (!(a instanceof SseAdapter)) {
      throw new SseObjectsError(409, 'sse is not linked — connect it from Connected systems first');
    }
    return a;
  }

  /** The cached inventory — the poller's last good pull, never a live call. */
  inventory(): SseInventory {
    const adapter = this.adapter(); // 409 before ever touching the cache
    const pull = this.pollerRef.contributionsByPlane().get('sse');
    return (
      pull?.sse ?? {
        kinds: {},
        unavailable: [...SSE_OBJECT_KINDS],
        source: `${adapter.id} linked — first sync pending`,
      }
    );
  }

  /** One kind's rows from the cached inventory, optionally filtered by a
   *  case-insensitive substring on name/description/detail. */
  listKind(kind: SseObjectKind, q?: string): SseKindListing {
    const inv = this.inventory();
    const slice = inv.kinds[kind];
    if (!slice || inv.unavailable.includes(kind)) {
      return { rows: [], total: null, truncated: false, unavailable: true };
    }
    const needle = q?.trim().toLowerCase();
    const rows = needle
      ? slice.rows.filter((r) => `${r.name} ${r.description ?? ''} ${r.detail ?? ''}`.toLowerCase().includes(needle))
      : slice.rows;
    return { rows, total: slice.total, truncated: slice.truncated, unavailable: false };
  }

  /** On-demand fresh single-object read — the detail/edit drawer's data.
   *  A real 404 stays 404; a scope/auth denial or any transport/unreadable-
   *  body failure is reported as a distinct 502 instead of being collapsed
   *  into "not found" — an operator must never be told a denied or
   *  unreachable read means the object does not exist. */
  async getObject(kind: SseObjectKind, id: string): Promise<Record<string, unknown>> {
    if (!id.trim()) throw new SseObjectsError(400, 'id is required');
    const adapter = this.adapter();
    const result = await adapter.getObject(kind, id);
    switch (result.status) {
      case 'ok':
        return result.object;
      case 'not-found':
        throw new SseObjectsError(404, `${kind} '${id}' was not found`);
      case 'denied':
        throw new SseObjectsError(
          502,
          `the SSE Admin API denied the request reading ${kind} '${id}' (HTTP ${result.httpCode}) — check the token's granted scope`,
        );
      case 'unreachable':
        throw new SseObjectsError(
          502,
          `${kind} '${id}' could not be read from the SSE plane${result.httpCode ? ` (HTTP ${result.httpCode})` : ' (transport error)'}`,
        );
    }
  }

  async create(kind: SseObjectKind, fieldsRaw: unknown, reviewConfirmedRaw: unknown): Promise<SseMutationResult> {
    return this.withLock(async () => {
      this.requireReview(reviewConfirmedRaw);
      this.requireNoPendingCommit();
      const adapter = this.requireWrite();
      const fields = this.validatedFields(kind, fieldsRaw, true);
      return this.runMutation(adapter, kind, 'create', undefined, fields);
    });
  }

  async update(kind: SseObjectKind, id: string, fieldsRaw: unknown, reviewConfirmedRaw: unknown): Promise<SseMutationResult> {
    return this.withLock(async () => {
      this.requireReview(reviewConfirmedRaw);
      if (!id.trim()) throw new SseObjectsError(400, 'id is required');
      this.requireNoPendingCommit();
      const adapter = this.requireWrite();
      const fields = this.validatedFields(kind, fieldsRaw, false);
      return this.runMutation(adapter, kind, 'update', id, fields);
    });
  }

  async remove(kind: SseObjectKind, id: string, reviewConfirmedRaw: unknown): Promise<SseMutationResult> {
    return this.withLock(async () => {
      this.requireReview(reviewConfirmedRaw);
      if (!id.trim()) throw new SseObjectsError(400, 'id is required');
      this.requireNoPendingCommit();
      const adapter = this.requireWrite();
      return this.runMutation(adapter, kind, 'delete', id);
    });
  }

  /**
   * Reviewed journal recovery. Despite the historical route name, this calls
   * tenant-wide Commit ONLY for `commit-rejected`, the sole phase proving a
   * successful mutation plus a definite Commit rejection. Accepted records
   * get refresh/cleanup only, rejected mutations get cleanup only, and every
   * ambiguous phase fails closed with manual-reconciliation guidance.
   */
  async retryCommit(reviewConfirmedRaw: unknown): Promise<SseCommitRetryResult> {
    return this.withLock(async () => {
      this.requireReview(reviewConfirmedRaw);
      const adapter = this.requireWrite();
      const pending = this.loadValidPending();
      if (!pending) {
        throw new SseObjectsError(
          409,
          'no portal-owned staged SSE commit was found to retry — nothing to apply',
        );
      }
      this.requireMatchingFingerprint(adapter, pending);

      switch (pending.phase) {
        case 'commit-rejected':
          return this.retryRejectedCommit(adapter, pending);
        case 'commit-accepted':
          return this.recoverAcceptedJournal(pending);
        case 'mutation-rejected':
          return this.recoverRejectedMutationJournal(pending);
        case 'mutation-in-flight':
        case 'mutation-transport-unknown':
        case 'commit-in-flight':
        case 'commit-transport-unknown':
        case 'commit-accepted-unrecorded':
          throw this.manualReconciliationError(pending);
      }
    });
  }

  /**
   * Cleanup-only recovery for an ambiguous journal after the operator has
   * manually reconciled the tenant in the SSE admin console. This path never
   * calls a mutation method or tenant-wide Commit. It refreshes the cache,
   * then removes the durable blocker only when both explicit acknowledgments,
   * current write scope, and the journal's tenant fingerprint all match.
   */
  async cleanupManuallyReconciled(
    reviewConfirmedRaw: unknown,
    manualReconciledRaw: unknown,
  ): Promise<SseManualCleanupResult> {
    return this.withLock(async () => {
      this.requireReview(reviewConfirmedRaw);
      this.requireManualReconciled(manualReconciledRaw);
      const adapter = this.requireWrite();
      const pending = this.loadValidPending();
      if (!pending) {
        throw new SseObjectsError(
          409,
          'no pending SSE mutation journal was found to clean up — tenant-wide Commit was not called',
          'SSE_MANUAL_CLEANUP_NOT_ALLOWED',
        );
      }
      this.requireMatchingFingerprint(adapter, pending);
      this.requireManualCleanupPhase(pending);

      const refreshed = await this.refreshCache(pending);
      const result = this.manualCleanupResult(pending, refreshed, 'journal-removed');
      this.registry.recordEvent('sse', {
        what: `operator attested manual reconciliation for ambiguous journaled ${pending.action} ${pending.kind}: cache refresh + durable cleanup only; tenant-wide Commit was not called`,
        who: currentActor(),
      });
      try {
        this.clearPending();
      } catch {
        const retained = this.manualCleanupResult(pending, refreshed, 'journal-retained');
        this.log('sse-manual-cleanup', pending.kind, 'journal-retained', undefined);
        throw new SseObjectsError(
          500,
          SSE_INTERNAL_ERROR_MESSAGE,
          'SSE_JOURNAL_PERSIST_FAILED',
          retained,
        );
      }
      this.log('sse-manual-cleanup', pending.kind, 'journal-removed', undefined);
      return result;
    });
  }

  /** The ONLY recovery helper allowed to call tenant-wide Commit. */
  private async retryRejectedCommit(adapter: SseAdapter, pending: SsePendingCommit): Promise<SseCommitRetryResult> {
    this.savePending({ ...pending, phase: 'commit-in-flight' });
    const rawCommit = await adapter.retryCommit();
    if (rawCommit.acceptance === 'unknown') {
      console.error(`sse commit retry failed: ${rawCommit.message}`);
    }
    const commit = safeCommitOutcome(rawCommit);

    if (isDefiniteCommitAccepted(commit)) {
      this.log('sse-commit-retry', pending.kind, 'commit-accepted', commit.httpCode ?? undefined);
      this.registry.recordEvent('sse', {
        what: `tenant-wide commit accepted for journaled ${pending.action} ${pending.kind}; object verification is reported separately`,
        who: currentActor(),
      });
      const acceptedTerminal = this.persistCommitAccepted(pending, commit.httpCode ?? undefined, 'sse-commit-retry');
      const refreshed = await this.refreshCache(acceptedTerminal);
      const journalRetained = !this.tryClearPending();
      return {
        commit,
        cacheRefresh: refreshed.outcome,
        ...(journalRetained ? { journalRetained: true } : {}),
        recovery: {
          journalPhase: pending.phase,
          action: 'commit-retry',
          mutationVerified: refreshed.mutationVerified,
          message: refreshed.mutationVerified
            ? 'the target mutation is visible in a complete target-kind refresh'
            : 'Commit was accepted, but the journaled object mutation was not verified by the refresh',
        },
      };
    }

    if (isDefiniteCommitRejected(commit)) {
      this.savePending({ ...pending, phase: 'commit-rejected' });
      this.log('sse-commit-retry', pending.kind, 'commit-rejected', commit.httpCode ?? undefined);
      this.registry.recordEvent('sse', {
        what: 'commit retry was definitely rejected — the proven staged change remains eligible for another retry',
        who: currentActor(),
      });
      return {
        commit,
        cacheRefresh: {
          attempted: false,
          status: 'skipped',
          message: 'commit retry was definitely rejected — cache was not refreshed',
        },
        recovery: {
          journalPhase: pending.phase,
          action: 'commit-retry',
          mutationVerified: false,
          message: 'the journal remains in commit-rejected and requires another explicit review before any further Commit retry',
        },
      };
    }

    this.savePending({ ...pending, phase: 'commit-transport-unknown' });
    this.log('sse-commit-retry', pending.kind, 'commit-transport-unknown', commit.httpCode ?? undefined);
    this.registry.recordEvent('sse', {
      what: 'commit retry transport outcome is unknown — Commit is no longer retryable; manual tenant reconciliation is required',
      who: currentActor(),
    });
    return {
      commit,
      cacheRefresh: {
        attempted: false,
        status: 'skipped',
        message: 'commit outcome is unknown — cache was not refreshed and Commit must not be retried',
      },
      recovery: {
        journalPhase: pending.phase,
        action: 'manual-reconciliation',
        mutationVerified: false,
        message: 'the retry outcome is ambiguous; the retained journal now requires manual reconciliation and is not commit-eligible',
      },
    };
  }

  private manualReconciliationError(pending: SsePendingCommit): SseObjectsError {
    const reason =
      pending.phase === 'mutation-in-flight' || pending.phase === 'mutation-transport-unknown'
        ? 'mutation acceptance is not durably proven'
        : pending.phase === 'commit-accepted-unrecorded'
          ? 'Commit was reported accepted but its normal terminal marker was not durably recorded'
          : 'Commit may already have been accepted';
    return new SseObjectsError(
      409,
      `SSE recovery phase '${pending.phase}' requires manual tenant reconciliation because ${reason}; tenant-wide Commit was not called and must not be retried from this journal; after reconciliation, use the explicit manual-cleanup operation with its separate attestation`,
      'SSE_MANUAL_RECONCILIATION_REQUIRED',
    );
  }

  /** A definite mutation rejection can only need durable journal cleanup. */
  private recoverRejectedMutationJournal(pending: SsePendingCommit): SseCommitRetryResult {
    this.registry.recordEvent('sse', {
      what: `cleanup for definitely rejected journaled ${pending.action} ${pending.kind}: Commit was not called`,
      who: currentActor(),
    });
    try {
      this.clearPending();
    } catch (err) {
      this.log('sse-commit-retry', pending.kind, 'mutation-rejected-cleanup-pending', undefined);
      throw err;
    }
    this.log('sse-commit-retry', pending.kind, 'mutation-rejected-cleaned-up', undefined);
    return {
      commit: {
        attempted: false,
        ok: false,
        httpCode: null,
        acceptance: 'not-attempted',
        message: 'the mutation was definitely rejected — recovery cleaned up its journal and did not call Commit',
      },
      cacheRefresh: {
        attempted: false,
        status: 'skipped',
        message: 'the mutation was rejected — no cache refresh was required',
      },
      recovery: {
        journalPhase: pending.phase,
        action: 'cleanup-only',
        mutationVerified: false,
        message: 'the rejected mutation journal was cleaned up without calling tenant-wide Commit',
      },
    };
  }

  /**
   * Reviewed recovery for a journal already in the TERMINAL `commit-accepted`
   * phase — this is the ONLY path a restarted process (or a cleanup-failure
   * retry within the same process) reaches here through. It never calls
   * Commit: the tenant-wide commit is already known accepted, so all that is
   * left is refreshing the cache for verification and clearing the journal.
   * If the cleanup (journal deletion) still fails, the terminal phase is
   * left exactly as-is on disk (non-retryable-for-commit) and the failure is
   * reported as cleanup-pending — never as license for another Commit.
   */
  private async recoverAcceptedJournal(pending: SsePendingCommit): Promise<SseCommitRetryResult> {
    const refreshed = await this.refreshCache(pending);
    this.registry.recordEvent('sse', {
      what: `recovery for an already-committed journaled ${pending.action} ${pending.kind}: cache refresh + cleanup only, Commit was not called again`,
      who: currentActor(),
    });
    try {
      this.clearPending();
    } catch (err) {
      this.log('sse-commit-retry', pending.kind, 'cleanup-pending', undefined);
      throw err;
    }
    this.log('sse-commit-retry', pending.kind, 'cleaned-up', undefined);
    return {
      commit: {
        attempted: false,
        ok: true,
        httpCode: null,
        acceptance: 'accepted',
        message: 'Commit was already accepted in a prior run — recovery only refreshed the cache and cleaned up the journal; Commit was not called again',
      },
      cacheRefresh: refreshed.outcome,
      recovery: {
        journalPhase: pending.phase,
        action: 'refresh-and-cleanup',
        mutationVerified: refreshed.mutationVerified,
        message: refreshed.mutationVerified
          ? 'the target mutation is visible in a complete target-kind refresh'
          : 'Commit was already accepted, but the journaled object mutation was not verified by the refresh',
      },
    };
  }


  /** Credential replacement/removal would orphan a journal or bind recovery
   * to a different tenant. Any pending file therefore blocks it. */
  assertCredentialsMutable(): void {
    if (this.hasPendingJournal()) {
      throw new SseObjectsError(
        409,
        'SSE credentials cannot be updated or deleted while a mutation journal is pending — use journal recovery and follow its commit-retry, cleanup-only, or manual-reconciliation/manual-cleanup guidance first',
        'SSE_PENDING_MUTATION',
      );
    }
  }

  // -- internals -------------------------------------------------------------

  /** Hardened mode's direct-write review gate. Lab mode preserves all recovery
   *  controls but does not require review confirmation. */
  private requireReview(reviewConfirmedRaw: unknown): void {
    if (!this.allowsLabDirectWrites() && reviewConfirmedRaw !== true) {
      throw new SseObjectsError(400, 'SSE writes require an explicit review confirmation');
    }
  }

  private requireManualReconciled(manualReconciledRaw: unknown): void {
    if (manualReconciledRaw !== true) {
      throw new SseObjectsError(
        400,
        'manual SSE journal cleanup requires an explicit manualReconciled:true attestation after tenant reconciliation',
      );
    }
  }

  private requireWrite(): SseAdapter {
    const adapter = this.adapter();
    if (adapter.capabilities().directWrite !== true) {
      throw new SseObjectsError(403, 'this token is read-only — no write scope was granted for it');
    }
    return adapter;
  }

  /** Refuses a new mutation while any durable journal remains. Only a
   *  `commit-rejected` record may be resolved by retrying Commit; every other
   *  phase is cleanup-only or manual reconciliation. */
  private requireNoPendingCommit(): void {
    if (this.hasPendingJournal()) {
      throw new SseObjectsError(
        409,
        'a previous SSE mutation journal is still pending — use journal recovery and follow its phase-specific guidance; tenant-wide Commit is allowed only for a definite commit-rejected phase',
        'SSE_PENDING_MUTATION',
      );
    }
  }

  private requireManualCleanupPhase(pending: SsePendingCommit): void {
    if (SSE_MANUAL_CLEANUP_PHASES.includes(pending.phase)) return;
    const guidance =
      pending.phase === 'commit-rejected'
        ? 'use the commit-retry recovery path'
        : pending.phase === 'commit-accepted'
          ? 'use the accepted-journal refresh-and-cleanup recovery path'
          : 'use the existing cleanup path for the definitely rejected mutation';
    throw new SseObjectsError(
      409,
      `manual reconciliation cleanup is not allowed for SSE journal phase '${pending.phase}' — ${guidance}; tenant-wide Commit was not called`,
      'SSE_MANUAL_CLEANUP_NOT_ALLOWED',
    );
  }

  private manualCleanupResult(
    pending: SsePendingCommit,
    refreshed: { outcome: SseCacheRefreshOutcome; mutationVerified: boolean },
    status: 'journal-removed' | 'journal-retained',
  ): SseManualCleanupResult {
    const removed = status === 'journal-removed';
    return {
      commit: {
        attempted: false,
        ok: false,
        httpCode: null,
        acceptance: 'not-attempted',
        message: `Tenant-wide Commit was not called during manual reconciliation cleanup; the durable journal was ${
          removed ? 'removed' : 'retained because deletion failed'
        }`,
      },
      cacheRefresh: refreshed.outcome,
      recovery: {
        journalPhase: pending.phase,
        action: 'manual-cleanup',
        status,
        mutationVerified: refreshed.mutationVerified,
        message: removed
          ? 'Manual reconciliation was attested and the durable journal was removed; tenant-wide Commit was not called'
          : 'Manual reconciliation was attested, but journal deletion failed and the blocker was retained; tenant-wide Commit was not called',
      },
    };
  }

  /**
   * `name`/`userName` (SSE_KIND_SPEC's requiredCreateField) is the only field
   * this layer itself demands — the rest of the vendor body shape is kind-
   * specific and the review dialog is what the operator actually checks
   * before applying. `id` is never taken from a body: only the route's own
   * path param may name an existing object, so a caller cannot smuggle a
   * targeted id into a create.
   */
  private validatedFields(kind: SseObjectKind, fieldsRaw: unknown, isCreate: boolean): Record<string, unknown> {
    if (!fieldsRaw || typeof fieldsRaw !== 'object' || Array.isArray(fieldsRaw)) {
      throw new SseObjectsError(400, 'fields must be an object');
    }
    const fields = { ...(fieldsRaw as Record<string, unknown>) };
    delete fields.id;
    if (isCreate) {
      const required = SSE_KIND_SPEC[kind].requiredCreateField;
      const value = fields[required];
      if (typeof value !== 'string' || !value.trim()) {
        throw new SseObjectsError(400, `${required} is required to create a ${kind} object`);
      }
    }
    return fields;
  }

  private async runMutation(
    adapter: SseAdapter,
    kind: SseObjectKind,
    action: SseMutationAction,
    id?: string,
    fields?: Record<string, unknown>,
  ): Promise<SseMutationResult> {
    const pending: SsePendingCommit = {
      version: 1,
      phase: 'mutation-in-flight',
      kind,
      action,
      ...(id ? { objectId: id } : { clientCorrelation: randomUUID() }),
      at: new Date(this.nowMs()).toISOString(),
      tenantFingerprint: adapter.tenantFingerprint(),
    };
    this.savePending(pending);

    const rawMutation = await adapter.mutateOnly(kind, action, id, fields);
    if (rawMutation.acceptance === 'unknown') {
      console.error(`sse ${action} failed: ${rawMutation.message}`);
    }
    const mutation = safeMutationOutcome(rawMutation);
    if (isDefiniteMutationRejected(mutation)) {
      const rejectedTerminal = { ...pending, phase: 'mutation-rejected' as const };
      // Persist the terminal non-commit phase BEFORE deletion. If cleanup
      // fails, the retained record remains provably ineligible for Commit.
      this.savePending(rejectedTerminal);
      this.recordMutation(kind, action, id, 'rejected', mutation.httpCode ?? undefined);
      const journalRetained = !this.tryClearPending();
      return {
        mutation,
        commit: {
          attempted: false,
          ok: false,
          httpCode: null,
          acceptance: 'not-attempted',
          message: 'not attempted — the mutation was rejected',
        },
        staged: false,
        outcome: 'rejected',
        cacheRefresh: { attempted: false, status: 'skipped', message: 'the mutation was rejected — nothing to refresh' },
        ...(journalRetained ? { journalRetained: true } : {}),
      };
    }

    if (!isDefiniteMutationAccepted(mutation)) {
      this.savePending({ ...pending, phase: 'mutation-transport-unknown' });
      this.recordMutation(kind, action, id, 'unknown', undefined);
      return {
        mutation,
        commit: {
          attempted: false,
          ok: false,
          httpCode: null,
          acceptance: 'not-attempted',
          message: 'not attempted — mutation acceptance is unknown; tenant-wide Commit must not be retried',
        },
        staged: false,
        outcome: 'unknown',
        cacheRefresh: {
          attempted: false,
          status: 'skipped',
          message: 'mutation acceptance is unknown — cache was not refreshed; manual reconciliation is required and Commit must not be retried',
        },
      };
    }

    const accepted = {
      ...pending,
      phase: 'commit-in-flight' as const,
      ...(mutation.id ? { objectId: mutation.id } : {}),
    };
    this.savePending(accepted);
    const rawCommit = await adapter.retryCommit();
    if (rawCommit.acceptance === 'unknown') {
      console.error(`sse commit failed: ${rawCommit.message}`);
    }
    const commit = safeCommitOutcome(rawCommit);
    if (isDefiniteCommitRejected(commit)) {
      this.savePending({ ...accepted, phase: 'commit-rejected' });
      this.recordMutation(kind, action, mutation.id ?? id, 'staged', commit.httpCode ?? undefined);
      return {
        mutation,
        commit,
        staged: true,
        outcome: 'staged',
        cacheRefresh: {
          attempted: false,
          status: 'skipped',
          message: 'Commit definitely rejected the successful mutation — cache was not refreshed',
        },
      };
    }

    if (!isDefiniteCommitAccepted(commit)) {
      this.savePending({ ...accepted, phase: 'commit-transport-unknown' });
      this.recordMutation(kind, action, mutation.id ?? id, 'unknown', undefined);
      return {
        mutation,
        commit,
        staged: false,
        outcome: 'unknown',
        cacheRefresh: {
          attempted: false,
          status: 'skipped',
          message: 'commit outcome is unknown — cache was not refreshed; manual reconciliation is required and Commit must not be retried',
        },
      };
    }

    // The tenant has accepted the commit. Transition the journal
    // to the TERMINAL, non-retryable `commit-accepted` phase BEFORE touching
    // the cache or deleting the journal — a crash between here and cleanup
    // must never leave behind a phase that a later recovery would replay
    // Commit for.
    const acceptedTerminal = this.persistCommitAccepted(
      accepted,
      commit.httpCode ?? undefined,
      `sse-${action}`,
      mutation.id ?? id,
    );

    const refreshed = await this.refreshCache(acceptedTerminal, action === 'update' ? fields : undefined);
    const journalRetained = !this.tryClearPending();
    const outcome = refreshed.mutationVerified ? 'applied' : 'unverified';
    this.recordMutation(kind, action, mutation.id ?? id, outcome, commit.httpCode ?? undefined);
    return {
      mutation,
      commit,
      staged: false,
      outcome,
      cacheRefresh: refreshed.outcome,
      ...(journalRetained ? { journalRetained: true } : {}),
    };
  }

  /**
   * Persist the normal accepted terminal. If that write fails, make one best-
   * effort attempt to replace ambiguous `commit-in-flight` with an explicit
   * non-retryable/manual marker. Recovery never treats either marker as
   * commit-eligible.
   */
  private persistCommitAccepted(
    pending: SsePendingCommit,
    httpCode: number | undefined,
    auditEvent: string,
    objectId?: string,
  ): SsePendingCommit {
    const acceptedTerminal = { ...pending, phase: 'commit-accepted' as const };
    try {
      this.savePending(acceptedTerminal);
      return acceptedTerminal;
    } catch {
      try {
        this.savePending({ ...pending, phase: 'commit-accepted-unrecorded' });
      } catch {
        // The prior commit-in-flight marker remains; it is also non-retryable.
      }
      if (auditEvent === 'sse-commit-retry') {
        this.log(auditEvent, pending.kind, 'commit-accepted-unrecorded', httpCode);
      } else {
        this.recordMutation(pending.kind, pending.action, objectId, 'commit-accepted-unrecorded', httpCode);
      }
      throw new SseObjectsError(
        500,
        SSE_INTERNAL_ERROR_MESSAGE,
        'SSE_COMMIT_ACCEPTED_UNRECORDED',
      );
    }
  }

  private recordMutation(
    kind: SseObjectKind,
    action: SseMutationAction,
    id?: string,
    outcome = 'failed',
    httpCode?: number,
  ): void {
    this.log(`sse-${action}`, kind, outcome, httpCode);
    this.registry.recordEvent('sse', {
      what: `${action} ${kind}${id ? ` ${id}` : ''} — ${outcome}${
        outcome === 'staged'
          ? ' (durable commit-rejected blocker retained; a tenant-wide Commit retry is allowed)'
          : outcome === 'unknown'
            ? ' (durable ambiguous blocker retained; manual reconciliation required and Commit retry is forbidden)'
          : ''
      }`,
      who: currentActor(),
    });
  }

  /** Force one fresh full pull so the cache reflects the change immediately.
   *  Reports whether the refresh actually landed instead of letting the
   *  caller assume it did — a mutation that just succeeded must not be
   *  followed by a cache the UI presents as current when it is still the
   *  pre-change (stale) snapshot. */
  private async refreshCache(
    pending: SsePendingCommit,
    expectedFields?: Record<string, unknown>,
  ): Promise<{ outcome: SseCacheRefreshOutcome; mutationVerified: boolean }> {
    try {
      const tick = await this.pollerRef.syncNowFor('sse');
      if (tick !== 'ok') {
        return {
          mutationVerified: false,
          outcome: {
            attempted: true,
            status: 'stale',
            message: `inventory cache refresh did not complete (poll ${tick}) — the mutation is unverified`,
          },
        };
      }
      const pull = this.pollerRef.contributionsByPlane().get('sse');
      const inventory = pull?.sse;
      const slice = inventory?.kinds[pending.kind];
      if (
        !pull ||
        pull.partial?.includes('sse') ||
        !inventory ||
        inventory.unavailable.includes(pending.kind) ||
        !slice ||
        slice.truncated
      ) {
        return {
          mutationVerified: false,
          outcome: {
            attempted: true,
            status: 'stale',
            message: `the refresh was partial, unavailable, or truncated for ${pending.kind} — the mutation is unverified`,
          },
        };
      }

      const targetId = pending.objectId;
      const targetRow = targetId ? slice.rows.find((row) => row.id === targetId) : undefined;
      const targetPresent = !!targetRow;
      if (pending.action === 'delete') {
        const mutationVerified = !!targetId && !targetPresent;
        if (targetId && !mutationVerified) {
          return {
            mutationVerified: false,
            outcome: {
              attempted: true,
              status: 'stale',
              message: `delete target ${pending.kind} '${targetId}' was not visible in the complete refresh — the mutation is unverified`,
            },
          };
        }
        return {
          mutationVerified,
          outcome: {
            attempted: true,
            status: 'refreshed',
            message: mutationVerified
              ? `inventory cache refreshed and the delete target was verified`
              : `inventory cache refreshed for ${pending.kind}; the mutation remains unverified because no returned object id was available`,
          },
        };
      }

      if (pending.action === 'create') {
        const mutationVerified = !!targetId && targetPresent;
        if (targetId && !mutationVerified) {
          return {
            mutationVerified: false,
            outcome: {
              attempted: true,
              status: 'stale',
              message: `create target ${pending.kind} '${targetId}' was not visible in the complete refresh — the mutation is unverified`,
            },
          };
        }
        return {
          mutationVerified,
          outcome: {
            attempted: true,
            status: 'refreshed',
            message: mutationVerified
              ? `inventory cache refreshed and the create target was verified`
              : `inventory cache refreshed for ${pending.kind}; the mutation remains unverified because no returned object id was available`,
          },
        };
      }

      // `update`: existence at the target id proves NOTHING by itself — the
      // object already existed there before the update. Verification must
      // compare allowlisted safe fields (name/description/enabled) from the
      // submitted update against the refreshed row; secrets/raw payloads are
      // never compared here. When the id is missing, the refresh cannot even
      // attempt this and is honestly reported unverified/stale.
      if (!targetId || !targetPresent) {
        return {
          mutationVerified: false,
          outcome: {
            attempted: true,
            status: 'stale',
            message: targetId
              ? `update target ${pending.kind} '${targetId}' was not visible in the complete refresh — the mutation is unverified`
              : `inventory cache refreshed for ${pending.kind}; the mutation remains unverified because no returned object id was available`,
          },
        };
      }
      const fieldCompare = this.compareAllowlistedUpdateFields(pending.kind, expectedFields, targetRow);
      if (fieldCompare === 'no-comparable-fields') {
        return {
          mutationVerified: false,
          outcome: {
            attempted: true,
            status: 'stale',
            message: `update target ${pending.kind} '${targetId}' is present, but none of the submitted fields are in the safely comparable set (name/description/enabled) — update visibility is unverified from the cache alone`,
          },
        };
      }
      if (fieldCompare === 'mismatch') {
        return {
          mutationVerified: false,
          outcome: {
            attempted: true,
            status: 'stale',
            message: `update target ${pending.kind} '${targetId}' is present, but the submitted field values do not match the refreshed object — update visibility is unverified (possibly stale)`,
          },
        };
      }
      return {
        mutationVerified: true,
        outcome: {
          attempted: true,
          status: 'refreshed',
          message: `inventory cache refreshed and the update target's submitted fields matched the refreshed object`,
        },
      };
    } catch (err) {
      console.error(`sse cache refresh failed: ${(err as Error).message}`);
      return {
        mutationVerified: false,
        outcome: {
          attempted: true,
          status: 'stale',
          message: 'inventory cache refresh failed — the mutation is unverified',
        },
      };
    }
  }

  /**
   * Allowlisted, secret-free comparison for update verification: `name`
   * (via the kind's nameField), `description`, and `enabled` are the ONLY
   * fields compared, and ONLY when the submitted update actually sent that
   * key — never the raw payload, never anything else the kind's SDK body
   * shape carries (e.g. a connectorZone's `connectors`, a user's SSH key).
   * Returns 'no-comparable-fields' when the update touched none of them, so
   * the caller can honestly report "unverified" instead of a false "match".
   */
  private compareAllowlistedUpdateFields(
    kind: SseObjectKind,
    expectedFields: Record<string, unknown> | undefined,
    row: SseObjectSummary | undefined,
  ): 'match' | 'mismatch' | 'no-comparable-fields' {
    if (!expectedFields || !row) return 'no-comparable-fields';
    const spec = SSE_KIND_SPEC[kind];
    const checks: Array<{ sent: unknown; cached: unknown }> = [];
    if (Object.prototype.hasOwnProperty.call(expectedFields, spec.nameField)) {
      checks.push({ sent: expectedFields[spec.nameField], cached: row.name });
    }
    if (Object.prototype.hasOwnProperty.call(expectedFields, 'description')) {
      checks.push({ sent: String(expectedFields.description ?? ''), cached: String(row.description ?? '') });
    }
    if (Object.prototype.hasOwnProperty.call(expectedFields, 'enabled')) {
      checks.push({ sent: Boolean(expectedFields.enabled), cached: Boolean(row.enabled) });
    }
    if (checks.length === 0) return 'no-comparable-fields';
    return checks.every((c) => c.sent === c.cached) ? 'match' : 'mismatch';
  }

  private log(event: string, kind: string, result: string, httpCode?: number): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event,
      changeId: `sse-${kind}-${this.nowMs()}`,
      ticket: '(none — direct apply)',
      kind: `sse:${kind}`,
      result,
      ...(httpCode !== undefined ? { httpCode } : {}),
    });
  }

  // -- durable pending-commit state --------------------------------------

  private hasPendingJournal(): boolean {
    try {
      return this.journal.exists();
    } catch (err) {
      throw this.journalPersistenceError('inspect durable mutation state', err);
    }
  }

  private savePending(record: SsePendingCommit): void {
    try {
      this.journal.write(record);
    } catch (err) {
      throw this.journalPersistenceError('save durable mutation state', err);
    }
  }

  /** The pending record, re-validated. Corrupt/edited state remains a blocker. */
  private loadValidPending(): SsePendingCommit | null {
    if (!this.hasPendingJournal()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.journal.read());
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new SseObjectsError(
          409,
          'the durable SSE mutation journal is corrupt — tenant-wide Commit was not called; manual reconciliation is required',
          'SSE_MANUAL_RECONCILIATION_REQUIRED',
        );
      }
      throw this.journalPersistenceError('read durable mutation state', err);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new SseObjectsError(
        409,
        'the durable SSE mutation journal is invalid — tenant-wide Commit was not called; manual reconciliation is required',
        'SSE_MANUAL_RECONCILIATION_REQUIRED',
      );
    }
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      !SSE_JOURNAL_PHASES.includes(rec.phase as SseJournalPhase) ||
      !isKnownKind(rec.kind) ||
      !isKnownAction(rec.action) ||
      typeof rec.at !== 'string' ||
      typeof rec.tenantFingerprint !== 'string' ||
      (rec.objectId !== undefined && typeof rec.objectId !== 'string') ||
      (rec.clientCorrelation !== undefined && typeof rec.clientCorrelation !== 'string') ||
      (rec.objectId === undefined && rec.clientCorrelation === undefined)
    ) {
      throw new SseObjectsError(
        409,
        'the durable SSE mutation journal is invalid or uses an ambiguous phase — tenant-wide Commit was not called; manual reconciliation is required',
        'SSE_MANUAL_RECONCILIATION_REQUIRED',
      );
    }
    return {
      version: 1,
      phase: rec.phase as SseJournalPhase,
      kind: rec.kind,
      action: rec.action,
      ...(typeof rec.objectId === 'string' ? { objectId: rec.objectId } : {}),
      ...(typeof rec.clientCorrelation === 'string' ? { clientCorrelation: rec.clientCorrelation } : {}),
      at: rec.at,
      tenantFingerprint: rec.tenantFingerprint,
    };
  }

  /**
   * Delete the journal, reporting a failure instead of throwing it.
   *
   * Every caller is past the point where the change is already decided: the
   * record has been moved to a terminal phase no recovery will replay Commit
   * for, which is exactly what makes a failed deletion safe — both call sites
   * that persist those phases say so in their own comments.
   *
   * Throwing here takes a settled outcome and hands the operator an internal
   * error for it. For an applied change that is the worst answer the portal
   * can give: the object exists, the audit line never gets written because the
   * throw happens first, and the natural response to "internal error" is to do
   * it again, which creates a second object. The leftover record does block
   * the next SSE change, so the caller reports that — separately from an
   * outcome that has not changed.
   */
  private tryClearPending(): boolean {
    try {
      this.journal.remove();
      return true;
    } catch (err) {
      console.error(
        `sse journal: could not delete durable mutation state: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private clearPending(): void {
    try {
      this.journal.remove();
    } catch (err) {
      throw this.journalPersistenceError('delete durable mutation state', err);
    }
  }

  private journalPersistenceError(operation: string, cause: unknown): SseObjectsError {
    console.error(`sse journal: could not ${operation}: ${(cause as Error).message}`);
    return new SseObjectsError(500, SSE_INTERNAL_ERROR_MESSAGE, 'SSE_JOURNAL_PERSIST_FAILED');
  }

  private requireMatchingFingerprint(adapter: SseAdapter, pending: SsePendingCommit): void {
    if (pending.tenantFingerprint !== adapter.tenantFingerprint()) {
      throw new SseObjectsError(
        409,
        'the pending SSE mutation belongs to different credentials or base URL — tenant-wide Commit was not called; restore the matching adapter and manually reconcile before recovery',
        'SSE_MANUAL_RECONCILIATION_REQUIRED',
      );
    }
  }
}

/** Process-wide singleton, matching writeBroker's / ssidDirectWrite's pattern. */
export const sseObjects = new SseObjectsService();
