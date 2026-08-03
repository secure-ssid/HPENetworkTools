/**
 * web/src/screens/SseInventoryPanel.tsx — HPE Aruba Networking SSE's object
 * inventory browser, embedded in the Systems screen's Configuration tab for a
 * linked `sse` plane.
 *
 * Renders a searchable, grouped-by-kind list (GET /api/sse/objects/:kind, an
 * on-demand fresh read for the whole app: the poller cache backs the initial
 * kind counts, GET /api/sse/inventory), a detail/edit/create drawer, delete
 * confirmation, and a mandatory review step before any write — mirroring the
 * direct-write review gate the Configure screen's SSID apply uses. A create/
 * update/delete always attempts the vendor's required commit; when it fails
 * the change is STAGED (not applied) and a dedicated retry-commit action is
 * offered instead of replaying the write.
 *
 * `canWrite` is the plane's declared write scope (PlaneCapabilities.
 * directWrite, read off GET /api/systems/state) — every mutating control is
 * hidden without it, never merely disabled-and-clickable, and a builtIn
 * (vendor system-defined) row never shows mutation controls regardless.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  EmptyState,
  FormField,
  Input,
  SectionHeader,
  Select,
  Spinner,
  Table,
  Textarea,
  useToast,
} from '../nightdesk';
import {
  cleanupSseManualReconciliation,
  createSseObject,
  deleteSseObject,
  getSseInventory,
  getSseKind,
  getSseObject,
  retrySseCommit,
  updateSseObject,
  type SseKindListing,
} from '../api/client';
import { useLabConfigMode } from '../hooks/useLabConfigMode';
import {
  SSE_OBJECT_KINDS,
  SSE_OBJECT_KIND_LABELS,
  type SseCacheRefreshOutcome,
  type SseCommitOutcome,
  type SseKindReadStatus,
  type SseMutationResult,
  type SseObjectKind,
  type SseObjectSummary,
} from '@hpe/shared';

const KIND_OPTIONS = SSE_OBJECT_KINDS.map((k) => ({ value: k, label: SSE_OBJECT_KIND_LABELS[k] }));
const TENANT_WIDE_RECOVERY_WARNING =
  'Recovery may need a tenant-wide Commit that can apply other changes already staged on this SSE tenant.';
/**
 * The change itself is done — the object was mutated and the tenant accepted
 * the Commit. Only the leftover bookkeeping failed, and a leftover journal is
 * what the server refuses the NEXT SSE change on. Saying nothing would hand
 * the operator a 409 later with no way to connect it to this, so the panel
 * says it now and leaves the recovery controls up: the retained phases both
 * route to a cleanup that never calls tenant-wide Commit.
 */
const JOURNAL_RETAINED_NOTICE =
  'The durable journal could not be removed afterwards, so the next SSE change will be refused until it is cleaned up. Run the recovery below.';

const MANUAL_CLEANUP_NO_COMMIT_NOTICE =
  'Manual reconciliation cleanup never calls tenant-wide Commit; it only refreshes the cache and removes the durable journal.';

/** Fields the drawer edits directly; everything else in the vendor body
 *  round-trips through the "Additional fields (JSON)" textarea below. */
const COMMON_FIELDS = new Set(['name', 'userName', 'description', 'enabled']);

type DrawerMode = 'create' | 'edit' | null;

interface FormState {
  primaryName: string; // `name` for every kind except `users` (`userName`)
  description: string;
  enabled: boolean;
  extraJson: string; // the rest of the vendor body, operator-edited JSON
  extraError: string | null;
}

interface ListingState {
  kind: SseObjectKind;
  query: string;
  listing: SseKindListing | null;
  loading: boolean;
}

function emptyForm(): FormState {
  return { primaryName: '', description: '', enabled: true, extraJson: '{}', extraError: null };
}

