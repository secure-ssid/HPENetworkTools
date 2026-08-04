/**
 * web/src/screens/CentralWebhooksPanel.tsx — New Central webhook management,
 * embedded in the Systems screen's Configuration tab for the `central` plane.
 *
 * Create and HMAC rotation require an exact review confirmation plus a
 * second acknowledgement that Central's returned HMAC key is one-time and
 * must be copied immediately. The key is held only in an ephemeral ref while
 * a dedicated modal is open, masked by default, and cleared on
 * close/navigation/unmount. It never enters list, detail, toast, settings,
 * storage, or generic mutation state.
 *
 * SECRETS: apiKey / oidcClientSecret are never held in this component's
 * state after submit — the edit form only ever WRITES them (see
 * shared/webhooks.ts's file header); nothing here reads one back from a
 * server response.
 *
 * OPTIMISTIC CONCURRENCY: every edit review is built from a specific
 * `generation`; the PATCH itself carries that `expectedGeneration`
 * (updateCentralWebhook). A conflict response refetches the current detail,
 * invalidates the stale review, and shows the new diff — the operator never
 * silently overwrites a change they never saw.
 *
 * UNKNOWN MUTATION OUTCOMES: a transport failure or a 502 "the outcome is
 * unknown" answer on any mutation means Central may or may not have applied
 * the change. Create performs a complete unfiltered identity lookup and
 * requires an explicit absence attestation; rotation requires two dedicated
 * reconciliation attestations because detail GET cannot establish the key.
 * The server's secret-free durable handoff journal survives drawer close,
 * navigation, unmount, and restart. This panel reloads it and never retries a
 * create/rotation automatically.
 *
 * Create/rotate use the same reviewed one-time secure handoff in normal live
 * operation and are not gated by demo or config modes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  EmptyState,
  FormField,
  Input,
  Pagination,
  SectionHeader,
  Select,
  Spinner,
  Table,
  useToast,
} from '../nightdesk';
import { DiffCode } from '../lib/DiffCode';
import { useLabConfigMode } from '../hooks/useLabConfigMode';
import {
  acknowledgeCentralWebhookHandoff,
  apiFetch,
  createCentralWebhook,
  deleteCentralWebhook,
  getCentralWebhook,
  getCentralWebhookHandoffStatus,
  getCentralWebhooks,
  isApiError,
  isUnknownWebhookOutcome,
  isWebhookGenerationConflict,
  rotateCentralWebhookHmacKey,
  resolveCentralWebhookHandoff,
  serverMessage,
  updateCentralWebhook,
  type ApiResult,
} from '../api/client';
import {
  WEBHOOK_AUTH_OPTIONS,
  WEBHOOK_LIST_MAX_LIMIT,
  buildWebhookReviewDiff,
  canonicalizeWebhookCreateForm,
  canonicalWebhookCreateCandidate,
  isCreateFormComplete,
  matchesCanonicalWebhookCreateCandidate,
  validateWebhookForm,
  webhookTargetUrl,
  type CanonicalWebhookCreateCandidate,
  type Sev,
  type WebhookAuthMechanism,
  type WebhookDetail,
  type WebhookEventsEnvelope,
  type WebhookForm,
  type WebhookHandoffOperation,
  type WebhookListEnvelope,
  type WebhookOneTimeSecretResult,
  type WebhookReceivedEvent,
  type WebhookReceiverSource,
  type WebhookReceiverStatusEnvelope,
  type WebhookSummary,
} from '@hpe/shared';

type DrawerMode = 'create' | 'edit' | 'delete' | 'rotate' | null;

const PAGE_SIZE = 10;

interface PendingCreateReconciliation {
  operationId: string;
  candidate: CanonicalWebhookCreateCandidate;
  state: WebhookHandoffOperation['state'];
  fingerprintMatches: boolean;
  lookup: 'required' | 'absent' | 'found';
  absenceAttested: boolean;
  locatedAttested: boolean;
  checkedAt?: string;
  matchedWebhookId?: string;
}

interface PendingRotateReconciliation {
  operationId: string;
  webhookId: string;
  state: WebhookHandoffOperation['state'];
  fingerprintMatches: boolean;
  detailChecked: boolean;
  receiverAttested: boolean;
  centralAttested: boolean;
  checkedAt?: string;
}

interface PendingReconciliations {
  create: PendingCreateReconciliation | null;
  rotations: PendingRotateReconciliation[];
}

const EMPTY_RECONCILIATIONS: PendingReconciliations = { create: null, rotations: [] };

function createCandidateForm(candidate: CanonicalWebhookCreateCandidate): WebhookForm {
  return {
    ...emptyForm(),
    name: candidate.name,
    endpoint: candidate.endpoint,
    authMechanism: candidate.authMechanism,
    ...(candidate.authMechanism === 'OIDC'
      ? {
          oidcClientId: candidate.oidcClientId ?? '',
          oidcWellKnownUrl: candidate.oidcWellKnownUrl ?? '',
          oidcClientSecret: '',
        }
      : {}),
  };
}

function matchesCreateCandidateBase(
  row: WebhookSummary,
  candidate: CanonicalWebhookCreateCandidate,
): boolean {
  return (
    row.name.trim() === candidate.name &&
    row.endpoint.trim() === candidate.endpoint &&
    row.authMechanism === candidate.authMechanism
  );
}

function emptyForm(): WebhookForm {
  return { name: '', endpoint: '', authMechanism: 'API_KEY', apiKey: '', allowInsecureCallback: false };
}

function formFromDetail(detail: WebhookDetail): WebhookForm {
  return {
    name: detail.name,
    endpoint: detail.endpoint,
    authMechanism: detail.authMechanism,
    apiKey: '',
    oidcClientId: detail.oidcClientId ?? '',
    oidcClientSecret: '',
    oidcWellKnownUrl: detail.oidcWellKnownUrl ?? '',
    allowInsecureCallback: false,
  };
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

// ---------------------------------------------------------------------------
// Inbound receiver calls — /api/hooks/* (this panel is their only surface,
// so the helpers live here rather than in the shared api modules). Same
// rules as the management calls above: a non-OK answer yields the server's
// own message, an unreachable backend yields `offline` — never a fabricated
// empty state.
// ---------------------------------------------------------------------------

const RECEIVER_EVENTS_PAGE = 25;

async function getWebhookReceivers(): Promise<ApiResult<WebhookReceiverStatusEnvelope>> {
  try {
    const r = await apiFetch('/api/hooks/receivers');
    if (r.ok) return (await r.json()) as WebhookReceiverStatusEnvelope;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

async function getWebhookEvents(): Promise<ApiResult<WebhookEventsEnvelope>> {
  try {
    const r = await apiFetch(`/api/hooks/events?limit=${RECEIVER_EVENTS_PAGE}`);
    if (r.ok) return (await r.json()) as WebhookEventsEnvelope;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

async function simulateWebhookEvent(
  source: WebhookReceiverSource,
): Promise<ApiResult<{ accepted: number; demo: boolean }>> {
  try {
    const r = await apiFetch('/api/hooks/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    if (r.ok) return (await r.json()) as { accepted: number; demo: boolean };
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

const RECEIVER_SEV_TONE: Record<Sev, 'danger' | 'warning' | 'info'> = {
  P1: 'danger',
  P2: 'warning',
  P3: 'info',
};

export function CentralWebhooksPanel() {
  const { toast } = useToast();
  const { lab } = useLabConfigMode();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState<WebhookListEnvelope | null>(null);
  const canWrite = listing?.canWrite === true;
  // The mount effect reads the list immediately, so the panel mounts into the
  // spinner rather than flashing a "No webhooks" empty state for one frame.
  const [loading, setLoading] = useState(true);

  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null);
  const [drawerRow, setDrawerRow] = useState<WebhookSummary | null>(null);
  const [existing, setExisting] = useState<WebhookDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [form, setForm] = useState<WebhookForm>(emptyForm());
  const [reviewed, setReviewed] = useState(false);
  const [reviewedTenantBinding, setReviewedTenantBinding] = useState<string | null>(null);
  const [oneTimeAcknowledged, setOneTimeAcknowledged] = useState(false);
  const [applying, setApplying] = useState(false);
  /** Set when any mutation has an unknown outcome, including a create/rotate
   * HTTP 200 whose one-time HMAC key was unavailable. The operator must
   * explicitly refetch/reconcile before mutation controls return. */
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  /** Only non-secret operation identity and operator attestations are
   * held here. The authoritative operation survives in the server journal;
   * form credentials and one-time HMAC keys never enter this state. */
  const [pendingReconciliations, setPendingReconciliations] =
    useState<PendingReconciliations>(EMPTY_RECONCILIATIONS);
  const [handoffStatusError, setHandoffStatusError] = useState<string | null>(null);

  /** RACE SAFETY: `activeRequestRef` identifies which webhook drawer is
   *  currently "live" — a `{ id, seq }` pair, where `seq` is a monotonic
   *  counter bumped every time a new drawer (edit or delete) opens. Any
   *  async detail fetch/PATCH/DELETE captures this token when it starts;
   *  before applying its result to state, it checks the token is still the
   *  live one. This is deliberately independent of the webhook's own
   *  `generation` field (optimistic-concurrency data from the server) —
   *  two different webhooks can share the same business `generation`
   *  number, so only our internal, session-local `seq` (paired with the
   *  webhook `id`) can safely tell "this response belongs to the drawer
   *  that's actually open right now" apart from a stale one. Closing the
   *  drawer clears the token so nothing in flight can land afterward, and
   *  `mountedRef` blocks updates after unmount. */
  const requestSeqRef = useRef(0);
  const activeRequestRef = useRef<{ id: string; seq: number } | null>(null);
  const mountedRef = useRef(true);
  const listRequestSeqRef = useRef(0);
  const handoffRequestSeqRef = useRef(0);
  const oneTimeSecretRef = useRef<string | null>(null);
  /* The same secret, mirrored in state for the render path — the ref stays
     for the post-await staleness checks in copyOneTimeSecret (a clipboard
     write that outlives the modal must not report success), and rendering
     reads this committed copy instead of the ref. */
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [oneTimeSecretOpen, setOneTimeSecretOpen] = useState(false);
  const [oneTimeSecretAction, setOneTimeSecretAction] =
    useState<WebhookOneTimeSecretResult['action'] | null>(null);
  const [oneTimeOperationId, setOneTimeOperationId] = useState<string | null>(null);
  const [oneTimeSecretRevealed, setOneTimeSecretRevealed] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [secretStored, setSecretStored] = useState(false);
  const [handoffApplying, setHandoffApplying] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestRef.current = null;
      oneTimeSecretRef.current = null;
    };
  }, []);

  const applyPendingHandoff = (operation: WebhookHandoffOperation | null) => {
    if (!operation) {
      setPendingReconciliations(EMPTY_RECONCILIATIONS);
      return;
    }
    if (operation.opType === 'create' && operation.candidate) {
      setPendingReconciliations({
        create: {
          operationId: operation.operationId,
          candidate: operation.candidate,
          state: operation.state,
          fingerprintMatches: operation.fingerprintMatches,
          lookup: 'required',
          absenceAttested: false,
          locatedAttested: false,
        },
        rotations: [],
      });
      return;
    }
    if (operation.opType === 'rotate' && operation.webhookId) {
      setPendingReconciliations({
        create: null,
        rotations: [{
          operationId: operation.operationId,
          webhookId: operation.webhookId,
          state: operation.state,
          fingerprintMatches: operation.fingerprintMatches,
          detailChecked: false,
          receiverAttested: false,
          centralAttested: false,
        }],
      });
    }
  };

  const loadPendingHandoff = (): Promise<void> => {
    const seq = ++handoffRequestSeqRef.current;
    return getCentralWebhookHandoffStatus().then((result) => {
      if (!mountedRef.current || seq !== handoffRequestSeqRef.current) return;
      if (isApiError(result)) {
        setHandoffStatusError(result.error);
        return;
      }
      setHandoffStatusError(null);
      applyPendingHandoff(result.pending ? (result.operation ?? null) : null);
    });
  };

  const beginDrawerRequest = (id: string): { id: string; seq: number } => {
    const token = { id, seq: ++requestSeqRef.current };
    activeRequestRef.current = token;
    return token;
  };

  const isActiveDrawerRequest = (token: { id: string; seq: number }) =>
    mountedRef.current &&
    activeRequestRef.current !== null &&
    activeRequestRef.current.id === token.id &&
    activeRequestRef.current.seq === token.seq;

  const fetchList = async (nextQ = q, nextPage = page): Promise<WebhookListEnvelope | null> => {
    const seq = ++listRequestSeqRef.current;
    const result = await getCentralWebhooks({ limit: PAGE_SIZE, offset: (nextPage - 1) * PAGE_SIZE, q: nextQ.trim() });
    // A newer load (search, pagination, or a post-mutation refresh) may
    // have started and already resolved while this one was in flight —
    // never let an older response clobber a fresher listing.
    if (!mountedRef.current || seq !== listRequestSeqRef.current) return null;
    setListing(result);
    setLoading(false);
    return result;
  };

  const load = async (nextQ = q, nextPage = page): Promise<WebhookListEnvelope | null> => {
    setLoading(true);
    return fetchList(nextQ, nextPage);
  };

  /* Turning a page swaps the table for the spinner at once (adjusted during
     render — an effect would commit one frame of the old page's rows under
     the new page number first); the read itself stays an effect. */
  const [prevPage, setPrevPage] = useState(page);
  if (prevPage !== page) {
    setPrevPage(page);
    setLoading(true);
  }

  useEffect(() => {
    void fetchList(q, page);
    void loadPendingHandoff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // -- Inbound receivers ---------------------------------------------------
  // Receiver status and the recent-events record load once on mount and
  // after every simulate; they are this portal's own received data, so they
  // render in demo and live mode alike.
  const [receivers, setReceivers] = useState<WebhookReceiverStatusEnvelope | null>(null);
  const [receiverEvents, setReceiverEvents] = useState<WebhookReceivedEvent[] | null>(null);
  const [receiverEventsNote, setReceiverEventsNote] = useState<string | null>(null);
  const [receiverError, setReceiverError] = useState<string | null>(null);
  const [simulating, setSimulating] = useState<WebhookReceiverSource | null>(null);
  const receiverRequestSeqRef = useRef(0);

  const loadReceivers = (): Promise<void> => {
    const seq = ++receiverRequestSeqRef.current;
    return Promise.all([getWebhookReceivers(), getWebhookEvents()]).then(([statusResult, eventsResult]) => {
      if (!mountedRef.current || seq !== receiverRequestSeqRef.current) return;
      if (isApiError(statusResult)) {
        setReceiverError(statusResult.error);
        setReceivers(null);
      } else {
        setReceiverError(null);
        setReceivers(statusResult);
      }
      if (isApiError(eventsResult)) {
        setReceiverEvents([]);
        setReceiverEventsNote(eventsResult.error);
      } else {
        setReceiverEvents(eventsResult.events);
        setReceiverEventsNote(eventsResult.note ?? null);
      }
    });
  };

  useEffect(() => {
    void loadReceivers();
  }, []);

  const simulate = async (source: WebhookReceiverSource): Promise<void> => {
    setSimulating(source);
    const result = await simulateWebhookEvent(source);
    if (!mountedRef.current) return;
    setSimulating(null);
    if (isApiError(result)) {
      toast(`Demo event failed: ${result.error}`, { tone: 'danger' });
    } else {
      toast(`Demo ${source} event accepted through the signed receiver path`, { tone: 'success' });
    }
    void loadReceivers();
  };

  const totalPages = listing ? Math.max(1, Math.ceil(listing.totalCount / PAGE_SIZE)) : 1;

  const closeDrawer = () => {
    // Drop the live token first — any detail/PATCH/DELETE response still in
    // flight for the drawer being closed will find no match and discard
    // itself instead of populating whatever opens next.
    activeRequestRef.current = null;
    setDrawerMode(null);
    setDrawerRow(null);
    setExisting(null);
    setDrawerLoading(false);
    setDrawerError(null);
    setReviewed(false);
    setOneTimeAcknowledged(false);
    setOutcomeUnknown(false);
    setApplying(false);
    setForm(emptyForm());
  };

  const clearOneTimeSecret = () => {
    oneTimeSecretRef.current = null;
    setOneTimeSecret(null);
    setOneTimeSecretOpen(false);
    setOneTimeSecretAction(null);
    setOneTimeOperationId(null);
    setOneTimeSecretRevealed(false);
    setCopyStatus(null);
    setSecretStored(false);
  };

  const showOneTimeSecret = (result: WebhookOneTimeSecretResult) => {
    oneTimeSecretRef.current = result.hmacKey;
    setOneTimeSecret(result.hmacKey);
    setOneTimeSecretAction(result.action);
    setOneTimeOperationId(result.operationId);
    setOneTimeSecretRevealed(false);
    setCopyStatus(null);
    setSecretStored(false);
    setOneTimeSecretOpen(true);
  };

  const copyOneTimeSecret = async () => {
    const secret = oneTimeSecretRef.current;
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      if (mountedRef.current && oneTimeSecretRef.current === secret) setCopyStatus('Copied to clipboard.');
    } catch {
      if (mountedRef.current && oneTimeSecretRef.current === secret) {
        setCopyStatus('Clipboard access failed. Reveal and copy the key manually now.');
      }
    }
  };

  const acknowledgeStoredSecret = async () => {
    if (!oneTimeOperationId || !secretStored) return;
    setHandoffApplying(true);
    const result = await acknowledgeCentralWebhookHandoff(oneTimeOperationId, true);
    if (!mountedRef.current) return;
    setHandoffApplying(false);
    if (isApiError(result)) {
      setCopyStatus(`Handoff acknowledgement failed: ${result.error}. Keep this panel open and retry.`);
      return;
    }
    handoffRequestSeqRef.current += 1;
    applyPendingHandoff(null);
    clearOneTimeSecret();
  };

  const openCreate = () => {
    const pending = pendingReconciliations.create;
    beginDrawerRequest('__create__');
    setDrawerMode('create');
    setDrawerRow(null);
    setExisting(null);
    setForm(pending ? createCandidateForm(pending.candidate) : emptyForm());
    setReviewed(false);
    setOneTimeAcknowledged(false);
    setDrawerError(
      pending
        ? 'This exact create has an unresolved outcome. Reconcile it before any new create request.'
        : null,
    );
    setOutcomeUnknown(pending !== null);
  };

  const openEdit = async (row: WebhookSummary) => {
    const token = beginDrawerRequest(row.id);
    setDrawerMode('edit');
    setDrawerRow(row);
    setReviewed(false);
    setOneTimeAcknowledged(false);
    setDrawerError(null);
    setOutcomeUnknown(false);
    setDrawerLoading(true);
    const result = await getCentralWebhook(row.id);
    if (!isActiveDrawerRequest(token)) return;
    setDrawerLoading(false);
    if (isApiError(result)) {
      setDrawerError(result.error);
      setExisting(null);
      setForm({ ...emptyForm(), name: row.name, endpoint: row.endpoint, authMechanism: row.authMechanism });
      return;
    }
    setExisting(result);
    setForm(formFromDetail(result));
  };

  const openDelete = (row: WebhookSummary) => {
    beginDrawerRequest(row.id);
    setDrawerMode('delete');
    setDrawerRow(row);
    setReviewed(false);
    setOneTimeAcknowledged(false);
    setDrawerError(null);
    setOutcomeUnknown(false);
  };

  const openRotate = (row: WebhookSummary) => {
    const pending = pendingReconciliations.rotations.find((item) => item.webhookId === row.id);
    beginDrawerRequest(row.id);
    setDrawerMode('rotate');
    setDrawerRow(row);
    setExisting(null);
    setReviewed(false);
    setOneTimeAcknowledged(false);
    setDrawerError(
      pending
        ? 'This exact HMAC rotation has an unresolved outcome. A detail GET cannot establish the current key.'
        : null,
    );
    setOutcomeUnknown(pending !== undefined);
  };

  /** Refetch the current webhook's detail and repopulate the edit form from
   *  it — used both after a detected generation conflict (auto) and after
   *  an unknown PATCH outcome (operator-triggered "Refetch" button). Always
   *  clears `outcomeUnknown` and invalidates any stale review; `note`
   *  becomes the honest message shown once the refetch settles. `token`/
   *  `webhookId` are the identity actually rendered at the moment this was
   *  triggered — never re-read from `drawerRow` after the await, since that
   *  state may have moved on to a different (or closed) drawer by then. */
  const reconcileEdit = async (note: string, token: { id: string; seq: number }, webhookId: string) => {
    if (!isActiveDrawerRequest(token)) return;
    setDrawerLoading(true);
    const result = await getCentralWebhook(webhookId);
    if (!isActiveDrawerRequest(token)) return;
    setDrawerLoading(false);
    setOutcomeUnknown(false);
    setReviewed(false);
    if (isApiError(result)) {
      setExisting(null);
      setDrawerError(result.error);
      return;
    }
    setExisting(result);
    setForm(formFromDetail(result));
    setDrawerError(note);
  };

  /** Refresh the list (the delete drawer has no single-object detail to
   *  reconcile against) — used after an unknown DELETE outcome so the
   *  operator can see whether the row is still there before retrying.
   *  `token` is the identity of the delete drawer actually open when this
   *  was triggered; if that drawer closed/changed while the list refresh
   *  was in flight, the drawer-local note is dropped (the list itself still
   *  refreshes, since `load` is independently sequenced). */
  const reconcileDelete = async (note: string, token: { id: string; seq: number }) => {
    if (!isActiveDrawerRequest(token)) return;
    setOutcomeUnknown(false);
    setReviewed(false);
    await load(q, page);
    if (!isActiveDrawerRequest(token)) return;
    setDrawerError(note);
  };

  const reconcileCreate = async (
    token: { id: string; seq: number },
    pending: PendingCreateReconciliation,
  ) => {
    if (!isActiveDrawerRequest(token)) return;
    setReviewed(false);
    setOneTimeAcknowledged(false);
    setDrawerLoading(true);

    let offset = 0;
    let match: WebhookSummary | undefined;
    let checkedAt: string | undefined;
    while (true) {
      const refreshed = await getCentralWebhooks({
        limit: WEBHOOK_LIST_MAX_LIMIT,
        offset,
        q: '',
      });
      if (!isActiveDrawerRequest(token)) return;
      if (refreshed.error) {
        setDrawerLoading(false);
        setDrawerError(`Reconciliation failed: ${refreshed.error}. Do not retry the create request.`);
        return;
      }
      const baseMatches = refreshed.items.filter((item) =>
        matchesCreateCandidateBase(item, pending.candidate),
      );
      if (pending.candidate.authMechanism === 'OIDC') {
        for (const row of baseMatches) {
          const detailResult = await getCentralWebhook(row.id);
          if (!isActiveDrawerRequest(token)) return;
          if (isApiError(detailResult)) {
            setDrawerLoading(false);
            setDrawerError(
              `Reconciliation could not verify OIDC identity for webhook '${row.id}': ${detailResult.error}. Do not retry the create request.`,
            );
            return;
          }
          if (matchesCanonicalWebhookCreateCandidate(detailResult, pending.candidate)) {
            match = row;
            break;
          }
        }
      } else {
        match = baseMatches.find((item) =>
          matchesCanonicalWebhookCreateCandidate(item, pending.candidate),
        );
      }
      if (match || !refreshed.hasMore) {
        checkedAt = new Date().toISOString();
        break;
      }
      const nextOffset = refreshed.offset + refreshed.count;
      if (refreshed.count <= 0 || nextOffset <= offset) {
        setDrawerLoading(false);
        setDrawerError('Reconciliation did not complete all Central pages. Do not retry the create request.');
        return;
      }
      offset = nextOffset;
    }

    if (!isActiveDrawerRequest(token)) return;
    setDrawerLoading(false);
    setPendingReconciliations((current) => {
      if (current.create?.operationId !== pending.operationId) return current;
      return {
        ...current,
        create: {
          ...current.create,
          lookup: match ? 'found' : 'absent',
          absenceAttested: false,
          locatedAttested: false,
          checkedAt,
          matchedWebhookId: match?.id,
        },
      };
    });
    setDrawerError(
      match
        ? `Central now lists the exact ${lab ? 'submitted' : 'reviewed'} name, endpoint, and authentication method. Treat the webhook as likely created; another POST could duplicate it.`
        : `The exact ${lab ? 'submitted' : 'reviewed'} candidate was not present in the complete unfiltered Central list. Eventual consistency is still possible, so another POST remains blocked until you attest that you refreshed and independently confirmed absence in Central.`,
    );
  };

  const reconcileRotate = async (
    token: { id: string; seq: number },
    webhookId: string,
    pending: PendingRotateReconciliation,
  ) => {
    if (!isActiveDrawerRequest(token)) return;
    setDrawerLoading(true);
    const result = await getCentralWebhook(webhookId);
    if (!isActiveDrawerRequest(token)) return;
    setDrawerLoading(false);
    setReviewed(false);
    setOneTimeAcknowledged(false);
    if (isApiError(result)) {
      setDrawerError(`Reconciliation failed: ${result.error}`);
      return;
    }
    setPendingReconciliations((current) => ({
      ...current,
      rotations: current.rotations.map((item) =>
        item.operationId === pending.operationId && item.webhookId === webhookId
          ? { ...item, detailChecked: true, receiverAttested: false, centralAttested: false, checkedAt: new Date().toISOString() }
          : item,
      ),
    }));
    setDrawerError(
      'Refetched this webhook, but GET cannot reveal whether the HMAC key changed or recover it. Rotation remains blocked until both dedicated reconciliation attestations are complete.',
    );
  };

  const updateCreateAbsenceAttestation = (operationId: string, checked: boolean) => {
    setPendingReconciliations((current) => {
      if (current.create?.operationId !== operationId || current.create.lookup !== 'absent') return current;
      return { ...current, create: { ...current.create, absenceAttested: checked } };
    });
  };

  const updateCreateLocatedAttestation = (operationId: string, checked: boolean) => {
    setPendingReconciliations((current) => {
      if (current.create?.operationId !== operationId || current.create.lookup !== 'found') return current;
      return { ...current, create: { ...current.create, locatedAttested: checked } };
    });
  };

  const allowCreateAfterAbsence = async (pending: PendingCreateReconciliation) => {
    if (pending.lookup !== 'absent' || !pending.absenceAttested) return;
    setHandoffApplying(true);
    const result = await resolveCentralWebhookHandoff({
      operationId: pending.operationId,
      resolution: 'create-absent',
      ...(lab ? {} : { reviewConfirmed: true }),
      attestations: {
        candidateAbsent: true,
        eventualConsistencyRiskAccepted: true,
      },
    });
    if (!mountedRef.current) return;
    setHandoffApplying(false);
    if (isApiError(result)) {
      setDrawerError(result.error);
      return;
    }
    handoffRequestSeqRef.current += 1;
    applyPendingHandoff(null);
    setOutcomeUnknown(false);
    setForm(emptyForm());
    setReviewed(false);
    setOneTimeAcknowledged(false);
    setDrawerError(
      lab
        ? 'Absence attested. Build a new create request. If Central later reveals the prior operation, this new POST may create a duplicate.'
        : 'Absence attested. Build and review a new create request. If Central later reveals the prior operation, this new POST may create a duplicate.',
    );
  };

  const acknowledgeLikelyCreated = async (pending: PendingCreateReconciliation) => {
    if (pending.lookup !== 'found' || !pending.matchedWebhookId || !pending.locatedAttested) return;
    setHandoffApplying(true);
    const result = await resolveCentralWebhookHandoff({
      operationId: pending.operationId,
      resolution: 'create-located',
      ...(lab ? {} : { reviewConfirmed: true }),
      attestations: { candidateLocated: true },
      matchedWebhookId: pending.matchedWebhookId,
    });
    if (!mountedRef.current) return;
    setHandoffApplying(false);
    if (isApiError(result)) {
      setDrawerError(result.error);
      return;
    }
    handoffRequestSeqRef.current += 1;
    applyPendingHandoff(null);
    const detailResult = await getCentralWebhook(pending.matchedWebhookId);
    if (!mountedRef.current) return;
    if (isApiError(detailResult)) {
      closeDrawer();
      toast(
        lab
          ? 'Created webhook was reconciled. Reopen it from the refreshed list and start an HMAC rotation to issue a replacement key.'
          : 'Created webhook was reconciled. Reopen it from the refreshed list and review an HMAC rotation to issue a replacement key.',
        { tone: 'warning' },
      );
      void load(q, page);
      return;
    }
    closeDrawer();
    openRotate(detailResult);
  };

  const updateRotateAttestation = (
    pending: PendingRotateReconciliation,
    field: 'receiverAttested' | 'centralAttested',
    checked: boolean,
  ) => {
    setPendingReconciliations((current) => ({
      ...current,
      rotations: current.rotations.map((item) =>
        item.operationId === pending.operationId && item.webhookId === pending.webhookId
          ? { ...item, [field]: checked }
          : item,
      ),
    }));
  };

  const allowRotateAfterAttestation = async (pending: PendingRotateReconciliation) => {
    if (!pending.detailChecked || !pending.receiverAttested || !pending.centralAttested) return;
    setHandoffApplying(true);
    const result = await resolveCentralWebhookHandoff({
      operationId: pending.operationId,
      resolution: 'rotate-reconciled',
      ...(lab ? {} : { reviewConfirmed: true }),
      attestations: {
        receiverReconciled: true,
        centralReconciled: true,
      },
    });
    if (!mountedRef.current) return;
    setHandoffApplying(false);
    if (isApiError(result)) {
      setDrawerError(result.error);
      return;
    }
    handoffRequestSeqRef.current += 1;
    applyPendingHandoff(null);
    setOutcomeUnknown(false);
    setReviewed(false);
    setOneTimeAcknowledged(false);
    setDrawerError(
      lab
        ? 'Reconciliation attested. Any new rotation is a separate operation that will invalidate the receiver’s current key; start it from scratch.'
        : 'Reconciliation attested. Any new rotation is a separate operation that will invalidate the receiver’s current key; review it from scratch.',
    );
  };

  /** Every form-field edit invalidates a prior review confirmation — the
   *  reviewed checkbox always states "I reviewed THIS exact diff", never a
   *  stale one from before the operator kept typing. */
  const updateForm = (patch: Partial<WebhookForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setReviewed(false);
    setOneTimeAcknowledged(false);
  };
  const updateReviewed = (checked: boolean) => {
    setReviewed(checked);
    setReviewedTenantBinding(checked ? listing?.tenantBinding ?? null : null);
  };

  const formErrors = useMemo(() => {
    const errors = validateWebhookForm(form);
    if (errors.length === 0 && !isCreateFormComplete(form)) {
      errors.push(
        form.authMechanism === 'API_KEY'
          ? 'an API key is required'
          : 'OIDC client ID, client secret, and well-known URL are all required',
      );
    }
    return errors;
  }, [form]);
  const diffLines = useMemo(() => buildWebhookReviewDiff(existing, form), [existing, form]);
  const targetUrl = useMemo(
    () =>
      drawerMode === 'create'
        ? webhookTargetUrl(listing?.gatewayBaseUrl ?? null)
        : drawerMode === 'rotate'
          ? webhookTargetUrl(listing?.gatewayBaseUrl ?? null, drawerRow?.id, 'rotate-hmac-key')
          : webhookTargetUrl(listing?.gatewayBaseUrl ?? null, drawerRow?.id),
    [listing, drawerMode, drawerRow],
  );

  const submitCreate = async () => {
    if (
      !canWrite ||
      (!lab && !reviewed) ||
      !oneTimeAcknowledged ||
      formErrors.length > 0 ||
      outcomeUnknown
    ) {
      return;
    }
    const token = activeRequestRef.current;
    if (!token) return;
    const canonicalForm = canonicalizeWebhookCreateForm(form);
    const candidate = canonicalWebhookCreateCandidate(canonicalForm);
    setApplying(true);
    const result = await createCentralWebhook(
      canonicalForm,
      lab ? undefined : true,
      true,
      lab ? listing?.tenantBinding ?? null : reviewedTenantBinding,
    );
    if (!isActiveDrawerRequest(token)) return;
    setApplying(false);
    if (isApiError(result)) {
      if (isUnknownWebhookOutcome(result)) {
        if (result.operationId) {
          handoffRequestSeqRef.current += 1;
          setPendingReconciliations({
            create: {
              operationId: result.operationId,
              candidate,
              state: 'outcome-unknown',
              fingerprintMatches: true,
              lookup: 'required',
              absenceAttested: false,
              locatedAttested: false,
            },
            rotations: [],
          });
        } else {
          void loadPendingHandoff();
        }
        setOutcomeUnknown(true);
        setReviewed(false);
        setOneTimeAcknowledged(false);
        setForm(createCandidateForm(candidate));
        setDrawerError(
          'Central may have created the webhook, but the one-time key was lost. Refetch and reconcile the webhook list before any new create; retrying blindly may duplicate the webhook.',
        );
        return;
      }
      setDrawerError(result.error);
      return;
    }
    const oneTimeResult = result;
    handoffRequestSeqRef.current += 1;
    setPendingReconciliations({
      create: {
        operationId: oneTimeResult.operationId,
        candidate,
        state: 'secret-issued-awaiting-handoff',
        fingerprintMatches: true,
        lookup: 'required',
        absenceAttested: false,
        locatedAttested: false,
      },
      rotations: [],
    });
    closeDrawer();
    showOneTimeSecret(oneTimeResult);
    void load(q, page);
  };

  const submitRotate = async () => {
    if (
      !canWrite ||
      (!lab && !reviewed) ||
      !oneTimeAcknowledged ||
      !drawerRow ||
      outcomeUnknown
    ) {
      return;
    }
    const token = activeRequestRef.current;
    if (!token) return;
    const webhookId = drawerRow.id;
    setApplying(true);
    const result = await rotateCentralWebhookHmacKey(
      webhookId,
      lab ? undefined : true,
      true,
      lab ? listing?.tenantBinding ?? null : reviewedTenantBinding,
    );
    if (!isActiveDrawerRequest(token)) return;
    setApplying(false);
    if (isApiError(result)) {
      if (isUnknownWebhookOutcome(result)) {
        if (result.operationId) {
          handoffRequestSeqRef.current += 1;
          setPendingReconciliations({
            create: null,
            rotations: [{
              operationId: result.operationId,
              webhookId,
              state: 'outcome-unknown',
              fingerprintMatches: true,
              detailChecked: false,
              receiverAttested: false,
              centralAttested: false,
            }],
          });
        } else {
          void loadPendingHandoff();
        }
        setOutcomeUnknown(true);
        setReviewed(false);
        setOneTimeAcknowledged(false);
        setDrawerError(
          'Central may have rotated the HMAC key, but the one-time key was lost. Refetch the webhook and reconcile the receiver/key before any new rotation; retrying blindly may rotate the key again.',
        );
        return;
      }
      setDrawerError(result.error);
      return;
    }
    const oneTimeResult = result;
    handoffRequestSeqRef.current += 1;
    setPendingReconciliations({
      create: null,
      rotations: [{
        operationId: oneTimeResult.operationId,
        webhookId,
        state: 'secret-issued-awaiting-handoff',
        fingerprintMatches: true,
        detailChecked: false,
        receiverAttested: false,
        centralAttested: false,
      }],
    });
    closeDrawer();
    showOneTimeSecret(oneTimeResult);
    void load(q, page);
  };

  const submitEdit = async () => {
    if (!canWrite || (!lab && !reviewed) || formErrors.length > 0 || outcomeUnknown || !drawerRow) return;
    // Bind this PATCH to the identity actually rendered right now — never
    // re-read `drawerRow`/`existing` after the await, since the operator
    // could close this drawer (or it could be superseded) while the request
    // is in flight.
    const token = activeRequestRef.current;
    if (!token) return;
    const webhookId = drawerRow.id;
    const expectedGeneration = existing?.generation;
    setApplying(true);
    const result = await updateCentralWebhook(webhookId, form, lab ? undefined : true, expectedGeneration);
    if (!isActiveDrawerRequest(token)) return;
    setApplying(false);
    if (isApiError(result)) {
      if (isUnknownWebhookOutcome(result)) {
        setOutcomeUnknown(true);
        setReviewed(false);
        setDrawerError(
          'Central did not confirm whether this update applied (a transport/gateway failure) — the outcome is unknown. Refetch the latest webhook before trying again; do not retry blindly.',
        );
        return;
      }
      setDrawerError(result.error);
      return;
    }
    if (!result.ok) {
      if (isWebhookGenerationConflict(result)) {
        await reconcileEdit(
          lab
            ? 'This webhook changed since it was loaded (generation conflict) — refetched the latest version below. Check the new diff before reapplying.'
            : 'This webhook changed since it was loaded (generation conflict) — refetched the latest version below. Review the new diff before reapplying.',
          token,
          webhookId,
        );
        return;
      }
      setDrawerError(result.message);
      return;
    }
    toast(result.message, { tone: 'success' });
    closeDrawer();
    await load(q, page);
  };

  const submitDelete = async () => {
    if (!canWrite || (!lab && !reviewed) || !drawerRow || outcomeUnknown) return;
    // Same identity binding as submitEdit: capture now, verify on return.
    const token = activeRequestRef.current;
    if (!token) return;
    const webhookId = drawerRow.id;
    setApplying(true);
    const result = await deleteCentralWebhook(webhookId, lab ? undefined : true);
    if (!isActiveDrawerRequest(token)) return;
    setApplying(false);
    if (isApiError(result)) {
      if (isUnknownWebhookOutcome(result)) {
        setOutcomeUnknown(true);
        setReviewed(false);
        setDrawerError(
          'Central did not confirm whether this delete applied (a transport/gateway failure) — the outcome is unknown. Refetch the list before trying again; do not retry blindly.',
        );
        return;
      }
      setDrawerError(result.error);
      return;
    }
    if (!result.ok) {
      setDrawerError(result.message);
      return;
    }
    toast(result.message, { tone: 'success' });
    closeDrawer();
    await load(q, page);
  };

  const recoverPendingRotation = async (pending: PendingRotateReconciliation) => {
    const listed = listing?.items.find((item) => item.id === pending.webhookId);
    if (listed) {
      openRotate(listed);
      return;
    }
    const result = await getCentralWebhook(pending.webhookId);
    if (!mountedRef.current) return;
    if (isApiError(result)) {
      setHandoffStatusError(
        `Pending rotation '${pending.operationId}' could not load webhook '${pending.webhookId}': ${result.error}`,
      );
      return;
    }
    openRotate(result);
  };

  const rows = listing?.items ?? [];
  const anyPendingHandoff =
    pendingReconciliations.create ?? pendingReconciliations.rotations[0] ?? null;
  const pendingCreate = drawerMode === 'create' ? pendingReconciliations.create : null;
  const pendingRotate =
    drawerMode === 'rotate' && drawerRow
      ? pendingReconciliations.rotations.find((item) => item.webhookId === drawerRow.id) ?? null
      : null;
  const readError = listing?.error;
  const honestEmpty =
    !!listing &&
    rows.length === 0 &&
    listing.totalCount === 0 &&
    typeof listing.note === 'string' &&
    listing.note.length > 0;
  const emptyProvenanceError =
    listing && rows.length === 0 && !q.trim() && !honestEmpty
      ? 'The portal returned an empty webhook list without recognized empty-list provenance.'
      : undefined;
  const displayedReadError = readError ?? emptyProvenanceError;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <SectionHeader label="Webhooks" meta="API GATEWAY \u00b7 NETWORK-SERVICES/V1" />
        <Button
          variant="primary"
          size="sm"
          title={!canWrite ? 'The Central connector has no write grant' : lab ? 'Create webhook' : 'Create a reviewed webhook'}
          disabled={!canWrite || anyPendingHandoff !== null}
          onClick={openCreate}
        >
          New webhook
        </Button>
      </div>

      <Alert tone="warning" title="One-time HMAC secure handoff">
        Central returns each HMAC signing key only once. GET cannot retrieve it later. Create and rotate require
        two explicit acknowledgements and show the key in a dedicated one-time modal so it can be copied now.
      </Alert>

      {listing && !canWrite ? (
        <Alert tone="info" title="Central webhook writes are unavailable">
          This linked Central plane has a read-only connector grant. Webhook inventory and pending-handoff
          reconciliation remain available, but vendor mutation controls are disabled.
        </Alert>
      ) : null}

      {handoffStatusError ? (
        <Alert tone="danger" title="Handoff status unavailable">
          {handoffStatusError} Create and rotate may be blocked server-side; do not retry until status can be read.
        </Alert>
      ) : null}

      {anyPendingHandoff ? (
        <Alert
          tone="danger"
          title={`Pending webhook handoff · ${anyPendingHandoff.operationId}`}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span>
              State: {anyPendingHandoff.state}. The one-time key is unrecoverable after navigation or response
              loss. Automatic retry is disabled.
            </span>
            {!anyPendingHandoff.fingerprintMatches ? (
              <span>
                The active Central credentials do not match this journal. Restore the original tenant credentials
                before acknowledgement or reconciliation.
              </span>
            ) : null}
            {pendingReconciliations.create ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={!pendingReconciliations.create.fingerprintMatches || handoffApplying}
                onClick={openCreate}
              >
                Reconcile pending create
              </Button>
            ) : pendingReconciliations.rotations[0] ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={!pendingReconciliations.rotations[0].fingerprintMatches}
                onClick={() => void recoverPendingRotation(pendingReconciliations.rotations[0])}
              >
                Reconcile pending rotation
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : null}

      <Input
        size="sm"
        placeholder="Search by name or endpoint\u2026"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void load(q, 1);
        }}
        aria-label="Search webhooks"
      />

      {loading ? (
        <Spinner />
      ) : displayedReadError ? (
        <EmptyState title="Webhooks unavailable" description={displayedReadError} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No webhooks"
          description={q ? 'No webhooks match the search.' : listing?.note ?? 'Central reports no configured webhooks for this tenant.'}
        />
      ) : (
        <>
          <Table density="compact">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Name</Table.HeaderCell>
                <Table.HeaderCell>Endpoint</Table.HeaderCell>
                <Table.HeaderCell>Auth</Table.HeaderCell>
                <Table.HeaderCell>Updated</Table.HeaderCell>
                <Table.HeaderCell>Actions</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {rows.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>{row.name}</Table.Cell>
                  <Table.Cell>
                    <span className="nt-mono-11">{row.endpoint}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge tone={row.authMechanism === 'OIDC' ? 'accent' : 'neutral'}>{row.authMechanism}</Badge>
                  </Table.Cell>
                  <Table.Cell>{fmtTime(row.updatedAt)}</Table.Cell>
                  <Table.Cell>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button variant="secondary" size="sm" disabled={!canWrite} onClick={() => void openEdit(row)}>
                        Edit
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        title="Rotate the one-time HMAC key"
                        disabled={!canWrite || anyPendingHandoff !== null}
                        onClick={() => openRotate(row)}
                      >
                        Rotate HMAC
                      </Button>
                      <Button variant="danger" size="sm" disabled={!canWrite} onClick={() => openDelete(row)}>
                        Delete
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          {totalPages > 1 ? <Pagination page={page} total={totalPages} onChange={setPage} /> : null}
        </>
      )}

      <SectionHeader label="Receivers" meta="INBOUND · /API/HOOKS" />
      {receiverError ? (
        <EmptyState title="Receiver status unavailable" description={receiverError} />
      ) : receivers === null ? (
        <Spinner />
      ) : (
        <>
          <Table density="compact">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Source</Table.HeaderCell>
                <Table.HeaderCell>Register this URL</Table.HeaderCell>
                <Table.HeaderCell>Signing secret</Table.HeaderCell>
                <Table.HeaderCell>Last received</Table.HeaderCell>
                <Table.HeaderCell>Events</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {receivers.receivers.map((receiver) => (
                <Table.Row key={receiver.source}>
                  <Table.Cell>{receiver.label}</Table.Cell>
                  <Table.Cell>
                    <span className="nt-mono-11">
                      {`${window.location.origin}${receiver.path}`}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge
                      tone={
                        receiver.secret === 'operator'
                          ? 'success'
                          : receiver.secret === 'demo'
                            ? 'warning'
                            : 'danger'
                      }
                    >
                      {receiver.secret === 'operator'
                        ? 'configured'
                        : receiver.secret === 'demo'
                          ? 'demo secret'
                          : 'not configured'}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    {receiver.lastReceivedAt ? fmtTime(receiver.lastReceivedAt) : 'Nothing received yet'}
                  </Table.Cell>
                  <Table.Cell>{receiver.receivedCount}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          {receivers.demoMode ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                size="sm"
                disabled={simulating !== null}
                title="Post a labelled fixture payload through the real signed receiver path"
                onClick={() => void simulate('mist')}
              >
                {simulating === 'mist' ? 'Simulating…' : 'Simulate Mist event'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={simulating !== null}
                title="Post a labelled fixture payload through the real signed receiver path"
                onClick={() => void simulate('central')}
              >
                {simulating === 'central' ? 'Simulating…' : 'Simulate Central event'}
              </Button>
              <span style={{ fontSize: 11.5, color: 'var(--nd-text-muted)' }}>
                Signed with the demo secret, then verified, normalized and queued exactly like a real delivery.
              </span>
            </div>
          ) : null}
        </>
      )}

      <SectionHeader
        label="Received events"
        meta={receiverEvents !== null && receiverEvents.length > 0 ? String(receiverEvents.length) : undefined}
      />
      {receiverEvents === null ? (
        <Spinner />
      ) : receiverEvents.length === 0 ? (
        <EmptyState
          title="No events received yet"
          description={
            receiverEventsNote ??
            'Nothing has been delivered to either receiver yet — register one of the URLs above as a webhook target.'
          }
        />
      ) : (
        <Table density="compact">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Received</Table.HeaderCell>
              <Table.HeaderCell>Source</Table.HeaderCell>
              <Table.HeaderCell>Severity</Table.HeaderCell>
              <Table.HeaderCell>Event</Table.HeaderCell>
              <Table.HeaderCell>Device</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {receiverEvents.map((event) => (
              <Table.Row key={event.id}>
                <Table.Cell>{fmtTime(event.receivedAt)}</Table.Cell>
                <Table.Cell>
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <Badge tone="neutral">{event.source === 'mist' ? 'Mist' : 'New Central'}</Badge>
                    {event.demo ? <Badge tone="warning">demo</Badge> : null}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Badge tone={RECEIVER_SEV_TONE[event.sev]}>{event.sev}</Badge>
                </Table.Cell>
                <Table.Cell>{event.title}</Table.Cell>
                <Table.Cell>{event.device || '—'}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      <Drawer
        open={drawerMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            if (applying && (drawerMode === 'create' || drawerMode === 'rotate')) return;
            closeDrawer();
          }
        }}
        title={
          drawerMode === 'create'
            ? 'Create webhook'
            : drawerMode === 'edit'
              ? `Edit ${drawerRow?.name ?? 'webhook'}`
              : drawerMode === 'rotate'
                ? `Rotate HMAC for ${drawerRow?.name ?? 'webhook'}`
                : `Delete ${drawerRow?.name ?? 'webhook'}`
        }
      >
        {drawerLoading ? (
          <Spinner />
        ) : drawerMode === 'delete' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 12.5, color: 'var(--nd-text-primary)' }}>
              This permanently deletes webhook &quot;{drawerRow?.name}&quot;. Central will stop delivering any
              notification rule pointed at it.
            </div>
            <div className="nt-hint-muted">
              DELETE {targetUrl}
            </div>
            {drawerError ? <EmptyState title={outcomeUnknown ? 'Outcome unknown' : 'Delete failed'} description={drawerError} /> : null}
            {outcomeUnknown ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const token = activeRequestRef.current;
                  if (!token) return;
                  void reconcileDelete(
                    'Refreshed the list \u2014 confirm whether the delete applied before retrying.',
                    token,
                  );
                }}
              >
                Refetch list
              </Button>
            ) : !lab ? (
              <Checkbox
                label="I reviewed this delete and confirm it should apply now."
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
            ) : null}
            <Button variant="danger" disabled={!canWrite || (!lab && !reviewed) || applying || outcomeUnknown} onClick={() => void submitDelete()}>
              {applying ? 'Deleting\u2026' : 'Delete webhook'}
            </Button>
          </div>
        ) : drawerMode === 'rotate' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Alert tone="warning" title="The new HMAC key is returned once">
              GET cannot retrieve the key later. If the successful response is lost, reconcile before making a
              new request.
            </Alert>
            <div style={{ fontSize: 12.5, color: 'var(--nd-text-primary)' }}>
              Rotate the signing key for &quot;{drawerRow?.name}&quot; at generation {drawerRow?.generation}.
            </div>
            <div className="nt-hint-muted">
              POST {targetUrl}
            </div>
            {drawerError ? (
              <EmptyState title={outcomeUnknown ? 'Outcome unknown' : 'Rotation failed'} description={drawerError} />
            ) : null}
            {outcomeUnknown ? (
              pendingRotate ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!pendingRotate.fingerprintMatches || handoffApplying}
                    onClick={() => {
                      const token = activeRequestRef.current;
                      if (!token || !drawerRow) return;
                      void reconcileRotate(token, drawerRow.id, pendingRotate);
                    }}
                  >
                    Refetch webhook details
                  </Button>
                  {pendingRotate.detailChecked ? (
                    <>
                      <Alert tone="danger" title="Rotation is still unresolved">
                        Detail GET cannot establish the current HMAC key. Before enabling another rotation, reconcile
                        both the receiver and Central key state (or perform an external verification). A new rotation
                        invalidates the key the receiver currently expects.
                      </Alert>
                      <Checkbox
                        label={`I reconciled the receiver and delivery state for webhook "${pendingRotate.webhookId}".`}
                        checked={pendingRotate.receiverAttested}
                        onChange={(e) =>
                          updateRotateAttestation(pendingRotate, 'receiverAttested', e.target.checked)
                        }
                      />
                      <Checkbox
                        label="I reconciled Central's key state or performed an external verification, and understand another rotation invalidates the receiver's current key."
                        checked={pendingRotate.centralAttested}
                        onChange={(e) =>
                          updateRotateAttestation(pendingRotate, 'centralAttested', e.target.checked)
                        }
                      />
                      <Button
                        variant="danger"
                        disabled={
                          !pendingRotate.receiverAttested ||
                          !pendingRotate.centralAttested ||
                          !pendingRotate.fingerprintMatches ||
                          handoffApplying
                        }
                        onClick={() => void allowRotateAfterAttestation(pendingRotate)}
                      >
                        {lab ? 'Allow a new rotation' : 'Allow a new reviewed rotation'}
                      </Button>
                    </>
                  ) : null}
                </>
              ) : null
            ) : (
              <>
                {!lab ? <Checkbox
                  label="I reviewed this exact HMAC rotation and confirm it should apply now."
                  checked={reviewed}
                  onChange={(e) => updateReviewed(e.target.checked)}
                /> : null}
                <Checkbox
                  label="I understand the returned HMAC key is one-time, shown once, and must be copied now."
                  checked={oneTimeAcknowledged}
                  onChange={(e) => setOneTimeAcknowledged(e.target.checked)}
                />
              </>
            )}
            {!outcomeUnknown ? (
              <Button
                variant="danger"
                disabled={!canWrite || (!lab && !reviewed) || !oneTimeAcknowledged || applying}
                onClick={() => void submitRotate()}
              >
                {applying ? 'Rotating\u2026' : 'Rotate HMAC key'}
              </Button>
            ) : null}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <FormField label="Name">
              <Input value={form.name} onChange={(e) => updateForm({ name: e.target.value })} maxLength={64} />
            </FormField>
            <FormField label="Target URL" help="Must be HTTPS by default \u2014 the receiver Central will POST alert notifications to.">
              <Input
                value={form.endpoint}
                onChange={(e) => updateForm({ endpoint: e.target.value })}
                placeholder="https://example.com/webhook"
              />
            </FormField>
            <FormField label="Authentication method">
              <Select
                options={WEBHOOK_AUTH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={form.authMechanism}
                onValueChange={(v) => updateForm({ authMechanism: v as WebhookAuthMechanism })}
              />
            </FormField>
            {form.authMechanism === 'API_KEY' ? (
              <FormField
                label="API key"
                help="Write-only in this portal \u2014 it is never displayed in list/detail state and must be re-entered on every update."
              >
                <Input
                  type="password"
                  value={form.apiKey ?? ''}
                  onChange={(e) => updateForm({ apiKey: e.target.value })}
                  autoComplete="new-password"
                />
              </FormField>
            ) : (
              <>
                <FormField label="OIDC client ID">
                  <Input value={form.oidcClientId ?? ''} onChange={(e) => updateForm({ oidcClientId: e.target.value })} />
                </FormField>
                <FormField
                  label="OIDC client secret"
                  help="Write-only in this portal \u2014 it is never displayed in list/detail state and must be re-entered on every update."
                >
                  <Input
                    type="password"
                    value={form.oidcClientSecret ?? ''}
                    onChange={(e) => updateForm({ oidcClientSecret: e.target.value })}
                    autoComplete="new-password"
                  />
                </FormField>
                <FormField label="OIDC well-known URL">
                  <Input
                    value={form.oidcWellKnownUrl ?? ''}
                    onChange={(e) => updateForm({ oidcWellKnownUrl: e.target.value })}
                    placeholder="https://issuer.example/.well-known/openid-configuration"
                  />
                </FormField>
              </>
            )}

            <SectionHeader
              label={lab ? 'Write summary' : 'Review'}
              meta={drawerMode === 'create' ? 'new webhook' : existing ? `generation ${existing.generation}` : undefined}
            />
            <div className="nt-hint-muted">
              {drawerMode === 'create' ? 'POST' : 'PATCH'} {targetUrl}
            </div>
            <DiffCode text={diffLines.join('\n')} />
            {formErrors.length > 0 ? (
              <EmptyState title={lab ? 'Fix before applying' : 'Fix before reviewing'} description={formErrors.join('; ')} />
            ) : null}
            {drawerError ? (
              <EmptyState
                title={outcomeUnknown ? 'Outcome unknown' : drawerMode === 'create' ? 'Create failed' : 'Save failed'}
                description={drawerError}
              />
            ) : null}
            {outcomeUnknown ? (
              drawerMode === 'create' && pendingCreate ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!pendingCreate.fingerprintMatches || handoffApplying}
                    onClick={() => {
                      const token = activeRequestRef.current;
                      if (!token) return;
                      void reconcileCreate(token, pendingCreate);
                    }}
                  >
                    {pendingCreate.lookup === 'required'
                      ? 'Run unfiltered reconciliation'
                      : 'Refresh unfiltered reconciliation'}
                  </Button>
                  {pendingCreate.lookup === 'found' ? (
                    <>
                      <Alert tone="danger" title="Webhook likely created">
                        Central lists the exact {lab ? 'submitted' : 'reviewed'} name, endpoint, and authentication method. The one-time HMAC
                        key cannot be recovered. Do not send the create again; doing so may duplicate the webhook.
                      </Alert>
                      <Checkbox
                        label={
                          lab
                            ? 'I checked the canonical candidate match and attest this is the webhook created by the pending operation.'
                            : 'I reviewed the canonical candidate match and attest this is the webhook created by the pending operation.'
                        }
                        checked={pendingCreate.locatedAttested}
                        onChange={(e) =>
                          updateCreateLocatedAttestation(
                            pendingCreate.operationId,
                            e.target.checked,
                          )
                        }
                      />
                      <Button
                        variant="primary"
                        disabled={
                          !pendingCreate.locatedAttested ||
                          !pendingCreate.fingerprintMatches ||
                          handoffApplying
                        }
                        onClick={() => void acknowledgeLikelyCreated(pendingCreate)}
                      >
                        {lab ? 'Clear handoff and open replacement rotation' : 'Clear handoff and review replacement rotation'}
                      </Button>
                    </>
                  ) : pendingCreate.lookup === 'absent' ? (
                    <>
                      <Alert tone="warning" title="Absence is not final proof">
                        The complete unfiltered list did not contain this exact candidate, but Central may still be
                        eventually consistent. A new POST could create a duplicate if the prior request appears later.
                      </Alert>
                      <Checkbox
                        label={`After this refresh, I checked Central and explicitly confirm the exact ${lab ? 'submitted' : 'reviewed'} webhook is absent.`}
                        checked={pendingCreate.absenceAttested}
                        onChange={(e) =>
                          updateCreateAbsenceAttestation(pendingCreate.operationId, e.target.checked)
                        }
                      />
                      <Button
                        variant="danger"
                        disabled={
                          !pendingCreate.absenceAttested ||
                          !pendingCreate.fingerprintMatches ||
                          handoffApplying
                        }
                        onClick={() => void allowCreateAfterAbsence(pendingCreate)}
                      >
                        Allow a new create despite eventual-consistency risk
                      </Button>
                    </>
                  ) : null}
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const token = activeRequestRef.current;
                    if (!token || !drawerRow) return;
                    void reconcileEdit(
                      lab
                        ? 'Refetched the latest webhook \u2014 check the diff and reapply if needed.'
                        : 'Refetched the latest webhook \u2014 review the diff and reapply if needed.',
                      token,
                      drawerRow.id,
                    );
                  }}
                >
                  Refetch latest webhook
                </Button>
              )
            ) : (
              <>
                {!lab ? <Checkbox
                  label={
                    drawerMode === 'create'
                      ? 'I reviewed this exact webhook creation and confirm it should apply now.'
                      : 'I reviewed this exact update and confirm it should apply now.'
                  }
                  checked={reviewed}
                  onChange={(e) =>
                    drawerMode === 'create'
                      ? updateReviewed(e.target.checked)
                      : setReviewed(e.target.checked)
                  }
                /> : null}
                {drawerMode === 'create' ? (
                  <Checkbox
                    label="I understand the returned HMAC key is one-time, shown once, and must be copied now."
                    checked={oneTimeAcknowledged}
                    onChange={(e) => setOneTimeAcknowledged(e.target.checked)}
                  />
                ) : null}
              </>
            )}
            {!outcomeUnknown || drawerMode !== 'create' ? (
              <Button
                variant="primary"
                disabled={
                  (!lab && !reviewed) ||
                  !canWrite ||
                  (drawerMode === 'create' && !oneTimeAcknowledged) ||
                  formErrors.length > 0 ||
                  applying ||
                  outcomeUnknown
                }
                onClick={() => void (drawerMode === 'create' ? submitCreate() : submitEdit())}
              >
                {applying ? 'Applying\u2026' : drawerMode === 'create' ? 'Create webhook' : 'Save changes'}
              </Button>
            ) : null}
          </div>
        )}
      </Drawer>

      <Drawer
        open={oneTimeSecretOpen}
        onOpenChange={(open) => {
          if (!open) clearOneTimeSecret();
        }}
        title="Copy the one-time HMAC key now"
        description="This modal cannot be reopened after it closes."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Alert tone="danger" title="GET cannot retrieve this secret later">
            Copy the {oneTimeSecretAction === 'created' ? 'new webhook' : 'rotated'} HMAC key before closing.
            It is not saved by this portal.
          </Alert>
          <div
            aria-label="One-time HMAC key"
            className="nt-mono-11" style={{ padding: 12, borderRadius: 6, background: "var(--nd-surface-raised)", overflowWrap: "anywhere" }}
          >
            {oneTimeSecretRevealed
              ? oneTimeSecret
              : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              onClick={() => setOneTimeSecretRevealed((revealed) => !revealed)}
            >
              {oneTimeSecretRevealed ? 'Hide key' : 'Reveal key'}
            </Button>
            <Button variant="primary" onClick={() => void copyOneTimeSecret()}>
              Copy HMAC key
            </Button>
          </div>
          {copyStatus ? <div role="status">{copyStatus}</div> : null}
          <Checkbox
            label="I copied this HMAC key into the receiver's secure secret store and verified it is retained."
            checked={secretStored}
            onChange={(e) => setSecretStored(e.target.checked)}
          />
          <Button
            variant="primary"
            disabled={!secretStored || handoffApplying}
            onClick={() => void acknowledgeStoredSecret()}
          >
            {handoffApplying ? 'Acknowledging…' : 'Acknowledge stored and clear handoff'}
          </Button>
          <Button variant="danger" disabled={handoffApplying} onClick={clearOneTimeSecret}>
            Close without storage acknowledgement
          </Button>
        </div>
      </Drawer>
    </div>
  );
}
