/**
 * web/src/screens/CentralWebhooksPanel.test.tsx — New Central webhook
 * management panel embedded in Systems' Configuration tab.
 *
 * The api client is mocked at the module boundary — no real fetch. Covers:
 * list pagination/envelope rendering, an honest unavailable/permission-
 * denied/malformed-response state (never a fabricated empty list), search,
 * the review-gated PATCH-edit/delete flows, secret redaction (a freshly
 * opened edit drawer never carries a pre-filled apiKey/oidcClientSecret),
 * callback-URL validation blocking review, auth-mode-conditional fields, the
 * reviewed create/rotate one-time-secret flows, generation-conflict recovery
 * on PATCH, and unknown-outcome reconciliation with identity-bound,
 * secret-free persistence and explicit operator attestations.
 */

import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CentralWebhooksPanel } from './CentralWebhooksPanel';
import { ToastProvider } from '../nightdesk';
import {
  acknowledgeCentralWebhookHandoff,
  createCentralWebhook,
  deleteCentralWebhook,
  getCentralWebhook,
  getCentralWebhookHandoffStatus,
  getCentralWebhooks,
  resolveCentralWebhookHandoff,
  rotateCentralWebhookHmacKey,
  updateCentralWebhook,
} from '../api/client';
import type { WebhookDetail, WebhookListEnvelope, WebhookSummary } from '@hpe/shared';

const { mockLabConfigMode } = vi.hoisted(() => ({ mockLabConfigMode: vi.fn(() => ({ lab: false })) }));
vi.mock('../hooks/useLabConfigMode', () => ({ useLabConfigMode: mockLabConfigMode }));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getCentralWebhooks: vi.fn(),
    getCentralWebhook: vi.fn(),
    getCentralWebhookHandoffStatus: vi.fn(),
    acknowledgeCentralWebhookHandoff: vi.fn(),
    resolveCentralWebhookHandoff: vi.fn(),
    createCentralWebhook: vi.fn(),
    rotateCentralWebhookHmacKey: vi.fn(),
    updateCentralWebhook: vi.fn(),
    deleteCentralWebhook: vi.fn(),
  };
});

const mockList = vi.mocked(getCentralWebhooks);
const mockGet = vi.mocked(getCentralWebhook);
const mockHandoffStatus = vi.mocked(getCentralWebhookHandoffStatus);
const mockAcknowledgeHandoff = vi.mocked(acknowledgeCentralWebhookHandoff);
const mockResolveHandoff = vi.mocked(resolveCentralWebhookHandoff);
const mockCreate = vi.mocked(createCentralWebhook);
const mockRotate = vi.mocked(rotateCentralWebhookHmacKey);
const mockUpdate = vi.mocked(updateCentralWebhook);
const mockDelete = vi.mocked(deleteCentralWebhook);