function formFromRaw(kind: SseObjectKind, raw: Record<string, unknown>): FormState {
  const primaryKey = kind === 'users' ? 'userName' : 'name';
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (COMMON_FIELDS.has(k) || k === 'id') continue;
    rest[k] = v;
  }
  return {
    primaryName: typeof raw[primaryKey] === 'string' ? (raw[primaryKey] as string) : '',
    description: typeof raw.description === 'string' ? (raw.description as string) : '',
    enabled: raw.enabled !== false,
    extraJson: JSON.stringify(rest, null, 2),
    extraError: null,
  };
}

function recoveryNotice(name: string, action: 'create' | 'update' | 'delete', result: SseMutationResult): string {
  const target = action === 'delete' ? `Delete of ${name}` : `${action === 'create' ? 'Create' : 'Update'} for ${name}`;
  if (result.outcome === 'unknown') {
    const step =
      result.mutation.acceptance === 'unknown' ? 'mutation transport outcome' : 'tenant-wide Commit transport outcome';
    return `${target}: the ${step} is unknown. No automatic tenant-wide Commit is permitted. Manually reconcile the mutation and Commit status in the SSE admin console before cleanup. A durable journal is blocking further SSE changes.`;
  }
  return `${target}: the mutation is staged because Commit was not accepted. Run the reviewed recovery below. ${result.commit.message}`;
}

function readFailure(
  label: string,
  listing: SseKindListing | null,
): { title: string; description: string } | null {
  const status: SseKindReadStatus | undefined = listing?.readStatus;
  if (status?.state === 'failed') {
    switch (status.reason) {
      case 'denied':
        return {
          title: `${label} access denied`,
          description:
            'The SSE Admin API refused this read. A token grant may be missing, or this tenant may not be entitled to the kind — a token that already carries the matching scope can still be refused.',
        };
      case 'unsupported':
        return {
          title: `${label} unsupported`,
          description: 'This kind is unsupported, limited-release, or not enabled for this tenant.',
        };
      case 'service-error':
        return {
          title: `${label} service error`,
          description: `The SSE service returned an error or rate-limit response${
            status.httpCode ? ` (HTTP ${status.httpCode})` : ''
          }. Try again after the service recovers.`,
        };
      case 'unreachable':
        return {
          title: `${label} unreachable`,
          description: 'The SSE service could not be reached because the request failed or timed out.',
        };
      case 'invalid-response':
        return {
          title: `${label} invalid response`,
          description: 'The SSE service returned a successful response, but its inventory shape was not recognized.',
        };
      case 'not-synced':
        return {
          title: `${label} not synced`,
          description: 'This kind has not been read yet. Run a sync to obtain its current status.',
        };
    }
  }
  if (listing?.readError) {
    return {
      title: `${label} read failed`,
      description: `${listing.readError} This is not the same as an available empty list.`,
    };
  }
  if (listing?.unavailable) {
    return {
      title: `${label} unavailable`,
      description: 'This kind could not be read. Run a sync and check the connected service status.',
    };
  }
  return null;
}

interface SseInventoryPanelProps {
  canWrite: boolean;
  initialKind?: SseObjectKind;
  initialObjectId?: string;
}

