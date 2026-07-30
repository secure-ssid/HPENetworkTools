/**
 * web/src/screens/SseInventoryPanel.test.tsx — the SSE object inventory
 * browser embedded in Systems' Configuration tab.
 *
 * The api client is mocked at the module boundary — no real fetch. Covers:
 * loading a kind's cached rows, an unavailable kind's honest empty state
 * (never a fabricated "no rows"), read-only vs. write-capable rendering
 * (built-in rows never show mutation controls even when canWrite), the
 * review-gated create flow, staged/retry-commit banner, and request/action
 * kind binding when selections and responses race.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SseInventoryPanel } from './SseInventoryPanel';
import { ToastProvider } from '../nightdesk';
import {
  cleanupSseManualReconciliation,
  createSseObject,
  deleteSseObject,
  getSseInventory,
  getSseKind,
  getSseObject,
  retrySseCommit,
  updateSseObject,
} from '../api/client';
import type { SseKindListing } from '../api/client';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getSseInventory: vi.fn(),
    getSseKind: vi.fn(),
    getSseObject: vi.fn(),
    createSseObject: vi.fn(),
    cleanupSseManualReconciliation: vi.fn(),
    updateSseObject: vi.fn(),
    deleteSseObject: vi.fn(),
    retrySseCommit: vi.fn(),
  };
});

const mockGetSseInventory = vi.mocked(getSseInventory);
const mockGetSseKind = vi.mocked(getSseKind);
const mockGetSseObject = vi.mocked(getSseObject);
const mockCreateSseObject = vi.mocked(createSseObject);
const mockCleanupSseManualReconciliation = vi.mocked(cleanupSseManualReconciliation);
const mockUpdateSseObject = vi.mocked(updateSseObject);
const mockDeleteSseObject = vi.mocked(deleteSseObject);
const mockRetrySseCommit = vi.mocked(retrySseCommit);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function listing(kind: 'connectorZones' | 'users', id: string, name: string): SseKindListing {
  return {
    rows: [{ kind, id, name, raw: {} }],
    total: 1,
    truncated: false,
    unavailable: false,
  };
}

const committedMutation = {
  ok: true,
  message: 'applied and committed',
  result: {
    mutation: { ok: true, httpCode: 200, id: 'object-1', message: 'accepted' },
    commit: {
      attempted: true,
      ok: true,
      httpCode: 204,
      message: 'committed',
      warning: 'Tenant-wide commit may apply other staged changes.',
    },
    staged: false,
    cacheRefresh: { attempted: true, status: 'refreshed', message: 'SSE inventory cache refreshed' },
  },
} as const;

function unknownMutationResult(step: 'mutation' | 'commit') {
  return {
    ok: false,
    message: `${step} transport outcome is unknown`,
    result: {
      mutation:
        step === 'mutation'
          ? {
              ok: false,
              httpCode: null,
              acceptance: 'unknown' as const,
              message: 'mutation acceptance is unknown',
            }
          : {
              ok: true,
              httpCode: 200,
              acceptance: 'accepted' as const,
              message: 'mutation accepted',
            },
      commit:
        step === 'mutation'
          ? {
              attempted: false,
              ok: false,
              httpCode: null,
              acceptance: 'not-attempted' as const,
              message: 'not attempted',
            }
          : {
              attempted: true,
              ok: false,
              httpCode: null,
              acceptance: 'unknown' as const,
              message: 'Commit transport outcome is unknown',
            },
      staged: true,
      outcome: 'unknown' as const,
      cacheRefresh: {
        attempted: false,
        status: 'skipped' as const,
        message: 'cache was not refreshed and the durable blocker remains',
      },
    },
  };
}

function renderPanel(
  canWrite: boolean,
  initial?: { kind: 'connectorZones' | 'users'; objectId?: string },
) {
  return render(
    <ToastProvider>
      <SseInventoryPanel
        canWrite={canWrite}
        initialKind={initial?.kind}
        initialObjectId={initial?.objectId}
      />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SseInventoryPanel — listing', () => {
  it('opens the exact kind and object selected in Inventory Explorer', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue(listing('users', 'user-7', 'Selected user'));
    mockGetSseObject.mockResolvedValue({
      ok: true,
      object: { id: 'user-7', userName: 'selected.user', description: 'Opened from inventory' },
    });

    renderPanel(false, { kind: 'users', objectId: 'user-7' });

    await waitFor(() => expect(mockGetSseKind).toHaveBeenCalledWith('users', undefined));
    await waitFor(() => expect(mockGetSseObject).toHaveBeenCalledWith('users', 'user-7'));
    expect(await screen.findByDisplayValue('selected.user')).toBeTruthy();
  });

  it('renders the cached rows for the default kind (connector zones)', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({
      rows: [{ kind: 'connectorZones', id: 'cz-1', name: 'HQ zone', detail: '2 connector(s)', raw: {} }],
      total: 1,
      truncated: false,
      unavailable: false,
    } satisfies SseKindListing);

    renderPanel(false);

    await waitFor(() => expect(screen.getByText('HQ zone')).toBeTruthy());
    expect(mockGetSseKind).toHaveBeenCalledWith('connectorZones', undefined);
    // Read-only: no "New" button, and the row only offers View, never Edit/Delete.
    expect(screen.queryByRole('button', { name: /New Connector Zone/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'View' })).toBeTruthy();
  });

  it('an unavailable kind renders an honest "unavailable" state, never a fabricated empty list', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: null, truncated: false, unavailable: true } satisfies SseKindListing);

    renderPanel(false);

    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeTruthy());
    expect(screen.queryByText(/^No /)).toBeNull();
  });

  it.each([
    ['denied', 403, 'Connector zones access denied', /token's granted scope/i],
    ['unsupported', 404, 'Connector zones unsupported', /limited-release/i],
    ['service-error', 503, 'Connector zones service error', /error or rate-limit response/i],
    ['unreachable', null, 'Connector zones unreachable', /failed or timed out/i],
    ['invalid-response', 200, 'Connector zones invalid response', /shape was not recognized/i],
  ] as const)('renders an accurate %s failure message and never an empty state', async (reason, httpCode, title, detail) => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({
      rows: [],
      total: null,
      truncated: false,
      unavailable: true,
      readStatus: {
        state: 'failed',
        reason,
        httpCode,
        message: 'server-safe status',
      },
    } satisfies SseKindListing);

    renderPanel(false);

    await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
    expect(screen.getByText(detail)).toBeTruthy();
    expect(screen.queryByText(/^No connector zones$/i)).toBeNull();
  });

  it('a genuinely empty (but available) kind says so, distinct from unavailable', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false } satisfies SseKindListing);

    renderPanel(false);

    await waitFor(() => expect(screen.getByText(/^No connector zones$/i)).toBeTruthy());
  });

  it('a failed list read says read failed and never claims the plane reports none', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({
      rows: [],
      total: null,
      truncated: false,
      unavailable: true,
      readError: 'SSE cache read unavailable',
    } satisfies SseKindListing);

    renderPanel(false);

    await waitFor(() => expect(screen.getByText(/Connector zones read failed/i)).toBeTruthy());
    expect(screen.getByText(/SSE cache read unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/plane reports none/i)).toBeNull();
  });

  it('a builtIn row never shows edit/delete, even when the token can write', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({
      rows: [{ kind: 'connectorZones', id: 'cz-1', name: 'System zone', builtIn: true, raw: {} }],
      total: 1,
      truncated: false,
      unavailable: false,
    } satisfies SseKindListing);

    renderPanel(true);

    await waitFor(() => expect(screen.getByText('System zone')).toBeTruthy());
    expect(screen.getByText('built-in')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View' })).toBeTruthy();
  });

  it('ignores obsolete kind responses without changing the current list, error, or loading state', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    const firstConnector = deferred<SseKindListing>();
    const users = deferred<SseKindListing>();
    const currentConnector = deferred<SseKindListing>();
    mockGetSseKind
      .mockReturnValueOnce(firstConnector.promise)
      .mockReturnValueOnce(users.promise)
      .mockReturnValueOnce(currentConnector.promise);

    renderPanel(false);
    await waitFor(() => expect(mockGetSseKind).toHaveBeenCalledWith('connectorZones', undefined));

    fireEvent.change(screen.getByLabelText('Object kind'), { target: { value: 'users' } });
    await waitFor(() => expect(mockGetSseKind).toHaveBeenCalledWith('users', undefined));
    fireEvent.change(screen.getByLabelText('Object kind'), { target: { value: 'connectorZones' } });
    await waitFor(() => expect(mockGetSseKind).toHaveBeenCalledTimes(3));

    await act(async () => {
      users.resolve(listing('users', 'user-old', 'Wrong-kind user'));
      await users.promise;
    });
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
    expect(screen.queryByText('Wrong-kind user')).toBeNull();

    await act(async () => {
      currentConnector.resolve(listing('connectorZones', 'cz-current', 'Current zone'));
      await currentConnector.promise;
    });
    await waitFor(() => expect(screen.getByText('Current zone')).toBeTruthy());

    await act(async () => {
      firstConnector.resolve({
        rows: [],
        total: null,
        truncated: false,
        unavailable: true,
        readError: 'obsolete read failed',
      });
      await firstConnector.promise;
    });
    expect(screen.getByText('Current zone')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
    expect(screen.queryByText(/^No connector zones$/i)).toBeNull();
  });
});

describe('SseInventoryPanel — reviewed create', () => {
  it('requires the review checkbox before Create is enabled, then applies and commits', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false } satisfies SseKindListing);
    mockCreateSseObject.mockResolvedValue({
      ok: true,
      message: 'applied and committed',
      result: {
        mutation: { ok: true, httpCode: 201, id: 'cz-new', message: 'create accepted' },
        commit: {
          attempted: true,
          ok: true,
          httpCode: 204,
          message: 'committed',
          warning: 'Tenant-wide commit may apply other staged changes.',
        },
        staged: false,
        cacheRefresh: { attempted: true, status: 'refreshed', message: 'SSE inventory cache refreshed' },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));

    await waitFor(() => expect(screen.getByText('New Connector zones')).toBeTruthy());
    const createButton = screen.getByRole('button', { name: /Create and commit/i });
    expect(createButton).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Branch zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    expect(createButton).toHaveProperty('disabled', false);

    fireEvent.click(createButton);
    await waitFor(() => expect(mockCreateSseObject).toHaveBeenCalledWith('connectorZones', expect.objectContaining({ name: 'Branch zone' })));
  });

  it('a staged (commit-failed) mutation shows the retry-commit banner, and retry never replays the mutation', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false } satisfies SseKindListing);
    mockCreateSseObject.mockResolvedValue({
      ok: true,
      message: 'applied, but the commit failed',
      result: {
        mutation: { ok: true, httpCode: 201, id: 'cz-new', message: 'create accepted' },
        commit: {
          attempted: true,
          ok: false,
          httpCode: 500,
          message: 'commit answered HTTP 500',
          warning: 'Tenant-wide commit may apply other staged changes.',
        },
        staged: true,
        cacheRefresh: { attempted: false, status: 'skipped', message: 'commit failed — cache was not refreshed' },
      },
    });
    mockRetrySseCommit.mockResolvedValue({
      ok: true,
      message: 'commit retried — now committed',
      result: {
        commit: {
          attempted: true,
          ok: true,
          httpCode: 204,
          message: 'committed',
          warning: 'Tenant-wide commit may apply other staged changes.',
        },
        cacheRefresh: { attempted: true, status: 'refreshed', message: 'SSE inventory cache refreshed' },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Staged zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));

    await waitFor(() => expect(screen.getByText(/mutation is staged because Commit was not accepted/i)).toBeTruthy());
    const retryButton = screen.getByRole('button', { name: 'Run recovery' });
    expect(retryButton).toHaveProperty('disabled', true);
    fireEvent.click(retryButton);
    expect(mockRetrySseCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/I reviewed this recovery/i));
    fireEvent.click(screen.getByRole('button', { name: 'Run recovery' }));
    await waitFor(() => expect(mockRetrySseCommit).toHaveBeenCalledWith(true));
    expect(mockCreateSseObject).toHaveBeenCalledTimes(1); // never replayed
  });

  it('describes commit-accepted recovery as cleanup and refresh, never as another Commit', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false });
    mockCreateSseObject.mockResolvedValue({
      ok: true,
      message: 'staged',
      result: {
        mutation: { ok: true, httpCode: 201, id: 'cz-new', message: 'create accepted' },
        commit: { attempted: true, ok: false, httpCode: 500, message: 'commit failed' },
        staged: true,
        outcome: 'staged',
        cacheRefresh: { attempted: false, status: 'skipped', message: 'commit failed' },
      },
    });
    mockRetrySseCommit.mockResolvedValue({
      ok: true,
      message: 'already accepted',
      result: {
        commit: {
          attempted: false,
          ok: true,
          httpCode: null,
          acceptance: 'accepted',
          message:
            'Commit was already accepted in a prior run — recovery only refreshed the cache and cleaned up the journal; Commit was not called again',
        },
        cacheRefresh: { attempted: true, status: 'refreshed', message: 'cache refreshed' },
        recovery: {
          journalPhase: 'commit-accepted',
          action: 'refresh-and-cleanup',
          mutationVerified: true,
          message: 'the target mutation is visible in a complete target-kind refresh',
        },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Recovered zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run recovery' })).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/I reviewed this recovery/i));
    fireEvent.click(screen.getByRole('button', { name: 'Run recovery' }));

    await waitFor(() => expect(screen.getByText(/Commit was already accepted in a prior run/i)).toBeTruthy());
    expect(screen.getByText(/Commit was not called again/i)).toBeTruthy();
    expect(screen.queryByText(/Commit was accepted during reviewed recovery/i)).toBeNull();
  });

  it('clears the durable banner after cleanup-only succeeds without replaying Commit', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false });
    mockCreateSseObject.mockResolvedValue({
      ok: true,
      message: 'staged',
      result: {
        mutation: { ok: true, httpCode: 201, id: 'cz-new', message: 'create accepted' },
        commit: { attempted: true, ok: false, httpCode: 500, message: 'commit rejected' },
        staged: true,
        outcome: 'staged',
        cacheRefresh: { attempted: false, status: 'skipped', message: 'commit rejected' },
      },
    });
    mockRetrySseCommit.mockResolvedValue({
      ok: true,
      message: 'the rejected mutation journal was cleaned up without calling tenant-wide Commit',
      result: {
        commit: {
          attempted: false,
          ok: false,
          httpCode: null,
          acceptance: 'not-attempted',
          message: 'the rejected mutation journal was cleaned up without calling Commit',
        },
        cacheRefresh: {
          attempted: false,
          status: 'skipped',
          message: 'the rejected mutation required no cache refresh',
        },
        recovery: {
          journalPhase: 'mutation-rejected',
          action: 'cleanup-only',
          mutationVerified: false,
          message: 'the rejected mutation journal was cleaned up without calling tenant-wide Commit',
        },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cleanup zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run recovery' })).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/I reviewed this recovery/i));
    fireEvent.click(screen.getByRole('button', { name: 'Run recovery' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Run recovery' })).toBeNull());
    expect(screen.getByText(/No tenant-wide Commit was replayed/i)).toBeTruthy();
    expect(screen.getByText(/Cached inventory skipped/i)).toBeTruthy();
    expect(screen.getByText(/required no cache refresh/i)).toBeTruthy();
    expect(mockRetrySseCommit).toHaveBeenCalledWith(true);
    expect(mockCreateSseObject).toHaveBeenCalledTimes(1);
    expect(mockGetSseKind).toHaveBeenCalledTimes(1);
  });

  it('keeps the durable banner when cleanup fails', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false });
    mockCreateSseObject.mockResolvedValue({
      ok: true,
      message: 'staged',
      result: {
        mutation: { ok: true, httpCode: 201, id: 'cz-new', message: 'create accepted' },
        commit: { attempted: true, ok: false, httpCode: 500, message: 'commit rejected' },
        staged: true,
        outcome: 'staged',
        cacheRefresh: { attempted: false, status: 'skipped', message: 'commit rejected' },
      },
    });
    mockRetrySseCommit.mockResolvedValue({
      ok: false,
      message: 'durable journal cleanup is still pending',
      code: 'SSE_JOURNAL_PERSIST_FAILED',
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cleanup failure zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run recovery' })).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/I reviewed this recovery/i));
    fireEvent.click(screen.getByRole('button', { name: 'Run recovery' }));

    await waitFor(() => expect(screen.getByText(/durable journal cleanup is still pending/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Run recovery' })).toBeTruthy();
    expect(screen.getByLabelText(/I reviewed this recovery/i)).toBeTruthy();
    expect(mockCreateSseObject).toHaveBeenCalledTimes(1);
  });

  it('reloads the listing-bound kind after a successful refreshed-cache retry before claiming current data', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    const refreshedListing = deferred<SseKindListing>();
    mockGetSseKind
      .mockResolvedValueOnce({ rows: [], total: 0, truncated: false, unavailable: false })
      .mockReturnValueOnce(refreshedListing.promise);
    mockCreateSseObject.mockResolvedValue({
      ok: true,
      message: 'applied, but the commit failed',
      result: {
        mutation: { ok: true, httpCode: 201, id: 'cz-new', message: 'create accepted' },
        commit: { attempted: true, ok: false, httpCode: 500, message: 'commit failed' },
        staged: true,
        cacheRefresh: { attempted: false, status: 'skipped', message: 'commit failed' },
      },
    });
    mockRetrySseCommit.mockResolvedValue({
      ok: true,
      message: 'committed',
      result: {
        commit: { attempted: true, ok: true, httpCode: 204, message: 'committed' },
        cacheRefresh: { attempted: true, status: 'refreshed', message: 'cache refreshed' },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Retried zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));
    await waitFor(() => expect(screen.getByText(/mutation is staged because Commit was not accepted/i)).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/I reviewed this recovery/i));
    fireEvent.click(screen.getByRole('button', { name: 'Run recovery' }));
    await waitFor(() => expect(mockGetSseKind).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/list below was reloaded/i)).toBeNull();

    await act(async () => {
      refreshedListing.resolve(listing('connectorZones', 'cz-new', 'Retried zone'));
      await refreshedListing.promise;
    });

    await waitFor(() => expect(screen.getByText('Retried zone')).toBeTruthy());
    expect(screen.getByText(/list below was reloaded from the refreshed cache/i)).toBeTruthy();
  });

  it('does not reload or claim freshness after a successful retry with a stale cache outcome', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false });
    mockCreateSseObject.mockResolvedValue({
      ok: true,
      message: 'applied, but the commit failed',
      result: {
        mutation: { ok: true, httpCode: 201, id: 'cz-new', message: 'create accepted' },
        commit: { attempted: true, ok: false, httpCode: 500, message: 'commit failed' },
        staged: true,
        cacheRefresh: { attempted: false, status: 'skipped', message: 'commit failed' },
      },
    });
    mockRetrySseCommit.mockResolvedValue({
      ok: true,
      message: 'committed',
      result: {
        commit: { attempted: true, ok: true, httpCode: 204, message: 'committed' },
        cacheRefresh: { attempted: true, status: 'stale', message: 'cache refresh timed out' },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Stale retry zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));
    await waitFor(() => expect(screen.getByText(/mutation is staged because Commit was not accepted/i)).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/I reviewed this recovery/i));
    fireEvent.click(screen.getByRole('button', { name: 'Run recovery' }));

    await waitFor(() => expect(screen.getByText(/Cached inventory stale/i)).toBeTruthy());
    expect(mockGetSseKind).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/list below is not confirmed current/i)).toBeTruthy();
    expect(screen.queryByText(/list below was reloaded/i)).toBeNull();
  });

  it('keeps unknown create recovery visible when the drawer closes while the mutation is applying', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false });
    const mutation = deferred<Awaited<ReturnType<typeof createSseObject>>>();
    mockCreateSseObject.mockReturnValue(mutation.promise);

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Closing zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByText('New Connector zones')).toBeNull();

    await act(async () => {
      mutation.resolve({
        ok: false,
        message: 'transport disconnected',
        result: {
          mutation: {
            ok: false,
            httpCode: null,
            acceptance: 'unknown',
            message: 'mutation acceptance is unknown',
          },
          commit: {
            attempted: false,
            ok: false,
            httpCode: null,
            acceptance: 'not-attempted',
            message: 'not attempted',
          },
          staged: true,
          outcome: 'unknown',
          cacheRefresh: { attempted: false, status: 'skipped', message: 'commit not confirmed' },
        },
      });
      await mutation.promise;
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          'Create for Closing zone: the mutation transport outcome is unknown. No automatic tenant-wide Commit is permitted. Manually reconcile the mutation and Commit status in the SSE admin console before cleanup. A durable journal is blocking further SSE changes.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/Manual reconciliation cleanup never calls tenant-wide Commit/i)).toBeTruthy();
    expect(
      screen.getByLabelText(
        'I reviewed this cleanup-only recovery and understand tenant-wide Commit will not be called.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'I attest that I manually reconciled the mutation and Commit outcome in the SSE admin console and authorize durable journal removal.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Attest manual reconciliation and remove journal' }),
    ).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Run recovery' })).toBeNull();
  });

  it('keeps unknown update recovery visible after the edit drawer closes', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue(listing('connectorZones', 'cz-1', 'HQ zone'));
    mockGetSseObject.mockResolvedValue({ ok: true, object: { id: 'cz-1', name: 'HQ zone' } });
    mockUpdateSseObject.mockResolvedValue(unknownMutationResult('commit'));

    renderPanel(true);
    await waitFor(() => expect(screen.getByText('HQ zone')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(screen.getByText('Edit Connector zones')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'HQ zone updated' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this update/i));
    fireEvent.click(screen.getByRole('button', { name: /Save and commit/i }));

    await waitFor(() =>
      expect(
        screen.getByText(
          'Update for HQ zone updated: the tenant-wide Commit transport outcome is unknown. No automatic tenant-wide Commit is permitted. Manually reconcile the mutation and Commit status in the SSE admin console before cleanup. A durable journal is blocking further SSE changes.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText('Edit Connector zones')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Attest manual reconciliation and remove journal' }),
    ).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Run recovery' })).toBeNull();
  });

  it('shows durable recovery for an unknown delete instead of treating ok:false as a generic failure', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue(listing('connectorZones', 'cz-1', 'HQ zone'));
    mockDeleteSseObject.mockResolvedValue(unknownMutationResult('mutation'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPanel(true);
    await waitFor(() => expect(screen.getByText('HQ zone')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(
        screen.getByText(
          'Delete of HQ zone: the mutation transport outcome is unknown. No automatic tenant-wide Commit is permitted. Manually reconcile the mutation and Commit status in the SSE admin console before cleanup. A durable journal is blocking further SSE changes.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/Manual reconciliation cleanup never calls tenant-wide Commit/i)).toBeTruthy();
    expect(
      screen.getByLabelText(
        'I reviewed this cleanup-only recovery and understand tenant-wide Commit will not be called.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'I attest that I manually reconciled the mutation and Commit outcome in the SSE admin console and authorize durable journal removal.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run recovery' })).toBeNull();
    expect(confirm).toHaveBeenCalledWith(
      'Delete HQ zone? The deletion will be staged and becomes effective only after SSE Commit is accepted. Commit is tenant-wide and may include other staged tenant changes. It is not reversible from here once committed.',
    );
    confirm.mockRestore();
  });

  it('attests manual reconciliation, sends both flags, shows refresh, and clears only after journal removal', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false });
    mockCreateSseObject.mockResolvedValue(unknownMutationResult('commit'));
    mockCleanupSseManualReconciliation.mockResolvedValue({
      ok: true,
      message: 'journal removed; tenant-wide Commit was not called',
      result: {
        commit: {
          attempted: false,
          ok: false,
          httpCode: null,
          acceptance: 'not-attempted',
          message: 'Tenant-wide Commit was not called during manual cleanup',
        },
        cacheRefresh: {
          attempted: true,
          status: 'stale',
          message: 'refresh completed partially',
        },
        recovery: {
          journalPhase: 'commit-transport-unknown',
          action: 'manual-cleanup',
          status: 'journal-removed',
          mutationVerified: false,
          message: 'journal removed; tenant-wide Commit was not called',
        },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ambiguous zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));

    const cleanupButton = await screen.findByRole('button', {
      name: 'Attest manual reconciliation and remove journal',
    });
    fireEvent.click(screen.getByLabelText(/I reviewed this cleanup-only recovery/i));
    expect(cleanupButton).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/I attest that I manually reconciled/i));
    fireEvent.click(cleanupButton);

    await waitFor(() =>
      expect(mockCleanupSseManualReconciliation).toHaveBeenCalledWith(true, true),
    );
    expect(mockRetrySseCommit).not.toHaveBeenCalled();
    expect(mockCreateSseObject).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'Attest manual reconciliation and remove journal',
        }),
      ).toBeNull(),
    );
    expect(screen.getByText(/Cached inventory stale/i)).toBeTruthy();
    expect(screen.getByText(/refresh completed partially/i)).toBeTruthy();
  });

  it('retains the manual cleanup banner and shows refresh status when journal deletion fails', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false });
    mockCreateSseObject.mockResolvedValue(unknownMutationResult('mutation'));
    mockCleanupSseManualReconciliation.mockResolvedValue({
      ok: false,
      message: 'internal error',
      code: 'SSE_JOURNAL_PERSIST_FAILED',
      result: {
        commit: {
          attempted: false,
          ok: false,
          httpCode: null,
          acceptance: 'not-attempted',
          message: 'Tenant-wide Commit was not called during manual cleanup',
        },
        cacheRefresh: {
          attempted: true,
          status: 'refreshed',
          message: 'cache refresh completed before deletion failed',
        },
        recovery: {
          journalPhase: 'mutation-transport-unknown',
          action: 'manual-cleanup',
          status: 'journal-retained',
          mutationVerified: false,
          message: 'journal retained; tenant-wide Commit was not called',
        },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Retained zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));
    fireEvent.click(await screen.findByLabelText(/I reviewed this cleanup-only recovery/i));
    fireEvent.click(screen.getByLabelText(/I attest that I manually reconciled/i));
    fireEvent.click(
      screen.getByRole('button', { name: 'Attest manual reconciliation and remove journal' }),
    );

    await waitFor(() => expect(screen.getByText(/Cached inventory refreshed/i)).toBeTruthy());
    expect(screen.getByText(/cache refresh completed before deletion failed/i)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Attest manual reconciliation and remove journal' }),
    ).toBeTruthy();
    expect(mockRetrySseCommit).not.toHaveBeenCalled();
  });

  it('surfaces the server commit warning and a refreshed-cache status', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false } satisfies SseKindListing);
    mockCreateSseObject.mockResolvedValue(committedMutation);

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    expect(screen.getByText(/Commit is tenant-wide/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewed zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));

    await waitFor(() => expect(screen.getByText(/Tenant-wide commit may apply other staged changes/i)).toBeTruthy());
    expect(screen.getByText(/Cached inventory refreshed/i)).toBeTruthy();
    expect(screen.getByText(/list below was reloaded from the refreshed cache/i)).toBeTruthy();
  });

  it('marks the cached list as not current when refresh is stale', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false } satisfies SseKindListing);
    mockCreateSseObject.mockResolvedValue({
      ...committedMutation,
      result: {
        ...committedMutation.result,
        cacheRefresh: { attempted: true, status: 'stale', message: 'SSE refresh did not complete' },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Stale zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));

    await waitFor(() => expect(screen.getByText(/Cached inventory stale/i)).toBeTruthy());
    expect(screen.getByText(/list below is not confirmed current/i)).toBeTruthy();
  });

  it('shows a skipped cache refresh even when the mutation fails', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false } satisfies SseKindListing);
    mockCreateSseObject.mockResolvedValue({
      ok: false,
      message: 'create rejected',
      result: {
        mutation: { ok: false, httpCode: 400, message: 'create rejected' },
        commit: { attempted: false, ok: false, httpCode: null, message: 'commit not attempted' },
        staged: false,
        cacheRefresh: { attempted: false, status: 'skipped', message: 'mutation failed — cache was not refreshed' },
      },
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rejected zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));

    await waitFor(() => expect(screen.getByText(/Cached inventory skipped/i)).toBeTruthy());
    expect(screen.getByText(/list below is not confirmed current/i)).toBeTruthy();
  });

  it('restores the durable recovery action from a structured pending-journal response after reload', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false } satisfies SseKindListing);
    mockCreateSseObject.mockResolvedValue({
      ok: false,
      message: 'durable recovery is required',
      pendingCommit: true,
    });

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Blocked zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));

    await waitFor(() => expect(screen.getByText(/Pending SSE recovery required/i)).toBeTruthy());
    expect(screen.getByText(/durable recovery is required/i)).toBeTruthy();
    expect(screen.getByLabelText(/I reviewed this recovery/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run recovery' })).toHaveProperty('disabled', true);
    expect(screen.queryByText('New Connector zones')).toBeNull();
  });

  it('the edit drawer loads the fresh object via getSseObject, not the cached summary row', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({
      rows: [{ kind: 'connectorZones', id: 'cz-1', name: 'HQ zone', raw: {} }],
      total: 1,
      truncated: false,
      unavailable: false,
    } satisfies SseKindListing);
    mockGetSseObject.mockResolvedValue({ ok: true, object: { id: 'cz-1', name: 'HQ zone (fresh)', description: 'from a fresh read' } });

    renderPanel(true);
    await waitFor(() => expect(screen.getByText('HQ zone')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    await waitFor(() => expect(mockGetSseObject).toHaveBeenCalledWith('connectorZones', 'cz-1'));
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('HQ zone (fresh)'));
  });

  it('keeps a create drawer bound to the kind it was opened for after selection changes', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockResolvedValue({ rows: [], total: 0, truncated: false, unavailable: false } satisfies SseKindListing);
    mockCreateSseObject.mockResolvedValue(committedMutation);

    renderPanel(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /New Connector Zone/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /New Connector Zone/i }));
    fireEvent.change(screen.getByLabelText('Object kind'), { target: { value: 'users' } });

    expect(screen.getByText('New Connector zones')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Anchored zone' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this create/i));
    fireEvent.click(screen.getByRole('button', { name: /Create and commit/i }));

    await waitFor(() =>
      expect(mockCreateSseObject).toHaveBeenCalledWith(
        'connectorZones',
        expect.objectContaining({ name: 'Anchored zone' }),
      ),
    );
  });

  it('keeps a deferred edit drawer and update bound to the rendered listing kind', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockImplementation(async (selectedKind) =>
      selectedKind === 'connectorZones'
        ? listing('connectorZones', 'cz-1', 'HQ zone')
        : { rows: [], total: 0, truncated: false, unavailable: false },
    );
    const detail = deferred<{ ok: boolean; object?: Record<string, unknown>; message?: string }>();
    mockGetSseObject.mockReturnValue(detail.promise);
    mockUpdateSseObject.mockResolvedValue(committedMutation);

    renderPanel(true);
    await waitFor(() => expect(screen.getByText('HQ zone')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(mockGetSseObject).toHaveBeenCalledWith('connectorZones', 'cz-1'));
    fireEvent.change(screen.getByLabelText('Object kind'), { target: { value: 'users' } });

    await act(async () => {
      detail.resolve({ ok: true, object: { id: 'cz-1', name: 'HQ zone fresh' } });
      await detail.promise;
    });
    await waitFor(() => expect(screen.getByText('Edit Connector zones')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'HQ zone updated' } });
    fireEvent.click(screen.getByLabelText(/I have reviewed this update/i));
    fireEvent.click(screen.getByRole('button', { name: /Save and commit/i }));

    await waitFor(() =>
      expect(mockUpdateSseObject).toHaveBeenCalledWith(
        'connectorZones',
        'cz-1',
        expect.objectContaining({ name: 'HQ zone updated' }),
      ),
    );
  });

  it('does not let a deferred delete refresh replace a newly selected kind', async () => {
    mockGetSseInventory.mockResolvedValue(null);
    mockGetSseKind.mockImplementation(async (selectedKind) =>
      selectedKind === 'connectorZones'
        ? listing('connectorZones', 'cz-1', 'HQ zone')
        : { rows: [], total: 0, truncated: false, unavailable: false },
    );
    const deletion = deferred<typeof committedMutation>();
    mockDeleteSseObject.mockReturnValue(deletion.promise);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPanel(true);
    await waitFor(() => expect(screen.getByText('HQ zone')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mockDeleteSseObject).toHaveBeenCalledWith('connectorZones', 'cz-1');
    fireEvent.change(screen.getByLabelText('Object kind'), { target: { value: 'users' } });
    await waitFor(() => expect(screen.getByText(/^No users$/i)).toBeTruthy());

    await act(async () => {
      deletion.resolve(committedMutation);
      await deletion.promise;
    });
    expect(screen.getByText(/^No users$/i)).toBeTruthy();
    expect(screen.queryByText('HQ zone')).toBeNull();
    expect(mockGetSseKind).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });
});