function row(overrides: Partial<WebhookSummary> = {}): WebhookSummary {
  return {
    id: 'wh-1',
    name: 'servicenow-incidents',
    endpoint: 'https://example.service-now.com/hooks',
    authMechanism: 'API_KEY',
    generation: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

type WritableWebhookListEnvelope = WebhookListEnvelope & { canWrite: boolean };

function envelope(overrides: Partial<WritableWebhookListEnvelope> = {}): WritableWebhookListEnvelope {
  const result: WritableWebhookListEnvelope = {
    items: [row()],
    totalCount: 1,
    count: 1,
    limit: 10,
    offset: 0,
    hasMore: false,
    source: 'central live',
    gatewayBaseUrl: 'https://us1.api.central.arubanetworks.com',
    tenantBinding: 'a'.repeat(64),
    canWrite: true,
    ...overrides,
  };
  if (result.items.length === 0 && !result.error && !Object.prototype.hasOwnProperty.call(overrides, 'note')) {
    result.note = 'Central returned no webhook rows.';
  }
  return result;
}

function detail(overrides: Partial<WebhookDetail> = {}): WebhookDetail {
  return {
    ...row(),
    apiKeyConfigured: true,
    oidcClientSecretConfigured: false,
    ...overrides,
  };
}

function renderPanel(initialEntry = '/systems?plane=central&tab=config') {
  return render(
    <MemoryRouter
      initialEntries={[initialEntry]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <ToastProvider>
        <CentralWebhooksPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** A never-resolves-until-you-say-so promise, for deterministically
 *  reproducing "the older request finishes after the newer one" races
 *  without relying on timers or incidental scheduling order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockHandoffStatus.mockResolvedValue({ pending: false });
  mockAcknowledgeHandoff.mockResolvedValue({
    ok: true,
    operationId: 'acknowledged-op',
    resolution: 'secret-stored',
    message: 'cleared',
  });
  mockResolveHandoff.mockImplementation(async (input) => ({
    ok: true,
    operationId: input.operationId,
    resolution: input.resolution,
    ...(input.matchedWebhookId ? { webhookId: input.matchedWebhookId } : {}),
    message: 'cleared',
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockLabConfigMode.mockReturnValue({ lab: false });
});

async function submitReviewedCreate(
  name = 'new-hook',
  endpoint = 'https://hooks.example.com/new',
) {
  fireEvent.click(screen.getByRole('button', { name: 'New webhook' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Target URL'), { target: { value: endpoint } });
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-api-key' } });
  fireEvent.click(screen.getByLabelText(/reviewed this exact webhook creation/i));
  fireEvent.click(screen.getByLabelText(/returned HMAC key is one-time/i));
  fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));
  await screen.findByText('Outcome unknown');
}

async function submitReviewedRotation(buttonIndex = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: 'Rotate HMAC' })[buttonIndex]);
  fireEvent.click(screen.getByLabelText(/reviewed this exact HMAC rotation/i));
  fireEvent.click(screen.getByLabelText(/returned HMAC key is one-time/i));
  fireEvent.click(screen.getByRole('button', { name: 'Rotate HMAC key' }));
  await screen.findByText('Outcome unknown');
}

describe('list, pagination, and envelope states', () => {
  it('renders rows from the envelope', async () => {
    mockList.mockResolvedValue(envelope());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    expect(screen.getByText('https://example.service-now.com/hooks')).toBeTruthy();
    expect(screen.getByText('API_KEY')).toBeTruthy();
  });

  it('keeps list and reconciliation reads available but disables vendor mutations without write scope', async () => {
    mockList.mockResolvedValue(envelope({ canWrite: false }));
    renderPanel();

    await screen.findByText('servicenow-incidents');
    expect(screen.getByText(/read-only connector grant/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New webhook' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Rotate HMAC' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveProperty('disabled', true);
  });

  it('shows pagination controls only when more than one page is reported, and requests the right offset', async () => {
    mockList.mockResolvedValue(envelope({ totalCount: 25, hasMore: true }));
    renderPanel();
    await waitFor(() => expect(mockList).toHaveBeenCalledWith({ limit: 10, offset: 0, q: '' }));
    const page2 = await screen.findByRole('button', { name: 'Page 2' });
    fireEvent.click(page2);
    await waitFor(() => expect(mockList).toHaveBeenCalledWith({ limit: 10, offset: 10, q: '' }));
  });

  it('a single page never renders pagination controls', async () => {
    mockList.mockResolvedValue(envelope());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Page 2/ })).toBeNull();
  });

  it('an unlinked/unsupported Central answers an honest unavailable state, never a fabricated empty list', async () => {
    mockList.mockResolvedValue(
      envelope({ items: [], totalCount: 0, count: 0, error: 'Central Classic — webhook management requires the New Central gateway', gatewayBaseUrl: null }),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText('Webhooks unavailable')).toBeTruthy());
    expect(screen.getByText(/requires the New Central gateway/)).toBeTruthy();
  });

  it('a permission-denied list read reports the denial honestly', async () => {
    mockList.mockResolvedValue(
      envelope({ items: [], totalCount: 0, count: 0, error: 'central denied the request listing webhooks (HTTP 403) — HPE_GL_ERROR_FORBIDDEN' }),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText(/HTTP 403/)).toBeTruthy());
  });

  it('a malformed response is reported distinctly, never rendered as an empty success', async () => {
    mockList.mockResolvedValue(
      envelope({ items: [], totalCount: 0, count: 0, error: 'the portal returned a successful but unrecognized webhook list response' }),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText(/unrecognized webhook list response/)).toBeTruthy());
  });

  it('a genuinely empty (but available) list says so distinctly from unavailable', async () => {
    mockList.mockResolvedValue(envelope({ items: [], totalCount: 0, count: 0 }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('No webhooks')).toBeTruthy());
    expect(screen.getByText(/Central returned no webhook rows/)).toBeTruthy();
  });

  it('does not render none configured for an empty response without honest provenance', async () => {
    mockList.mockResolvedValue(envelope({ items: [], totalCount: 0, count: 0, note: undefined }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('Webhooks unavailable')).toBeTruthy());
    expect(screen.getByText(/without recognized empty-list provenance/)).toBeTruthy();
    expect(screen.queryByText('No webhooks')).toBeNull();
  });

  it('searching re-queries with the trimmed query text', async () => {
    mockList.mockResolvedValue(envelope());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search webhooks'), { target: { value: '  noc  ' } });
    fireEvent.keyDown(screen.getByLabelText('Search webhooks'), { key: 'Enter' });
    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith({ limit: 10, offset: 0, q: 'noc' }));
  });

  it('Copy view link shares Systems Central config deep-link (no secrets)', async () => {
    mockList.mockResolvedValue(envelope());
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    await waitFor(() =>
      expect(clipboard.writeText).toHaveBeenCalledWith(
        expect.stringMatching(/\/systems\?plane=central&tab=config$/),
      ),
    );
    expect(await screen.findByText(/view link copied/i)).toBeTruthy();
  });

  it('Export CSV dumps summary fields only (never secrets)', async () => {
    const csv = await import('../lib/csv');
    const spy = vi.spyOn(csv, 'exportTableCsv').mockReturnValue(1);
    mockList.mockResolvedValue(envelope());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(spy).toHaveBeenCalledWith(
      'central-webhooks.csv',
      ['id', 'name', 'endpoint', 'authMechanism', 'generation', 'createdAt', 'updatedAt'],
      [
        [
          'wh-1',
          'servicenow-incidents',
          'https://example.service-now.com/hooks',
          'API_KEY',
          1,
          '2026-01-01T00:00:00Z',
          '2026-02-01T00:00:00Z',
        ],
      ],
    );
    expect(await screen.findByText(/exported 1 webhook/i)).toBeTruthy();
    spy.mockRestore();
  });

  it('hides Export CSV when the list is empty', async () => {
    mockList.mockResolvedValue(envelope({ items: [], totalCount: 0, count: 0 }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('No webhooks')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Copy view link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });
});

describe('reviewed one-time HMAC workflow', () => {
  it('in lab mode omits review confirmation but keeps the one-time HMAC acknowledgement and tenant binding', async () => {
    mockLabConfigMode.mockReturnValue({ lab: true });
    mockList.mockResolvedValue(envelope());
    mockCreate.mockResolvedValue({ ok: true, action: 'created', operationId: 'lab-create', hmacKey: 'one-time', message: 'copy now' });
    renderPanel();
    await screen.findByText('servicenow-incidents');
    fireEvent.click(screen.getByRole('button', { name: 'New webhook' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'lab-hook' } });
    fireEvent.change(screen.getByLabelText('Target URL'), { target: { value: 'https://hooks.example.com/lab' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'lab-api-key' } });
    expect(screen.queryByLabelText(/reviewed this exact webhook creation/i)).toBeNull();
    const submit = screen.getByRole('button', { name: 'Create webhook' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/returned HMAC key is one-time/i));
    fireEvent.click(submit);
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'lab-hook' }), undefined, true, 'a'.repeat(64)));
  });

  it('offers create and rotate without a demo/config-mode gate', async () => {
    mockList.mockResolvedValue(envelope());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());

    expect(screen.getByRole('button', { name: 'New webhook' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Rotate HMAC' })).toHaveProperty('disabled', false);
    expect(screen.getByText('One-time HMAC secure handoff')).toBeTruthy();
  });

  it('requires both the reviewed-create confirmation and one-time-secret acknowledgement', async () => {
    mockList.mockResolvedValue(envelope());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New webhook' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-hook' } });
    fireEvent.change(screen.getByLabelText('Target URL'), { target: { value: 'https://hooks.example.com/new' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-api-key' } });

    const submit = screen.getByRole('button', { name: 'Create webhook' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/reviewed this exact webhook creation/i));
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/returned HMAC key is one-time/i));
    expect(submit).toHaveProperty('disabled', false);
  });

  it('shows create success only in a masked one-time modal, supports reveal/copy, then permanently clears it', async () => {
    const hmacKey = 'ui-create-one-time-hmac';
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    mockList.mockResolvedValue(envelope());
    mockCreate.mockResolvedValue({
      ok: true,
      action: 'created',
      operationId: 'create-success',
      hmacKey,
      message: 'copy now',
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New webhook' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-hook' } });
    fireEvent.change(screen.getByLabelText('Target URL'), { target: { value: 'https://hooks.example.com/new' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-api-key' } });
    fireEvent.click(screen.getByLabelText(/reviewed this exact webhook creation/i));
    fireEvent.click(screen.getByLabelText(/returned HMAC key is one-time/i));
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));

    await screen.findByText('Copy the one-time HMAC key now');
    expect(screen.queryByText(hmacKey)).toBeNull();
    expect(screen.getByText(/GET cannot retrieve this secret later/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    expect(screen.getByText(hmacKey)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy HMAC key' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(hmacKey));
    expect(screen.getByText('Copied to clipboard.')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/copied this HMAC key into the receiver's secure secret store/i));
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge stored and clear handoff' }));
    await waitFor(() =>
      expect(mockAcknowledgeHandoff).toHaveBeenCalledWith('create-success', true),
    );
    expect(document.body.textContent).not.toContain(hmacKey);
    expect(screen.queryByText('Copy the one-time HMAC key now')).toBeNull();
    expect(document.querySelector('.nd-toast-region')?.textContent).not.toContain(hmacKey);
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('applies the same two acknowledgements and one-time modal to HMAC rotation', async () => {
    const hmacKey = 'ui-rotate-one-time-hmac';
    mockList.mockResolvedValue(envelope());
    mockRotate.mockResolvedValue({
      ok: true,
      action: 'rotated',
      operationId: 'rotate-success',
      hmacKey,
      message: 'copy now',
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Rotate HMAC' }));
    const rotate = screen.getByRole('button', { name: 'Rotate HMAC key' });
    expect(rotate).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/reviewed this exact HMAC rotation/i));
    expect(rotate).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/returned HMAC key is one-time/i));
    fireEvent.click(rotate);

    await screen.findByText('Copy the one-time HMAC key now');
    expect(mockRotate).toHaveBeenCalledWith('wh-1', true, true, 'a'.repeat(64));
    expect(screen.queryByText(hmacKey)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal key' }));
    expect(screen.getByText(hmacKey)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/copied this HMAC key into the receiver's secure secret store/i));
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge stored and clear handoff' }));
    await waitFor(() =>
      expect(mockAcknowledgeHandoff).toHaveBeenCalledWith('rotate-success', true),
    );
    expect(document.body.textContent).not.toContain(hmacKey);
  });
});

describe('create/rotate unknown outcomes require reconciliation before a new reviewed request', () => {
  it('uses a complete unfiltered lookup independent of the active search and finds the exact reviewed candidate', async () => {
    const candidate = row({
      id: 'wh-new',
      name: 'new-hook',
      endpoint: 'https://hooks.example.com/new',
      authMechanism: 'API_KEY',
    });
    mockList
      .mockResolvedValueOnce(envelope())
      .mockResolvedValueOnce(envelope({ items: [], totalCount: 0, count: 0 }))
      .mockResolvedValueOnce(envelope({ items: [candidate] }));
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValue(
      detail({
        id: 'wh-new',
        name: 'new-hook',
        endpoint: 'https://hooks.example.com/new',
      }),
    );
    mockCreate.mockResolvedValue({
      error: 'create result lost',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
      operationId: 'create-unknown-1',
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search webhooks'), { target: { value: 'excluded' } });
    fireEvent.keyDown(screen.getByLabelText('Search webhooks'), { key: 'Enter' });
    await waitFor(() => expect(mockList).toHaveBeenCalledWith({ limit: 10, offset: 0, q: 'excluded' }));
    await submitReviewedCreate();
    expect(screen.getByLabelText('API key')).toHaveProperty('value', '');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Run unfiltered reconciliation' }));
    await screen.findByText('Webhook likely created');
    expect(mockList).toHaveBeenLastCalledWith({ limit: 50, offset: 0, q: '' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Create webhook' })).toBeNull();
    expect(screen.getByText(/another POST could duplicate it/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/attest this is the webhook created/i));
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear handoff and review replacement rotation' }),
    );
    expect(await screen.findByText('Rotate HMAC for new-hook')).toBeTruthy();
    expect(mockResolveHandoff).toHaveBeenCalledWith({
      operationId: 'create-unknown-1',
      resolution: 'create-located',
      reviewConfirmed: true,
      attestations: { candidateLocated: true },
      matchedWebhookId: 'wh-new',
    });
    expect(screen.getByLabelText(/reviewed this exact HMAC rotation/i)).toHaveProperty('checked', false);
  });

  it('checks every unfiltered page before concluding a create candidate is present', async () => {
    const candidate = row({
      id: 'wh-new',
      name: 'new-hook',
      endpoint: 'https://hooks.example.com/new',
    });
    mockList
      .mockResolvedValueOnce(envelope())
      .mockResolvedValueOnce(envelope({ items: [row()], totalCount: 2, count: 1, limit: 50, offset: 0, hasMore: true }))
      .mockResolvedValueOnce(envelope({ items: [candidate], totalCount: 2, count: 1, limit: 50, offset: 1, hasMore: false }));
    mockCreate.mockResolvedValue({
      error: 'malformed successful create response',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
      operationId: 'create-unknown-2',
    });
    renderPanel();
    await screen.findByText('servicenow-incidents');
    await submitReviewedCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Run unfiltered reconciliation' }));
    await screen.findByText('Webhook likely created');
    expect(mockList).toHaveBeenNthCalledWith(2, { limit: 50, offset: 0, q: '' });
    expect(mockList).toHaveBeenNthCalledWith(3, { limit: 50, offset: 1, q: '' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps create blocked when the candidate is absent until the explicit post-refresh attestation', async () => {
    mockList
      .mockResolvedValueOnce(envelope())
      .mockResolvedValueOnce(envelope({ items: [], totalCount: 0, count: 0 }));
    mockCreate.mockResolvedValue({
      error: 'create result lost',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
      operationId: 'create-unknown-3',
    });
    renderPanel();
    await screen.findByText('servicenow-incidents');
    await submitReviewedCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Run unfiltered reconciliation' }));
    const unlock = await screen.findByRole('button', {
      name: 'Allow a new create despite eventual-consistency risk',
    });
    expect(unlock).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Create webhook' })).toBeNull();
    fireEvent.click(unlock);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('unlocks a fresh create only after absence attestation and requires a new review', async () => {
    mockList
      .mockResolvedValueOnce(envelope())
      .mockResolvedValueOnce(envelope({ items: [], totalCount: 0, count: 0 }));
    mockCreate.mockResolvedValue({
      error: 'create result lost',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
      operationId: 'create-unknown-4',
    });
    renderPanel();
    await screen.findByText('servicenow-incidents');
    await submitReviewedCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Run unfiltered reconciliation' }));
    const attestation = await screen.findByLabelText(/I checked Central and explicitly confirm/i);
    fireEvent.click(attestation);
    fireEvent.click(screen.getByRole('button', { name: 'Allow a new create despite eventual-consistency risk' }));
    expect(await screen.findByText(/this new POST may create a duplicate/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create webhook' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Name')).toHaveProperty('value', '');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('uses lab recovery language without claiming a review after an unknown create', async () => {
    mockLabConfigMode.mockReturnValue({ lab: true });
    mockList
      .mockResolvedValueOnce(envelope())
      .mockResolvedValueOnce(envelope({ items: [], totalCount: 0, count: 0 }));
    mockCreate.mockResolvedValue({
      error: 'create result lost',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
      operationId: 'create-unknown-lab',
    });
    renderPanel();
    await screen.findByText('servicenow-incidents');
    fireEvent.click(screen.getByRole('button', { name: 'New webhook' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-hook' } });
    fireEvent.change(screen.getByLabelText('Target URL'), { target: { value: 'https://hooks.example.com/new' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-api-key' } });
    expect(screen.queryByLabelText(/reviewed this exact webhook creation/i)).toBeNull();
    fireEvent.click(screen.getByLabelText(/returned HMAC key is one-time/i));
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));

    await screen.findByText('Outcome unknown');
    fireEvent.click(screen.getByRole('button', { name: 'Run unfiltered reconciliation' }));
    const attestation = await screen.findByLabelText(/exact submitted webhook is absent/i);
    expect(screen.queryByLabelText(/exact reviewed webhook is absent/i)).toBeNull();
    fireEvent.click(attestation);
    fireEvent.click(screen.getByRole('button', { name: 'Allow a new create despite eventual-consistency risk' }));
    expect(await screen.findByText(/Build a new create request/)).toBeTruthy();
    expect(screen.queryByText(/Build and review a new create request/)).toBeNull();
  });

  it('an eventual refresh can change absent to found and removes the absence unlock', async () => {
    const candidate = row({
      id: 'wh-eventual',
      name: 'new-hook',
      endpoint: 'https://hooks.example.com/new',
    });
    mockList
      .mockResolvedValueOnce(envelope())
      .mockResolvedValueOnce(envelope({ items: [], totalCount: 0, count: 0 }))
      .mockResolvedValueOnce(envelope({ items: [candidate] }));
    mockCreate.mockResolvedValue({
      error: 'create result lost',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
      operationId: 'create-unknown-5',
    });
    renderPanel();
    await screen.findByText('servicenow-incidents');
    await submitReviewedCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Run unfiltered reconciliation' }));
    await screen.findByLabelText(/I checked Central and explicitly confirm/i);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh unfiltered reconciliation' }));
    await screen.findByText('Webhook likely created');
    expect(screen.queryByLabelText(/I checked Central and explicitly confirm/i)).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a rotate detail GET stays blocked until dedicated dual reconciliation and then requires a new review', async () => {
    mockList.mockResolvedValue(envelope());
    mockRotate.mockResolvedValue({
      error: 'rotate result lost',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
      operationId: 'rotate-unknown-1',
    });
    mockGet.mockResolvedValue(detail({ generation: 2 }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    await submitReviewedRotation();
    fireEvent.click(screen.getByRole('button', { name: 'Refetch webhook details' }));
    expect(mockRotate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('wh-1'));
    const allow = screen.getByRole('button', { name: 'Allow a new reviewed rotation' });
    expect(allow).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Rotate HMAC key' })).toBeNull();
    fireEvent.click(screen.getByLabelText(/reconciled the receiver and delivery state/i));
    expect(allow).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/reconciled Central's key state or performed an external verification/i));
    expect(allow).toHaveProperty('disabled', false);
    fireEvent.click(allow);
    const rotate = await screen.findByRole('button', { name: 'Rotate HMAC key' });
    expect(rotate).toHaveProperty('disabled', true);
    expect(screen.getByLabelText(/reviewed this exact HMAC rotation/i)).toHaveProperty('checked', false);
    expect(screen.getByLabelText(/returned HMAC key is one-time/i)).toHaveProperty('checked', false);
    expect(mockRotate).toHaveBeenCalledTimes(1);
  });

  it('labels a reconciled lab rotation as a new rotation without inventing review', async () => {
    mockLabConfigMode.mockReturnValue({ lab: true });
    mockList.mockResolvedValue(envelope());
    mockRotate.mockResolvedValue({
      error: 'rotate result lost',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
      operationId: 'rotate-unknown-lab',
    });
    mockGet.mockResolvedValue(detail({ generation: 2 }));
    renderPanel();
    await screen.findByText('servicenow-incidents');
    fireEvent.click(screen.getByRole('button', { name: 'Rotate HMAC' }));
    expect(screen.queryByLabelText(/reviewed this exact HMAC rotation/i)).toBeNull();
    fireEvent.click(screen.getByLabelText(/returned HMAC key is one-time/i));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate HMAC key' }));

    await screen.findByText('Outcome unknown');
    fireEvent.click(screen.getByRole('button', { name: 'Refetch webhook details' }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('wh-1'));
    expect(screen.getByRole('button', { name: 'Allow a new rotation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow a new reviewed rotation' })).toBeNull();
  });

  it('blocks overlapping create/rotate and reloads the exact pending rotation after remount', async () => {
    const rowB = row({ id: 'wh-2', name: 'noc-pager', endpoint: 'https://noc.example/hook' });
    mockList.mockResolvedValue(envelope({ items: [row(), rowB], totalCount: 2, count: 2 }));
    mockRotate.mockResolvedValue({
      error: 'rotate result lost',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
      operationId: 'rotate-unknown-2',
    });
    const rendered = renderPanel();
    await screen.findByText('servicenow-incidents');
    await submitReviewedRotation(0);
    fireEvent.click(screen.getByLabelText('Close dialog'));

    expect(screen.getByRole('button', { name: 'New webhook' })).toHaveProperty('disabled', true);
    for (const button of screen.getAllByRole('button', { name: 'Rotate HMAC' })) {
      expect(button).toHaveProperty('disabled', true);
    }

    rendered.unmount();
    mockHandoffStatus.mockResolvedValue({
      pending: true,
      operation: {
        operationId: 'rotate-unknown-2',
        opType: 'rotate',
        state: 'outcome-unknown',
        webhookId: 'wh-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        fingerprintMatches: true,
      },
    });
    renderPanel();
    await screen.findByText('servicenow-incidents');
    expect(screen.getByText(/Pending webhook handoff · rotate-unknown-2/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile pending rotation' }));
    expect(await screen.findByText('Outcome unknown')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refetch webhook details' })).toBeTruthy();
    expect(mockRotate).toHaveBeenCalledTimes(1);
  });

  it('drops an in-flight one-time result on StrictMode unmount without rendering or toasting the secret', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = deferred<{
      ok: true;
      action: 'created';
      operationId: string;
      hmacKey: string;
      message: string;
    }>();
    const hmacKey = 'strictmode-unmounted-hmac';
    mockList.mockResolvedValue(envelope());
    mockCreate.mockReturnValueOnce(result.promise);
    const rendered = render(
      <MemoryRouter
        initialEntries={['/systems?plane=central&tab=config']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <StrictMode>
          <ToastProvider>
            <CentralWebhooksPanel />
          </ToastProvider>
        </StrictMode>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New webhook' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-hook' } });
    fireEvent.change(screen.getByLabelText('Target URL'), { target: { value: 'https://hooks.example.com/new' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-api-key' } });
    fireEvent.click(screen.getByLabelText(/reviewed this exact webhook creation/i));
    fireEvent.click(screen.getByLabelText(/returned HMAC key is one-time/i));
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));
    rendered.unmount();
    await act(async () => {
      result.resolve({
        ok: true,
        action: 'created',
        operationId: 'create-unmounted',
        hmacKey,
        message: 'copy now',
      });
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain(hmacKey);
    expect(mockAcknowledgeHandoff).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('loads a secret-issued create journal after restart with canonical recovery guidance', async () => {
    mockList.mockResolvedValue(envelope());
    mockHandoffStatus.mockResolvedValue({
      pending: true,
      operation: {
        operationId: 'restart-create-op',
        opType: 'create',
        state: 'secret-issued-awaiting-handoff',
        candidate: {
          name: 'canonical hook',
          endpoint: 'https://hooks.example.com/canonical',
          authMechanism: 'OIDC',
          oidcClientId: 'client-id',
          oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
        },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        fingerprintMatches: true,
      },
    });

    renderPanel();

    expect(await screen.findByText(/Pending webhook handoff · restart-create-op/i)).toBeTruthy();
    expect(screen.getByText(/one-time key is unrecoverable after navigation/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New webhook' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile pending create' }));
    expect(await screen.findByText('Outcome unknown')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'canonical hook');
    expect(screen.getByLabelText('OIDC client ID')).toHaveProperty('value', 'client-id');
    expect(screen.getByLabelText('OIDC client secret')).toHaveProperty('value', '');
  });
});

describe('edit — secret redaction, generation, and diff', () => {
  it('opens with the API key field blank even though the webhook already has one configured, and shows the generation', async () => {
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValue(detail({ apiKeyConfigured: true, generation: 5 }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('wh-1'));
    const apiKeyInput = (await screen.findByLabelText('API key')) as HTMLInputElement;
    expect(apiKeyInput.value).toBe('');
    expect(apiKeyInput.type).toBe('password');
    expect(screen.getByText(/must be re-entered on every update/)).toBeTruthy();
    expect(screen.getByText(/generation 5/)).toBeTruthy();
  });

  it('opens an OIDC webhook with clientId shown but clientSecret blank', async () => {
    mockList.mockResolvedValue(envelope({ items: [row({ authMechanism: 'OIDC' })] }));
    mockGet.mockResolvedValue(
      detail({
        authMechanism: 'OIDC',
        apiKeyConfigured: false,
        oidcClientId: 'existing-client-id',
        oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
        oidcClientSecretConfigured: true,
      }),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const clientIdInput = (await screen.findByLabelText('OIDC client ID')) as HTMLInputElement;
    expect(clientIdInput.value).toBe('existing-client-id');
    const secretInput = screen.getByLabelText('OIDC client secret') as HTMLInputElement;
    expect(secretInput.value).toBe('');
  });

  it('shows a non-secret diff line for a renamed endpoint and never a value for the secret field', async () => {
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValue(detail());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('API key');
    fireEvent.change(screen.getByLabelText('Target URL'), { target: { value: 'https://new-endpoint.example/hook' } });
    expect(screen.getByText(/- endpoint: https:\/\/example\.service-now\.com\/hooks/)).toBeTruthy();
    expect(screen.getByText(/\+ endpoint: https:\/\/new-endpoint\.example\/hook/)).toBeTruthy();
    expect(screen.queryByText(/secret-key-123/)).toBeNull();
  });

  it('requires the secret to be re-entered before Save changes is enabled', async () => {
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValue(detail());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('API key');
    fireEvent.click(screen.getByLabelText(/I reviewed this exact update/i));
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'fresh-key' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact update/i));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false));
  });

  it('never displays "Create webhook" — edit always saves via "Save changes"', async () => {
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValue(detail());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('API key');
    expect(screen.queryByRole('button', { name: 'Create webhook' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  });
});

describe('update — PATCH with expected generation', () => {
  it('applies an update via a PATCH request carrying the loaded generation', async () => {
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValue(detail({ generation: 3 }));
    mockUpdate.mockResolvedValue({ ok: true, action: 'patched', message: 'webhook patched' });
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('API key');
    expect(screen.getByText(/PATCH /)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'renewed-key' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact update/i));
    const saveButton = await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save changes' });
      expect(btn).toHaveProperty('disabled', false);
      return btn;
    });
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith('wh-1', expect.objectContaining({ apiKey: 'renewed-key' }), true, 3),
    );
  });

  it('recovers from a generation conflict: refetches the latest webhook, invalidates the review, and shows the conflict', async () => {
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValueOnce(detail({ generation: 3, endpoint: 'https://example.service-now.com/hooks' }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('API key');

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'renewed-key' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact update/i));
    const saveButton = await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save changes' });
      expect(btn).toHaveProperty('disabled', false);
      return btn;
    });

    mockUpdate.mockResolvedValueOnce({ ok: false, action: 'conflict', httpCode: 409, message: 'generation conflict' });
    mockGet.mockResolvedValueOnce(
      detail({ generation: 4, endpoint: 'https://changed-elsewhere.example/hook', apiKeyConfigured: true }),
    );
    fireEvent.click(saveButton);

    await waitFor(() => expect(screen.getByText(/generation conflict/i)).toBeTruthy());
    // The refetch pulled in the new generation/endpoint and invalidated the
    // stale review — Save is disabled again until re-reviewed.
    await waitFor(() => expect(screen.getByText(/generation 4/)).toBeTruthy());
    expect((screen.getByLabelText('Target URL') as HTMLInputElement).value).toBe('https://changed-elsewhere.example/hook');
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    expect(screen.queryByLabelText(/I reviewed this exact update/i)).toHaveProperty('checked', false);
  });
});

describe('unknown mutation outcomes (transport/502) — retry block and required refetch', () => {
  it('an update: a 502 "outcome unknown" answer clears review, blocks the Save button, and requires a refetch before retrying', async () => {
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValueOnce(detail({ generation: 1 }));
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('API key');

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'renewed-key' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact update/i));
    const saveButton = await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save changes' });
      expect(btn).toHaveProperty('disabled', false);
      return btn;
    });

    mockUpdate.mockResolvedValueOnce({ error: 'cannot reach the portal backend: socket hang up', offline: true });
    fireEvent.click(saveButton);

    await waitFor(() => expect(screen.getByText(/outcome is unknown/i)).toBeTruthy());
    // The reviewed checkbox is gone — retry is blocked until a refetch, not
    // merely re-checkable.
    expect(screen.queryByLabelText(/I reviewed this exact update/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);

    mockGet.mockResolvedValueOnce(detail({ generation: 2 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refetch latest webhook' }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/generation 2/)).toBeTruthy());
    // Reconciled — the reviewed checkbox is back, but unchecked, so another
    // Save still requires a fresh, explicit review.
    expect(screen.getByLabelText(/I reviewed this exact update/i)).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
  });

  it('a delete: a 502 answer clears review, blocks Delete, and requires a list refetch before retrying', async () => {
    mockList.mockResolvedValue(envelope());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByLabelText(/I reviewed this delete/i));
    const deleteButton = await screen.findByRole('button', { name: 'Delete webhook' });

    mockDelete.mockResolvedValueOnce({ error: 'central did not answer deleting the webhook; the outcome is unknown', httpCode: 502 });
    fireEvent.click(deleteButton);

    await waitFor(() => expect(screen.getByText(/outcome is unknown/i)).toBeTruthy());
    expect(screen.queryByLabelText(/I reviewed this delete/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete webhook' })).toHaveProperty('disabled', true);

    mockList.mockResolvedValueOnce(envelope({ items: [], totalCount: 0, count: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refetch list' }));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    // Reconciled — the reviewed checkbox is back, unchecked, requiring a
    // fresh explicit review before another delete attempt.
    expect(screen.getByLabelText(/I reviewed this delete/i)).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Delete webhook' })).toHaveProperty('disabled', true);
  });

  it('a definite (non-transport) failure, like "not linked", allows immediate retry and does not require a refetch', async () => {
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValue(detail());
    mockUpdate.mockResolvedValueOnce({ ok: false, action: 'failed', message: 'central is not linked — cannot patch a webhook' });
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('API key');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'renewed-key' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact update/i));
    const saveButton = await screen.findByRole('button', { name: 'Save changes' });
    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.getByText('central is not linked — cannot patch a webhook')).toBeTruthy());
    // Reviewed stays checked and Save stays enabled — this is a known,
    // definite outcome, not an ambiguous one; no refetch is forced.
    expect(screen.getByLabelText(/I reviewed this exact update/i)).toHaveProperty('checked', true);
    expect(saveButton).toHaveProperty('disabled', false);
  });
});

describe('delete — review gate and secret-free outcomes', () => {
  it('requires review before Delete, then calls deleteCentralWebhook and reloads the list', async () => {
    mockList.mockResolvedValue(envelope());
    mockDelete.mockResolvedValue({ ok: true, action: 'deleted', message: 'webhook deleted' });
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const deleteButton = await screen.findByRole('button', { name: 'Delete webhook' });
    expect(deleteButton).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/I reviewed this delete/i));
    expect(deleteButton).toHaveProperty('disabled', false);
    fireEvent.click(deleteButton);
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('wh-1', true));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('recovers from a failed (definite, non-transport) delete: the drawer stays open with the server message', async () => {
    mockList.mockResolvedValue(envelope());
    mockDelete.mockResolvedValue({ ok: false, action: 'failed', message: 'webhook not found (HTTP 404)' });
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByLabelText(/I reviewed this delete/i));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete webhook' }));
    await waitFor(() => expect(screen.getByText('webhook not found (HTTP 404)')).toBeTruthy());
  });

  it('never renders anything resembling a secret value anywhere in the panel', async () => {
    mockList.mockResolvedValue(envelope());
    mockGet.mockResolvedValue(detail());
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('API key');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'super-secret-abcdef0123456789' } });
    // Nothing resembling the secret value is ever rendered outside the
    // (masked) input's own value.
    const nodesWithSecret = Array.from(document.querySelectorAll('body *')).filter((el) =>
      el.textContent?.includes('super-secret-abcdef0123456789'),
    );
    expect(nodesWithSecret.length).toBe(0);
  });
});

describe('detail request race safety — stale responses can never cross-populate a drawer', () => {
  const rowB = row({ id: 'wh-2', name: 'noc-pager', endpoint: 'https://noc.example/hook', generation: 1 });
  const detailA = detail({ generation: 1, endpoint: 'https://example.service-now.com/hooks' });
  const detailB = detail({
    id: 'wh-2',
    name: 'noc-pager',
    endpoint: 'https://noc.example/hook',
    generation: 1,
    authMechanism: 'API_KEY',
  });

  it('closing A then opening B: A\u2019s late detail response never lands in B\u2019s drawer', async () => {
    mockList.mockResolvedValue(envelope({ items: [row(), rowB], totalCount: 2 }));
    const dA = deferred<WebhookDetail>();
    mockGet.mockImplementationOnce(() => dA.promise);
    mockGet.mockResolvedValueOnce(detailB);
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());

    const editButtons = () => screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(editButtons()[0]); // open A — its getCentralWebhook is stuck pending
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('wh-1'));

    fireEvent.click(screen.getByLabelText('Close dialog')); // close A before it ever resolved
    fireEvent.click(editButtons()[1]); // open B — resolves normally
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('wh-2'));
    await screen.findByDisplayValue('https://noc.example/hook');

    // Now the stale A response finally arrives — it must not touch B's
    // now-open drawer at all.
    await act(async () => {
      dA.resolve(detailA);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByLabelText('Target URL') as HTMLInputElement).value).toBe('https://noc.example/hook');
    expect(screen.getByText('Edit noc-pager')).toBeTruthy();
    expect(screen.queryByDisplayValue('https://example.service-now.com/hooks')).toBeNull();
  });

  it('rapid A\u2192B\u2192A: only the final A request may populate the drawer; the two superseded ones never do', async () => {
    mockList.mockResolvedValue(envelope({ items: [row(), rowB], totalCount: 2 }));
    const dA1 = deferred<WebhookDetail>();
    const dB = deferred<WebhookDetail>();
    const dA2 = deferred<WebhookDetail>();
    mockGet.mockImplementationOnce(() => dA1.promise);
    mockGet.mockImplementationOnce(() => dB.promise);
    mockGet.mockImplementationOnce(() => dA2.promise);
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());

    const editButtons = () => screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(editButtons()[0]); // A, request #1 — pending
    await waitFor(() => expect(mockGet).toHaveBeenNthCalledWith(1, 'wh-1'));
    fireEvent.click(screen.getByLabelText('Close dialog'));

    fireEvent.click(editButtons()[1]); // B — pending
    await waitFor(() => expect(mockGet).toHaveBeenNthCalledWith(2, 'wh-2'));
    fireEvent.click(screen.getByLabelText('Close dialog'));

    fireEvent.click(editButtons()[0]); // A again, request #2 — pending
    await waitFor(() => expect(mockGet).toHaveBeenNthCalledWith(3, 'wh-1'));

    // The two superseded requests settle late, with distinguishable poison
    // values. Neither may populate anything — the drawer must still be
    // showing its loading state for A's second (live) request.
    await act(async () => {
      dA1.resolve(detail({ generation: 1, endpoint: 'https://poison-a1.invalid/hook' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      dB.resolve(detail({ id: 'wh-2', name: 'noc-pager', generation: 1, endpoint: 'https://poison-b.invalid/hook' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByLabelText('Target URL')).toBeNull(); // still loading — A#2 hasn't resolved
    expect(screen.queryByDisplayValue('https://poison-a1.invalid/hook')).toBeNull();
    expect(screen.queryByDisplayValue('https://poison-b.invalid/hook')).toBeNull();

    // Now the live A request resolves — this, and only this, may populate.
    await act(async () => {
      dA2.resolve(detail({ generation: 7, endpoint: 'https://real-final.example/hook' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await screen.findByDisplayValue('https://real-final.example/hook');
    expect(screen.getByText(/generation 7/)).toBeTruthy();
  });

  it('stale A cannot populate/mutate B even when both webhooks report the exact same business "generation"', async () => {
    // A and B share `generation: 1` — a real-world business-data collision.
    // Only our internal id+seq request token (not the webhook's own
    // generation field) may be used to detect the stale response.
    mockList.mockResolvedValue(envelope({ items: [row(), rowB], totalCount: 2 }));
    const dA = deferred<WebhookDetail>();
    mockGet.mockImplementationOnce(() => dA.promise);
    mockGet.mockResolvedValueOnce(detailB);
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());

    const editButtons = () => screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(editButtons()[0]);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('wh-1'));
    fireEvent.click(screen.getByLabelText('Close dialog'));
    fireEvent.click(editButtons()[1]);
    await screen.findByDisplayValue('https://noc.example/hook');
    expect(screen.getByText(/generation 1/)).toBeTruthy(); // B's own generation, honestly

    await act(async () => {
      dA.resolve(detailA); // also generation 1, but it's webhook A's data
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByLabelText('Target URL') as HTMLInputElement).value).toBe('https://noc.example/hook');
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'noc-pager');
  });

  it('closing the drawer (and unmounting) drops an in-flight detail response instead of crashing or leaking state', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockList.mockResolvedValue(envelope());
    const dA = deferred<WebhookDetail>();
    mockGet.mockImplementationOnce(() => dA.promise);
    const { unmount } = renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('wh-1'));

    unmount();
    await act(async () => {
      dA.resolve(detailA);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a generation-conflict refetch is identity-safe: closing that drawer and opening a different one is never overwritten by the late, stale reconcile response', async () => {
    mockList.mockResolvedValue(envelope({ items: [row(), rowB], totalCount: 2 }));
    mockGet.mockResolvedValueOnce(detailA);
    renderPanel();
    await waitFor(() => expect(screen.getByText('servicenow-incidents')).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await screen.findByLabelText('API key');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'renewed-key' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact update/i));
    const saveButton = await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save changes' });
      expect(btn).toHaveProperty('disabled', false);
      return btn;
    });

    mockUpdate.mockResolvedValueOnce({ ok: false, action: 'failed', httpCode: 409, message: 'generation conflict' });
    const dReconcile = deferred<WebhookDetail>();
    mockGet.mockImplementationOnce(() => dReconcile.promise); // the conflict-triggered refetch — held pending
    fireEvent.click(saveButton);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));

    // Close A's drawer while its conflict-refetch is still in flight, then
    // open B, which loads normally.
    fireEvent.click(screen.getByLabelText('Close dialog'));
    mockGet.mockResolvedValueOnce(detailB);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
    await screen.findByDisplayValue('https://noc.example/hook');

    // The stale conflict-refetch for A now resolves — it must not overwrite
    // B's drawer.
    await act(async () => {
      dReconcile.resolve(detail({ generation: 99, endpoint: 'https://stale-reconcile.invalid/hook' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByLabelText('Target URL') as HTMLInputElement).value).toBe('https://noc.example/hook');
    expect(screen.getByText('Edit noc-pager')).toBeTruthy();
    expect(screen.queryByDisplayValue('https://stale-reconcile.invalid/hook')).toBeNull();
  });
});

/* Loop 190 — webhooks list multi-select bulk bar. */
describe('Central webhooks bulk (Loop 190)', () => {
  it('shows bulk bar for selection: Export selected, Copy names, Copy selection link, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:webhooks-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockList.mockResolvedValue(
      envelope({
        items: [row(), row({ id: 'wh-2', name: 'noc-pager', endpoint: 'https://noc.example/hook' })],
        totalCount: 2,
        count: 2,
      }),
    );
    renderPanel();
    expect(await screen.findByRole('grid', { name: 'Central webhooks' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Webhook selection actions' })).toBeNull();

    const table = screen.getByRole('grid', { name: 'Central webhooks' });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Webhook selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected webhook/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/servicenow-incidents|noc-pager/);

    writeText.mockClear();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const link = String(writeText.mock.calls[0]![0]);
    expect(link).toMatch(/\/systems\?/);
    expect(link).toMatch(/plane=central/);
    expect(link).toMatch(/tab=config/);
    expect(link).toMatch(/webhookIds=/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Webhook selection actions' })).toBeNull(),
    );
  });

  it('deep-links ?webhookIds= and shows a clearable selection chip', async () => {
    mockList.mockResolvedValue(
      envelope({
        items: [row(), row({ id: 'wh-2', name: 'noc-pager', endpoint: 'https://noc.example/hook' })],
        totalCount: 2,
        count: 2,
      }),
    );
    renderPanel('/systems?plane=central&tab=config&webhookIds=wh-1');
    const chip = await screen.findByRole('button', { name: /1 selected webhook/i });
    expect(chip.textContent ?? '').toMatch(/^1 selected webhook/);
    const table = screen.getByRole('grid', { name: 'Central webhooks' });
    expect(within(table).getByText('servicenow-incidents')).toBeTruthy();
    expect(within(table).queryByText('noc-pager')).toBeNull();
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByText('noc-pager')).toBeTruthy());
  });
});

/* Loop 201 — keyboard shortcuts help + search empty CTA on Central webhooks list. */
describe('Central webhooks Loop 201 residuals', () => {
  it('exposes keyboard shortcuts help on the webhooks toolbar', async () => {
    mockList.mockResolvedValue(envelope());
    renderPanel();
    expect(await screen.findByRole('grid', { name: 'Central webhooks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  it('offers Clear search when the list is search-empty', async () => {
    mockList.mockResolvedValue(envelope({ items: [], totalCount: 0, count: 0, note: 'none' }));
    renderPanel();
    const input = await screen.findByLabelText('Search webhooks');
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('No webhooks match the search.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
  });
});