export function SseInventoryPanel({
  canWrite,
  initialKind = 'connectorZones',
  initialObjectId,
}: SseInventoryPanelProps) {
  const { toast } = useToast();
  const { lab } = useLabConfigMode();
  const [kind, setKind] = useState<SseObjectKind>(initialKind);
  const [q, setQ] = useState('');
  const [listingState, setListingState] = useState<ListingState>({
    kind: initialKind,
    query: '',
    listing: null,
    loading: true,
  });
  const [stagedNotice, setStagedNotice] = useState<string | null>(null);
  const [commitWarning, setCommitWarning] = useState<string | null>(null);
  const [cacheRefresh, setCacheRefresh] = useState<SseCacheRefreshOutcome | null>(null);
  /* Whether the LAST settled change was confirmed on the tenant. Kept apart
     from cacheRefresh.status because the two can disagree: a refresh that
     completed cleanly still leaves the mutation unverified when the plane
     returned no object id to look for, and the refresh's own 'refreshed'
     would then colour that green. */
  const [mutationUnverified, setMutationUnverified] = useState(false);
  const [cacheListReloaded, setCacheListReloaded] = useState(false);
  const [retryReviewed, setRetryReviewed] = useState(false);
  const [manualReconciled, setManualReconciled] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [unknownRecovery, setUnknownRecovery] = useState(false);

  /* The Inventory Explorer deep-links into the edit drawer (initialObjectId)
     and remounts the panel per stable node, so the drawer's open state is
     initial state; the object read below fills the form when it lands. */
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(initialObjectId ? 'edit' : null);
  const [drawerKind, setDrawerKind] = useState<SseObjectKind | null>(initialObjectId ? initialKind : null);
  const [drawerQuery, setDrawerQuery] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(initialObjectId ?? null);
  const [drawerBuiltIn, setDrawerBuiltIn] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(Boolean(initialObjectId));
  const [form, setForm] = useState<FormState>(emptyForm());
  const [reviewed, setReviewed] = useState(false);
  const [applying, setApplying] = useState(false);

  const mountedRef = useRef(false);
  const kindRef = useRef(kind);
  const listingStateRef = useRef(listingState);
  const listingRequestRef = useRef(0);
  const drawerRequestRef = useRef(0);
  const outcomeRequestRef = useRef(0);

  /* Latest-value mirrors for the async handlers below — a commit can land
     while a plane call is in flight. Written in an effect (the compiler's
     refs rule forbids writing refs during render), so they hold the last
     committed values, which is all a post-commit reader can ask for. */
  useEffect(() => {
    kindRef.current = kind;
    listingStateRef.current = listingState;
  });

  const fetchListing = async (k: SseObjectKind, query: string) => {
    const request = ++listingRequestRef.current;
    let result: SseKindListing;
    try {
      result = await getSseKind(k, query || undefined);
    } catch (err) {
      result = {
        rows: [],
        total: null,
        truncated: false,
        unavailable: true,
        readStatus: {
          state: 'failed',
          reason: 'unreachable',
          httpCode: null,
          message: 'The portal backend could not be reached for this SSE read.',
        },
        readError: `List read failed: ${(err as Error).message}`,
      };
    }
    if (!mountedRef.current || request !== listingRequestRef.current) return false;
    setListingState({ kind: k, query, listing: result, loading: false });
    return !result.readError;
  };

  const load = async (k: SseObjectKind, query: string) => {
    setListingState({ kind: k, query, listing: null, loading: true });
    return fetchListing(k, query);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listingRequestRef.current += 1;
      drawerRequestRef.current += 1;
    };
  }, []);

  /* Switching kinds shows the new kind's loading state at once (adjusted
     during render — an effect would commit one frame of the old kind's list
     under the new tab first); the read itself stays an effect. */
  const [prevKind, setPrevKind] = useState(kind);
  if (prevKind !== kind) {
    setPrevKind(kind);
    setListingState({ kind, query: q, listing: null, loading: true });
  }

  useEffect(() => {
    void fetchListing(kind, q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  // Priming call so the panel can say "not yet synced" instead of a bare
  // spinner when the plane has just been connected.
  useEffect(() => {
    void getSseInventory();
  }, []);

  const search = async () => {
    await load(kind, q);
  };

  const closeDrawer = () => {
    drawerRequestRef.current += 1;
    setDrawerMode(null);
    setDrawerKind(null);
    setDrawerQuery('');
    setDrawerId(null);
    setDrawerLoading(false);
    setReviewed(false);
    setApplying(false);
    setForm(emptyForm());
  };

  const openCreate = () => {
    drawerRequestRef.current += 1;
    setDrawerMode('create');
    setDrawerKind(kind);
    setDrawerQuery(q);
    setDrawerId(null);
    setDrawerBuiltIn(false);
    setDrawerLoading(false);
    setForm(emptyForm());
    setReviewed(false);
    setApplying(false);
  };

  const fetchDrawerObject = async (rowKind: SseObjectKind, id: string, name: string, request: number) => {
    const res = await getSseObject(rowKind, id);
    if (!mountedRef.current || request !== drawerRequestRef.current) return;
    setDrawerLoading(false);
    if (!res.ok || !res.object) {
      toast(res.message ?? `could not read ${name}`, { tone: 'danger' });
      closeDrawer();
      return;
    }
    setForm(formFromRaw(rowKind, res.object));
  };

  const openEditById = async (
    id: string,
    name: string,
    builtIn: boolean,
    rowKind: SseObjectKind,
    query: string,
  ) => {
    const request = ++drawerRequestRef.current;
    setDrawerMode('edit');
    setDrawerKind(rowKind);
    setDrawerQuery(query);
    setDrawerId(id);
    setDrawerBuiltIn(builtIn);
    setReviewed(false);
    setApplying(false);
    setDrawerLoading(true);
    await fetchDrawerObject(rowKind, id, name, request);
  };

  const openEdit = async (row: SseObjectSummary, rowKind: SseObjectKind, query: string) => {
    await openEditById(row.id, row.name, row.builtIn === true, rowKind, query);
  };

  useEffect(() => {
    if (initialObjectId) {
      const request = ++drawerRequestRef.current;
      void fetchDrawerObject(initialKind, initialObjectId, initialObjectId, request);
    }
    // The Inventory Explorer remounts the panel for each stable selected node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (row: SseObjectSummary, rowKind: SseObjectKind, query: string) => {
    const ok = window.confirm(
      `Delete ${row.name}? The deletion will be staged and becomes effective only after SSE Commit is accepted. Commit is tenant-wide and may include other staged tenant changes. It is not reversible from here once committed.`,
    );
    if (!ok) return;
    const result = await deleteSseObject(rowKind, row.id, lab ? undefined : true);
    if (!mountedRef.current) return;
    const needsRecovery = Boolean(result.result && (result.result.staged || result.result.outcome === 'unknown'));
    if (result.result) {
      recordOutcome(
        result.result.commit,
        result.result.cacheRefresh,
        needsRecovery,
        result.result.outcome === 'unverified',
      );
    }
    if (result.pendingCommit) {
      setCommitWarning(TENANT_WIDE_RECOVERY_WARNING);
      setStagedNotice(`Pending SSE recovery required. ${result.message}`);
      setUnknownRecovery(false);
      setRetryReviewed(false);
      setManualReconciled(false);
      return;
    }
    if (result.result && needsRecovery) {
      setStagedNotice(recoveryNotice(row.name, 'delete', result.result));
      setUnknownRecovery(result.result.outcome === 'unknown');
      setRetryReviewed(false);
      setManualReconciled(false);
      if (result.result.outcome === 'unknown') setCommitWarning(MANUAL_CLEANUP_NO_COMMIT_NOTICE);
      return;
    }
    if (!result.ok) {
      toast(result.message, { tone: 'danger' });
      return;
    }
    if (result.result?.journalRetained) {
      setStagedNotice(`${row.name} was deleted and committed. ${JOURNAL_RETAINED_NOTICE}`);
      setUnknownRecovery(false);
      setRetryReviewed(false);
      setManualReconciled(false);
      toast(`${row.name} deleted and committed — its journal was left behind`, { tone: 'warning' });
    } else if (result.result?.outcome === 'unverified') {
      toast(`${row.name} committed, but the deletion is not confirmed on the tenant`, { tone: 'warning' });
    } else {
      toast(`${row.name} deleted and committed`, { tone: 'success' });
    }
    if (kindRef.current === rowKind) await load(rowKind, query);
  };

  const parsedExtra = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(form.extraJson || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const activeDrawerKind = drawerKind ?? kind;
  const primaryLabel = activeDrawerKind === 'users' ? 'Username' : 'Name';

  const recordOutcome = (
    commit: SseCommitOutcome,
    refresh: SseCacheRefreshOutcome,
    forceTenantWideWarning = false,
    unverified = false,
  ) => {
    const request = ++outcomeRequestRef.current;
    setCommitWarning(commit.warning ?? (forceTenantWideWarning ? TENANT_WIDE_RECOVERY_WARNING : null));
    setCacheRefresh(refresh);
    setMutationUnverified(unverified);
    setCacheListReloaded(false);
    return request;
  };

  const confirmReloaded = (outcomeRequest: number, reloaded: boolean | undefined) => {
    if (reloaded && outcomeRequest === outcomeRequestRef.current) setCacheListReloaded(true);
  };

  const submit = async () => {
    const actionKind = drawerKind;
    const actionMode = drawerMode;
    const actionId = drawerId;
    const actionQuery = drawerQuery;
    const actionName = form.primaryName.trim();
    const drawerRequest = drawerRequestRef.current;
    if ((!lab && !reviewed) || !actionKind || !actionMode) return;
    const extra = parsedExtra();
    if (extra === null) {
      setForm((f) => ({ ...f, extraError: 'Additional fields must be valid JSON for an object' }));
      return;
    }
    if (!form.primaryName.trim()) {
      toast(`${primaryLabel} is required`, { tone: 'danger' });
      return;
    }
    const primaryKey = actionKind === 'users' ? 'userName' : 'name';
    const fields: Record<string, unknown> = {
      ...extra,
      [primaryKey]: form.primaryName.trim(),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      enabled: form.enabled,
    };
    setApplying(true);
    const result =
      actionMode === 'create'
        ? await createSseObject(actionKind, fields, lab ? undefined : true)
        : await updateSseObject(actionKind, actionId as string, fields, lab ? undefined : true);
    if (!mountedRef.current) return;
    const drawerIsCurrent = drawerRequest === drawerRequestRef.current;
    if (drawerIsCurrent) setApplying(false);
    let outcomeRequest: number | null = null;
    const needsRecovery = Boolean(result.result && (result.result.staged || result.result.outcome === 'unknown'));
    if (result.result) {
      outcomeRequest = recordOutcome(
        result.result.commit,
        result.result.cacheRefresh,
        needsRecovery,
        result.result.outcome === 'unverified',
      );
    }
    if (result.pendingCommit) {
      setCommitWarning(TENANT_WIDE_RECOVERY_WARNING);
      setStagedNotice(`Pending SSE recovery required. ${result.message}`);
      setUnknownRecovery(false);
      setRetryReviewed(false);
      setManualReconciled(false);
      if (drawerIsCurrent) closeDrawer();
      return;
    }
    if (result.result && needsRecovery) {
      setStagedNotice(recoveryNotice(actionName, actionMode === 'create' ? 'create' : 'update', result.result));
      setUnknownRecovery(result.result.outcome === 'unknown');
      setRetryReviewed(false);
      setManualReconciled(false);
      if (result.result.outcome === 'unknown') setCommitWarning(MANUAL_CLEANUP_NO_COMMIT_NOTICE);
      if (drawerIsCurrent) closeDrawer();
      return;
    }
    if (!result.ok) {
      toast(result.message, { tone: 'danger' });
      return;
    }
    const verb = actionMode === 'create' ? 'created' : 'updated';
    if (result.result?.journalRetained) {
      setStagedNotice(`${actionName} was ${verb} and committed. ${JOURNAL_RETAINED_NOTICE}`);
      setUnknownRecovery(false);
      setRetryReviewed(false);
      setManualReconciled(false);
      toast(`${actionName} ${verb} and committed — its journal was left behind`, { tone: 'warning' });
    } else if (result.result?.outcome === 'unverified') {
      /* Not a staged change and not a failure: the tenant took the Commit.
         What it did not do is show the change back, so the operator is told
         to check rather than told it is done. No recovery controls, because
         the journal is in a terminal phase nothing may replay Commit for. */
      toast(`${actionName} committed, but the ${verb === 'created' ? 'creation' : 'update'} is not confirmed on the tenant`, {
        tone: 'warning',
      });
    } else {
      toast(`${actionName} ${verb} and committed`, { tone: 'success' });
    }
    if (drawerIsCurrent) closeDrawer();
    if (kindRef.current === actionKind) {
      const reloaded = await load(actionKind, actionQuery);
      if (outcomeRequest !== null && result.result?.cacheRefresh.status === 'refreshed') {
        confirmReloaded(outcomeRequest, reloaded);
      }
    }
  };

  const retryCommit = async () => {
    if ((!lab && !retryReviewed) || (unknownRecovery && !manualReconciled)) return;
    setRetrying(true);
    const result = unknownRecovery
      ? await cleanupSseManualReconciliation(lab ? undefined : true, true)
      : await retrySseCommit(lab ? undefined : true);
    if (!mountedRef.current) return;
    setRetrying(false);
    setRetryReviewed(false);
    setManualReconciled(false);
    let outcomeRequest: number | null = null;
    if (result.result) {
      outcomeRequest = recordOutcome(result.result.commit, result.result.cacheRefresh);
      if (unknownRecovery) setCommitWarning(MANUAL_CLEANUP_NO_COMMIT_NOTICE);
    }
    if (result.ok) {
      // A recovery whose entire job was to remove the journal, and which did
      // not remove it, has not finished — and clearing the notice takes away
      // the only control that can finish it. The commit part of the answer is
      // still reported below, because that part did happen.
      // Manual cleanup states the same fact as recovery.status, and api/sse.ts
      // already refuses to call that one ok, so only the retry shape reaches
      // here carrying it.
      const stillBlocked =
        !!result.result && 'journalRetained' in result.result && result.result.journalRetained === true;
      setStagedNotice(stillBlocked ? JOURNAL_RETAINED_NOTICE : null);
      setUnknownRecovery(false);
      if (stillBlocked) {
        toast('Recovery ran, but the journal was left behind', { tone: 'warning' });
      } else if (result.result?.commit.attempted === false) {
        const message =
          result.result.commit.message ||
          result.result.recovery?.message ||
          'Recovery completed without calling tenant-wide Commit.';
        toast(
          /tenant-wide Commit was (?:not called|not replayed)/i.test(message)
            ? message
            : `${message} No tenant-wide Commit was replayed.`,
          { tone: 'success' },
        );
      } else {
        toast('Tenant-wide Commit was accepted during reviewed recovery.', { tone: 'success' });
      }
      if (result.result?.cacheRefresh.status === 'refreshed' && outcomeRequest !== null) {
        const currentListing = listingStateRef.current;
        const reloaded = await load(currentListing.kind, currentListing.query);
        confirmReloaded(outcomeRequest, reloaded);
      }
    } else {
      if (result.code === 'SSE_MANUAL_RECONCILIATION_REQUIRED') {
        setUnknownRecovery(true);
        setCommitWarning(MANUAL_CLEANUP_NO_COMMIT_NOTICE);
        setStagedNotice(
          `${result.message} After reconciling the outcome in the SSE admin console, use the cleanup-only attestation below. Tenant-wide Commit will not be called.`,
        );
      }
      toast(result.message, { tone: 'danger' });
    }
  };

  const listing = listingState.kind === kind ? listingState.listing : null;
  const loading = listingState.kind !== kind || listingState.loading;
  const rows = useMemo(() => listing?.rows ?? [], [listing]);
  const failure = readFailure(SSE_OBJECT_KIND_LABELS[kind], listing);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHeader
        label="Object inventory"
        meta={
          !canWrite ? (
            <Badge tone="neutral">read only — no write scope granted</Badge>
          ) : (
            <Badge tone="accent">{lab ? 'direct writes · auto-commit' : 'reviewed writes · auto-commit'}</Badge>
          )
        }
      />

      <div
        style={{
          padding: '10px 12px',
          border: '1px solid var(--nd-warning)',
          borderRadius: 6,
          fontSize: 12.5,
        }}
      >
        <strong>Commit is tenant-wide.</strong> It may apply other changes already staged on this SSE tenant, not only
        the change being applied here.
      </div>

      {commitWarning ? (
        <div style={{ color: 'var(--nd-warning)', fontSize: 12.5 }}>
          <strong>Commit warning:</strong> {commitWarning}
        </div>
      ) : null}

      {cacheRefresh ? (
        <div
          style={{
            padding: '8px 10px',
            border: `1px solid var(--nd-${
              cacheRefresh.status === 'refreshed' && !mutationUnverified ? 'success' : 'warning'
            })`,
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <strong>
            Cached inventory {cacheRefresh.status === 'refreshed' ? 'refreshed' : cacheRefresh.status}.
          </strong>{' '}
          {cacheRefresh.message}
          {cacheRefresh.status !== 'refreshed'
            ? ' The list below is not confirmed current and may not reflect the change.'
            : mutationUnverified
              ? /* The read succeeded; the change was not in what came back.
                   Saying the list was reloaded is true and beside the point,
                   and in green it reads as confirmation of the wrong thing. */
                ' The read itself succeeded — it is the change that was not confirmed in what came back. Check the object on the SSE tenant before treating it as applied.'
              : cacheListReloaded
                ? ' The list below was reloaded from the refreshed cache.'
                : ' The list below is not confirmed current because its reload has not completed successfully.'}
        </div>
      ) : null}

      {stagedNotice ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 8,
            padding: '10px 12px',
            border: '1px solid var(--nd-warning)',
            borderRadius: 6,
            fontSize: 12.5,
          }}
        >
          <span>{stagedNotice}</span>
          {!lab ? <Checkbox
            label={
              unknownRecovery
                ? 'I reviewed this cleanup-only recovery and understand tenant-wide Commit will not be called.'
                : 'I reviewed this recovery and understand it may run a tenant-wide Commit only if needed, which may apply other staged tenant changes.'
            }
            checked={retryReviewed}
            disabled={retrying}
            onChange={(e) => setRetryReviewed(e.target.checked)}
          /> : null}
          {unknownRecovery ? (
            <Checkbox
              label="I attest that I manually reconciled the mutation and Commit outcome in the SSE admin console and authorize durable journal removal."
              checked={manualReconciled}
              disabled={retrying}
              onChange={(e) => setManualReconciled(e.target.checked)}
            />
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={(!lab && !retryReviewed) || (unknownRecovery && !manualReconciled) || retrying}
            onClick={() => void retryCommit()}
          >
            {retrying
              ? 'Recovering…'
              : unknownRecovery
                ? 'Attest manual reconciliation and remove journal'
                : 'Run recovery'}
          </Button>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <FormField label="Object kind">
          <Select
            size="sm"
            options={KIND_OPTIONS}
            value={kind}
            onValueChange={(v) => setKind(v as SseObjectKind)}
          />
        </FormField>
        <FormField label="Search">
          <Input
            size="sm"
            placeholder="filter by name, description…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search();
            }}
          />
        </FormField>
        <Button size="sm" variant="secondary" onClick={() => void search()}>
          Search
        </Button>
        {canWrite ? (
          <Button size="sm" variant="primary" onClick={openCreate}>
            New {SSE_OBJECT_KIND_LABELS[kind].replace(/s$/, '')}
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <Spinner size="sm" />
        </div>
      ) : failure ? (
        <EmptyState {...failure} />
      ) : rows.length === 0 ? (
        <EmptyState title={`No ${SSE_OBJECT_KIND_LABELS[kind].toLowerCase()}`} description={q ? 'No rows match the search.' : 'The plane reports none of this kind.'} />
      ) : (
        <Table density="compact">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>Detail</Table.HeaderCell>
              <Table.HeaderCell>State</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {rows.map((row) => (
              <Table.Row key={row.id}>
                <Table.Cell>{row.name}</Table.Cell>
                <Table.Cell>{row.detail ?? row.description ?? '—'}</Table.Cell>
                <Table.Cell>
                  {row.builtIn ? (
                    <Badge tone="neutral">built-in</Badge>
                  ) : row.enabled === false ? (
                    <Badge tone="warning">disabled</Badge>
                  ) : (
                    <Badge tone="success">enabled</Badge>
                  )}
                </Table.Cell>
                <Table.Cell numeric>
                  {!row.builtIn && canWrite ? (
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void openEdit(row, listingState.kind, listingState.query)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void remove(row, listingState.kind, listingState.query)}
                      >
                        Delete
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void openEdit(row, listingState.kind, listingState.query)}
                    >
                      View
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
      {listing?.truncated ? (
        <span style={{ fontSize: 11, color: 'var(--nd-text-muted)' }}>
          list truncated at the per-kind cap — refine the search to find a specific object
        </span>
      ) : null}

      <Drawer
        open={drawerMode !== null}
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
        width="md"
        title={
          drawerMode === 'create'
            ? `New ${SSE_OBJECT_KIND_LABELS[activeDrawerKind]}`
            : `${drawerBuiltIn || !canWrite ? 'View' : 'Edit'} ${SSE_OBJECT_KIND_LABELS[activeDrawerKind]}`
        }
        description={
          drawerBuiltIn
            ? 'Built-in / system-defined object — read only.'
            : `${lab ? 'This direct write applies immediately.' : 'Review the change before it applies.'} Commit is tenant-wide and may include other staged tenant changes; a failed commit stages this change for a safe retry.`
        }
      >
        {drawerLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
            <Spinner size="sm" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <FormField label={primaryLabel}>
              <Input
                value={form.primaryName}
                disabled={drawerBuiltIn || !canWrite}
                onChange={(e) => {
                  setForm((f) => ({ ...f, primaryName: e.target.value }));
                  setReviewed(false);
                }}
              />
            </FormField>
            <FormField label="Description — optional">
              <Input
                value={form.description}
                disabled={drawerBuiltIn || !canWrite}
                onChange={(e) => {
                  setForm((f) => ({ ...f, description: e.target.value }));
                  setReviewed(false);
                }}
              />
            </FormField>
            <Checkbox
              label="Enabled"
              checked={form.enabled}
              disabled={drawerBuiltIn || !canWrite}
              onChange={(e) => {
                setForm((f) => ({ ...f, enabled: e.target.checked }));
                setReviewed(false);
              }}
            />
            <FormField
              label="Additional fields (JSON)"
              help={`Everything the SSE Admin API models for a ${activeDrawerKind} beyond ${primaryLabel.toLowerCase()}/description/enabled — passwords/PSKs are write-only and never round-trip here.`}
            >
              <Textarea
                mono
                rows={8}
                value={form.extraJson}
                disabled={drawerBuiltIn || !canWrite}
                onChange={(e) => {
                  setForm((f) => ({ ...f, extraJson: e.target.value, extraError: null }));
                  setReviewed(false);
                }}
              />
            </FormField>
            {form.extraError ? <span style={{ color: 'var(--nd-danger)', fontSize: 12 }}>{form.extraError}</span> : null}

            {!drawerBuiltIn && canWrite ? (
              <>
                {!lab ? <Checkbox
                  label={`I have reviewed this ${drawerMode === 'create' ? 'create' : 'update'} and confirm it should apply now. The following tenant-wide Commit may include other staged tenant changes.`}
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                /> : null}
                <Button variant="primary" disabled={(!lab && !reviewed) || applying} onClick={() => void submit()}>
                  {applying ? 'Applying…' : drawerMode === 'create' ? 'Create and commit' : 'Save and commit'}
                </Button>
              </>
            ) : null}
          </div>
        )}
      </Drawer>
    </div>
  );
}
