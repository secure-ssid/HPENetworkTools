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
 * Share/export polish: `sseKind`/`sseQ` query params, Copy view link (Systems
 * deep-link), client Export CSV of the filtered summary rows, and server
 * Download CSV via GET /api/sse/objects/:kind/export — never vendor `raw`.
 * Multi-select raises **Export selected**, **Copy IDs** (unique newline-joined
 * object ids), **Copy names** (unique newline-joined object names when ids alone
 * are sparse for a handoff — Devices pattern; Loop 229), **Copy selection link**
 * (`?sseIds=` of marked ids with kind/q; clearable chip while active — Loop 183),
 * and Clear. Toolbar `KeyboardShortcuts` surfaces the object inventory grid map
 * (Loop 201). Filtered empties offer **Clear selection filter** / **Clear search**.
 *
 * `canWrite` is the plane's declared write scope (PlaneCapabilities.
 * directWrite, read off GET /api/systems/state) — every mutating control is
 * hidden without it, never merely disabled-and-clickable, and a builtIn
 * (vendor system-defined) row never shows mutation controls regardless.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ConfirmDialog,
  Badge,
  Button,
  Checkbox,
  DataTable,
  DATATABLE_ROW_SHORTCUTS,
  Drawer,
  EmptyState,
  FormField,
  Input,
  KeyboardShortcuts,
  SectionHeader,
  Select,
  Skeleton,
  Textarea,
  useToast,
  type DataTableColumn,
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
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { namesFilterForParam } from '../app/nav';
import { useLabConfigMode } from '../hooks/useLabConfigMode';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import {
  countOf,
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

const SSE_CSV_HEADERS = ['kind', 'id', 'name', 'description', 'enabled', 'builtIn', 'detail'] as const;

function parseSseKindParam(raw: string | null, fallback: SseObjectKind): SseObjectKind {
  if (raw && (SSE_OBJECT_KINDS as readonly string[]).includes(raw)) return raw as SseObjectKind;
  return fallback;
}

/** Shareable Systems deep-link with the current kind/search filters. */
function buildSseViewLink(kind: SseObjectKind, q: string, ids?: readonly string[]): string {
  const next = new URLSearchParams();
  next.set('plane', 'sse');
  next.set('sseKind', kind);
  if (q.trim()) next.set('sseQ', q.trim());
  if (ids && ids.length > 0) next.set('sseIds', ids.join('\n'));
  return `${window.location.origin}/systems?${next.toString()}`;
}

function sseSummaryCsvRows(rows: SseObjectSummary[]): Array<Array<unknown>> {
  return rows.map((r) => [
    r.kind,
    r.id,
    r.name,
    r.description ?? '',
    r.enabled === undefined ? '' : r.enabled ? 'true' : 'false',
    r.builtIn === true ? 'true' : r.builtIn === false ? 'false' : '',
    r.detail ?? '',
  ]);
}

function sseInventoryColumns(opts: {
  canWrite: boolean;
  onEdit: (row: SseObjectSummary) => void;
  onDelete: (row: SseObjectSummary) => void;
}): Array<DataTableColumn<SseObjectSummary>> {
  const { canWrite, onEdit, onDelete } = opts;
  return [
    {
      key: 'name',
      title: 'Name',
      hideable: false,
      sortValue: (row) => row.name,
      render: (row) => row.name,
    },
    {
      key: 'detail',
      title: 'Detail',
      sortValue: (row) => row.detail ?? row.description ?? '',
      render: (row) => row.detail ?? row.description ?? '—',
    },
    {
      key: 'state',
      title: 'State',
      sortValue: (row) => (row.builtIn ? 'built-in' : row.enabled === false ? 'disabled' : 'enabled'),
      render: (row) =>
        row.builtIn ? (
          <Badge tone="neutral">built-in</Badge>
        ) : row.enabled === false ? (
          <Badge tone="warning">disabled</Badge>
        ) : (
          <Badge tone="success">enabled</Badge>
        ),
    },
    {
      key: 'actions',
      title: 'Actions',
      numeric: true,
      render: (row) =>
        !row.builtIn && canWrite ? (
          <div className="nt-end-gap-6">
            <Button size="sm" variant="ghost" onClick={() => onEdit(row)}>
              Edit
            </Button>
            <Button size="sm" variant="danger" onClick={() => onDelete(row)}>
              Delete
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => onEdit(row)}>
            View
          </Button>
        ),
    },
  ];
}

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
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingDelete, setPendingDelete] = useState<null | { row: SseObjectSummary; rowKind: SseObjectKind; query: string }>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const seededKind = parseSseKindParam(searchParams.get('sseKind'), initialKind);
  const seededQuery = searchParams.get('sseQ') ?? '';
  const [kind, setKind] = useState<SseObjectKind>(seededKind);
  const [q, setQ] = useState(seededQuery);
  /* Keyboard multi-select (x toggles focused row) raises Export selected /
   * Copy IDs / Copy names / Copy selection link. */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /systems?plane=sse&sseIds=a\nb (bulk Copy selection link). */
  const idsFilter = namesFilterForParam(searchParams.get('sseIds'));
  const [listingState, setListingState] = useState<ListingState>({
    kind: seededKind,
    query: seededQuery,
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

  const syncFilterParams = (nextKind: SseObjectKind, nextQuery: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('sseKind', nextKind);
    if (nextQuery.trim()) next.set('sseQ', nextQuery.trim());
    else next.delete('sseQ');
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  };

  const selectKind = (nextKind: SseObjectKind) => {
    setKind(nextKind);
    syncFilterParams(nextKind, q);
  };

  const search = async () => {
    syncFilterParams(kind, q);
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

  const remove = (row: SseObjectSummary, rowKind: SseObjectKind, query: string) => {
    setPendingDelete({ row, rowKind, query });
  };

  const confirmRemove = async () => {
    if (!pendingDelete) return;
    const { row, rowKind, query } = pendingDelete;
    setDeleteBusy(true);
    try {
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
    } finally {
      setDeleteBusy(false);
      setPendingDelete(null);
    }
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
  const allRows = useMemo(() => listing?.rows ?? [], [listing]);
  const rows = useMemo(() => {
    if (idsFilter === null) return allRows;
    return allRows.filter((r) => idsFilter.includes(r.id));
  }, [allRows, idsFilter]);
  const idsPresent =
    idsFilter === null ? 0 : idsFilter.filter((id) => allRows.some((r) => r.id === id)).length;
  /* Drop bulk marks that left the filtered list (kind/search change). */
  const [prevRowKeys, setPrevRowKeys] = useState<string>('');
  const rowKeySig = allRows.map((r) => r.id).join('\n');
  if (prevRowKeys !== rowKeySig) {
    setPrevRowKeys(rowKeySig);
    const keep = new Set(allRows.map((r) => r.id));
    const pruned = selectedKeys.filter((k) => keep.has(k));
    if (pruned.length !== selectedKeys.length) setSelectedKeys(pruned);
  }
  const failure = readFailure(SSE_OBJECT_KIND_LABELS[kind], listing);

  const exportFilteredCsv = () => {
    const n = exportTableCsv(`sse-${kind}.csv`, [...SSE_CSV_HEADERS], sseSummaryCsvRows(rows));
    toast(n === 0 ? 'No results to export' : `Exported ${n} object${n === 1 ? '' : 's'}`, {
      description:
        n === 0
          ? 'The current filtered list is empty.'
          : `sse-${kind}.csv — summary fields for rows currently in view (no raw bodies).`,
      tone: n === 0 ? 'warning' : 'success',
    });
  };

  const downloadServerCsv = () => {
    void (async () => {
      const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
      const res = await downloadApiCsv(
        `/api/sse/objects/${encodeURIComponent(kind)}/export${qs}`,
        `sse-${kind}.csv`,
      );
      if (res.ok) {
        toast('Server CSV downloaded', {
          description: `sse-${kind}.csv — cached inventory export (summary fields only).`,
          tone: 'success',
        });
      } else {
        toast('Server CSV failed', {
          description: res.error ?? 'Could not download export',
          tone: 'warning',
        });
      }
    })();
  };

  const copyViewLink = () => {
    void (async () => {
      const url = buildSseViewLink(kind, q);
      try {
        await navigator.clipboard.writeText(url);
        toast('View link copied', {
          description: [kind, q.trim() ? `q=${q.trim()}` : null].filter(Boolean).join(' · '),
          tone: 'success',
        });
      } catch {
        toast('Could not copy link', { description: url, tone: 'warning' });
      }
    })();
  };

  return (
    <div className="nt-stack nt-gap-12 nt-recon-reveal nt-sse-shell nt-section-panel">
      <div className="nt-plane-theater" role="note">NightDesk · SSE inventory · brokered estate slice</div>
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

      <VisualReferencePanel
        target={{ kind: 'connector', id: 'sse', plane: 'SSE' }}
        editable={false}
      />

      <div
        className="nt-warn-box"
      >
        <strong>Commit is tenant-wide.</strong> It may apply other changes already staged on this SSE tenant, not only
        the change being applied here.
      </div>

      {commitWarning ? (
        <div className="nt-warn-text-125">
          <strong>Commit warning:</strong> {commitWarning}
        </div>
      ) : null}

      {cacheRefresh ? (
        <div
          className={cacheRefresh.status === 'refreshed' && !mutationUnverified ? 'nt-sse-banner nt-border-success' : 'nt-sse-banner nt-border-warning'}
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
          className="nt-warn-box nt-stack-8"
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

      <div className="nt-end-wrap-10">
        <FormField label="Object kind">
          <Select
            size="sm"
            options={KIND_OPTIONS}
            value={kind}
            onValueChange={(v) => selectKind(v as SseObjectKind)}
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
        <Button size="sm" variant="ghost" onClick={copyViewLink}>
          Copy view link
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={exportFilteredCsv}
          disabled={loading || Boolean(failure)}
        >
          Export CSV
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={downloadServerCsv}
          disabled={loading || Boolean(failure)}
        >
          Download server CSV
        </Button>
        {canWrite ? (
          <Button size="sm" variant="primary" onClick={openCreate}>
            New {SSE_OBJECT_KIND_LABELS[kind].replace(/s$/, '')}
          </Button>
        ) : null}
        {/* Object inventory multi-select is a keyboard grid (j/k/x/Esc) — surface the map (Loop 201). */}
        <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
      </div>

      {idsFilter !== null && !loading && !failure ? (
        <div className="nt-chip-row" role="group" aria-label="Selection deep link">
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('sseIds');
              setSearchParams(next, { replace: true });
              setSelectedKeys([]);
            }}
            title={idsFilter.join(', ')}
            className="nt-chip nt-chip--active"
          >
            {idsPresent === idsFilter.length
              ? `${idsFilter.length} selected object${idsFilter.length === 1 ? '' : 's'}`
              : `${idsPresent} of ${idsFilter.length} selected objects present`}
            {' — clear'}
          </button>
        </div>
      ) : null}
      {loading ? (
        <div className="nt-center-pad-24" role="status" aria-label="Loading inventory">
          <div className="nt-stack nt-gap-6">
            <Skeleton height={12} width="34%" />
            <Skeleton height={28} />
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        </div>
      ) : failure ? (
        <EmptyState {...failure} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            idsFilter !== null
              ? 'No selected objects in this kind'
              : `No ${SSE_OBJECT_KIND_LABELS[kind].toLowerCase()}`
          }
          description={
            idsFilter !== null
              ? 'Clear the selection chip to restore the full kind list.'
              : q
                ? 'No rows match the search.'
                : 'The plane reports none of this kind.'
          }
        >
          {idsFilter !== null ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('sseIds');
                setSearchParams(next, { replace: true });
              }}
            >
              Clear selection filter
            </Button>
          ) : q ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setQ('');
                const next = new URLSearchParams(searchParams);
                next.delete('sseQ');
                setSearchParams(next, { replace: true });
              }}
            >
              Clear search
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <DataTable
          ariaLabel={`${SSE_OBJECT_KIND_LABELS[kind]} inventory`}
          density="compact"
          columns={sseInventoryColumns({
            canWrite,
            onEdit: (row) => void openEdit(row, listingState.kind, listingState.query),
            onDelete: (row) => void remove(row, listingState.kind, listingState.query),
          })}
          rows={rows}
          rowKey={(row) => row.id}
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
        />
      )}
      {selectedKeys.length > 0 ? (
        <div
          className="nt-configure-bulk-bar nt-bulk-glass"
          role="region"
          aria-label="SSE object selection actions"
        >
          <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
          <span className="nt-configure-bulk-bar__hint">
            export, copy ids/names, or share a selection link for only the objects you marked — full list export stays in the header
          </span>
          <span className="nt-configure-bulk-bar__actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const selected = new Set(selectedKeys);
                const picked = rows.filter((r) => selected.has(r.id));
                if (picked.length === 0) {
                  toast('No selected objects still in view', {
                    description: 'Clear selection or adjust filters.',
                    tone: 'info',
                  });
                  return;
                }
                const n = exportTableCsv(
                  `sse-${kind}-selected.csv`,
                  [...SSE_CSV_HEADERS],
                  sseSummaryCsvRows(picked),
                );
                toast(`Exported ${countOf(n, 'selected object')}`, {
                  description: `sse-${kind}-selected.csv — summary fields only (no raw bodies).`,
                  tone: 'success',
                });
              }}
            >
              Export selected
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const selected = new Set(selectedKeys);
                  const picked = rows.filter((r) => selected.has(r.id));
                  if (picked.length === 0) {
                    toast('No selected objects still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const ids = [
                    ...new Set(
                      picked
                        .map((r) => (r.id ?? '').trim())
                        .filter((id) => id.length > 0),
                    ),
                  ];
                  if (ids.length === 0) {
                    toast('No ids on the selected objects', {
                      description: 'Use Copy names or export CSV instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const text = ids.join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    toast(`Copied ${countOf(ids.length, 'id')}`, {
                      description:
                        ids.length < picked.length
                          ? `${picked.length - ids.length} selected without an id skipped`
                          : 'newline-joined · paste into a ticket or change window',
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy ids', { description: text, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy IDs
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const selected = new Set(selectedKeys);
                  const picked = rows.filter((r) => selected.has(r.id));
                  if (picked.length === 0) {
                    toast('No selected objects still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const names = [
                    ...new Set(
                      picked
                        .map((r) => (r.name ?? '').trim())
                        .filter((name) => name && name !== '—'),
                    ),
                  ];
                  if (names.length === 0) {
                    toast('No names on the selected objects', {
                      description: 'Those rows did not publish a name — export CSV instead.',
                      tone: 'info',
                    });
                    return;
                  }
                  const text = names.join('\n');
                  try {
                    await navigator.clipboard.writeText(text);
                    toast(`Copied ${countOf(names.length, 'name')}`, {
                      description:
                        names.length < picked.length
                          ? `${picked.length - names.length} selected without a name skipped`
                          : 'newline-joined · paste into a ticket or change window',
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy names', { description: text, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy names
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const selected = new Set(selectedKeys);
                  const picked = rows.filter((r) => selected.has(r.id));
                  if (picked.length === 0) {
                    toast('No selected objects still in view', {
                      description: 'Clear selection or adjust filters.',
                      tone: 'info',
                    });
                    return;
                  }
                  const ids = picked.map((r) => r.id);
                  const url = buildSseViewLink(kind, q, ids);
                  try {
                    await navigator.clipboard.writeText(url);
                    /* Keep the share params in the address bar so the chip appears. */
                    const next = new URLSearchParams(searchParams);
                    next.set('plane', 'sse');
                    next.set('sseKind', kind);
                    if (q.trim()) next.set('sseQ', q.trim());
                    else next.delete('sseQ');
                    next.set('sseIds', ids.join('\n'));
                    setSearchParams(next, { replace: true });
                    toast('Selection link copied', {
                      description: `${ids.length} object${ids.length === 1 ? '' : 's'} · sseIds=`,
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy link', { description: url, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy selection link
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
              Clear
            </Button>
          </span>
        </div>
      ) : null}
      {listing?.truncated ? (
        <span className="nt-fs-11-muted">
          list truncated at the per-kind cap — refine the search to find a specific object
        </span>
      ) : null}

      <Drawer
        open={drawerMode !== null}
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
        width="md"
        className={
          drawerMode === 'create' || (drawerMode === 'edit' && canWrite && !drawerBuiltIn)
            ? 'nd-drawer--write-ritual nt-write-ritual'
            : undefined
        }
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
        {drawerMode === 'create' || (drawerMode === 'edit' && canWrite && !drawerBuiltIn) ? (
          <div className="nt-write-ritual nt-write-ritual--banner" aria-hidden />
        ) : null}
        {drawerLoading ? (
          <div className="nt-center-pad-32" role="status" aria-label="Loading object">
            <div className="nt-stack nt-gap-6">
              <Skeleton height={12} width="40%" />
              <Skeleton height={28} />
              <Skeleton height={28} />
            </div>
          </div>
        ) : (
          <div className="nt-stack nt-gap-14">
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
            {form.extraError ? <span className="nt-danger-text-12">{form.extraError}</span> : null}

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
      <ConfirmDialog
        open={pendingDelete != null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={pendingDelete ? `Delete ${pendingDelete.row.name}?` : 'Delete object?'}
        description="The deletion will be staged and becomes effective only after SSE Commit is accepted. Commit is tenant-wide and may include other staged tenant changes. It is not reversible from here once committed."
        confirmLabel="Delete"
        tone="danger"
        busy={deleteBusy}
        onConfirm={confirmRemove}
      />

    </div>
  );
}
