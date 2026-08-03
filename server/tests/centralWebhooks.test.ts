/**
 * Central webhook server security/release tests. All Central and DNS I/O is
 * injected; no test reaches a tenant or the network.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebhookForm } from '@hpe/shared';
import type {
  CentralWebhooksError as CentralWebhooksErrorType,
  CentralWebhooksTransport,
  PersistedWebhookHandoff,
  WebhookHandoffJournalStore,
  WebhookHostnameResolver,
} from '../src/services/centralWebhooks';

let CentralWebhooksService: typeof import('../src/services/centralWebhooks').CentralWebhooksService;
let CentralWebhooksError: typeof CentralWebhooksErrorType;
let makeCentralWebhooksRouter: typeof import('../src/routes/centralWebhooks').makeCentralWebhooksRouter;
let settings: typeof import('../src/config/settings').settings;

let tmpDir: string;
let dirCounter = 0;
function freshDataDir(): string {
  return join(tmpDir, `d${dirCounter++}`);
}

beforeAll(async () => {
  const testRoot = resolve(process.cwd(), '.agent-tmp');
  mkdirSync(testRoot, { recursive: true });
  tmpDir = mkdtempSync(join(testRoot, 'hpe-central-webhooks-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ CentralWebhooksService, CentralWebhooksError } = await import('../src/services/centralWebhooks'));
  ({ makeCentralWebhooksRouter } = await import('../src/routes/centralWebhooks'));
  ({ settings } = await import('../src/config/settings'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

type Res = { status: number; body: unknown };

function okTransport(overrides: Partial<CentralWebhooksTransport> = {}): CentralWebhooksTransport {
  return {
    request: async () => ({ status: 200, body: {} }),
    capabilities: () => ({ directWrite: true }),
    ...overrides,
  };
}

function webhookRow(id = 'wh-1', overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'network-services',
    name: 'noc-hook',
    endpoint: 'https://hooks.example.com/central',
    authMechanism: 'API_KEY',
    generation: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
    apiKey: 'central-echoed-api-key',
    ...overrides,
  };
}

const CREATE_FORM: WebhookForm = {
  name: 'noc-hook',
  endpoint: 'https://hooks.example.com/central',
  authMechanism: 'API_KEY',
  apiKey: 'submitted-api-secret',
};

const publicDns: WebhookHostnameResolver = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void } {
  let resolve = (): void => undefined;
  let reject = (_reason: unknown): void => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferredValue<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve = (_value: T): void => undefined;
  let reject = (_reason: unknown): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function memoryJournalStore(
  hooks: {
    onLoad?: () => void;
    onSave?: (journal: PersistedWebhookHandoff, saveCount: number) => void;
    onDelete?: () => void;
  } = {},
): WebhookHandoffJournalStore {
  let current: PersistedWebhookHandoff | null = null;
  let saveCount = 0;
  return {
    load: () => {
      hooks.onLoad?.();
      return current;
    },
    save: (journal) => {
      saveCount += 1;
      hooks.onSave?.(journal, saveCount);
      current = structuredClone(journal);
    },
    delete: () => {
      hooks.onDelete?.();
      current = null;
    },
  };
}

describe('safe reads and redaction', () => {
  it('rejects rows read from an old tenant when credentials change during the list request', async () => {
    const response = deferredValue<Res>();
    let fingerprint = 'a'.repeat(64);
    let posts = 0;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      tenantFingerprint: () => fingerprint,
      plane: okTransport({
        request: async (method) => {
          if (method === 'POST') {
            posts += 1;
            return { status: 200, body: { items: { success: true, hmacKey: 'wrong-tenant' } } };
          }
          return response.promise;
        },
      }),
    });

    const listing = service.list(10, 0, '');
    fingerprint = 'b'.repeat(64);
    response.resolve({ status: 200, body: { items: [webhookRow('tenant-a-row')] } });

    await expect(listing).resolves.toMatchObject({
      items: [],
      source: 'unavailable',
      tenantBinding: null,
      error: expect.stringContaining('credentials changed while listing'),
    });
    expect(posts).toBe(0);
  });

  it('reports list permission errors without exposing provider messages', async () => {
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async () => ({
          status: 403,
          body: { errorCode: 'HPE_GL_ERROR_FORBIDDEN', message: 'submitted-api-secret' },
        }),
      }),
    });
    const result = await service.list(undefined, undefined, undefined);
    expect(result.items).toEqual([]);
    expect(result.error).toContain('HPE_GL_ERROR_FORBIDDEN');
    expect(JSON.stringify(result)).not.toContain('submitted-api-secret');
  });

  it.each([
    ['empty', 'empty response body'],
    ['whitespace', 'whitespace-only response body'],
    ['json-null', 'JSON null response'],
  ] as const)('treats only an HTTP 200 %s list response as an honest empty collection', async (bodyParse, note) => {
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async () => ({ status: 200, body: null, bodyParse }),
      }),
    });

    const result = await service.list(undefined, undefined, undefined);

    expect(result).toMatchObject({
      items: [],
      totalCount: 0,
      count: 0,
      hasMore: false,
      source: 'central live',
    });
    expect(result.error).toBeUndefined();
    expect(result.note).toContain(note);
  });

  it.each([
    ['malformed-json', 'malformed JSON'],
    ['non-json', 'non-JSON response'],
  ] as const)('keeps an HTTP 200 %s list response as an error, never empty success', async (bodyParse, message) => {
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async () => ({ status: 200, body: null, bodyParse }),
      }),
    });

    const result = await service.list(undefined, undefined, undefined);

    expect(result.items).toEqual([]);
    expect(result.source).toBe('unavailable');
    expect(result.note).toBeUndefined();
    expect(result.error).toContain(message);
  });

  it('requires HTTP 200 for the empty/null list relaxation', async () => {
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async () => ({ status: 204, body: null, bodyParse: 'empty' }),
      }),
    });

    const result = await service.list(undefined, undefined, undefined);

    expect(result.source).toBe('unavailable');
    expect(result.error).toContain('not recognized');
  });

  it('recognizes an empty envelope and preserves local filtering and pagination for rows', async () => {
    let body: unknown = { items: [] };
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async () => ({ status: 200, body, bodyParse: 'json' }),
      }),
    });

    const empty = await service.list(undefined, undefined, undefined);
    expect(empty).toMatchObject({
      items: [],
      totalCount: 0,
      count: 0,
      source: 'central live',
    });
    expect(empty.note).toContain('recognized empty envelope');

    body = {
      items: [
        webhookRow('wh-1', { name: 'noc-primary' }),
        webhookRow('wh-2', { name: 'other' }),
        webhookRow('wh-3', { name: 'noc-secondary' }),
      ],
    };
    const rows = await service.list(1, 1, ' NOC ');
    expect(rows.items.map((item) => item.id)).toEqual(['wh-3']);
    expect(rows).toMatchObject({
      totalCount: 2,
      count: 1,
      limit: 1,
      offset: 1,
      hasMore: false,
      source: 'central live',
    });
    expect(rows.note).toBeUndefined();
  });

  it('does not relax JSON null for detail, ordinary mutation, or HMAC responses', async () => {
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async () => ({ status: 200, body: null, bodyParse: 'json-null' }),
      }),
    });

    await expect(service.get('wh-1')).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('could not be parsed'),
    });
    const rotation = await service.rotateHmacKey('wh-1', true, true);
    expect(rotation).toMatchObject({
      ok: false,
      action: 'unknown',
      code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
    });

    const patchService = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method) =>
          method === 'GET'
            ? { status: 200, body: webhookRow() }
            : { status: 200, body: null, bodyParse: 'json-null' },
      }),
    });
    const patch = await patchService.patch('wh-1', { expectedGeneration: 1, name: 'renamed' }, true);
    expect(patch).toMatchObject({
      ok: false,
      action: 'failed',
      message: expect.stringContaining('items.success === true'),
    });
  });

  it('redacts API_KEY and OIDC credentials from GET details', async () => {
    const api = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({ request: async () => ({ status: 200, body: webhookRow() }) }),
    });
    const apiDetail = await api.get('wh-1');
    expect(apiDetail.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(apiDetail)).not.toContain('central-echoed-api-key');

    const oidc = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async () => ({
          status: 200,
          body: webhookRow('wh-2', {
            authMechanism: 'OIDC',
            oidcDetails: {
              clientId: 'visible-client',
              clientSecret: 'central-echoed-oidc-secret',
              wellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
            },
          }),
        }),
      }),
    });
    const oidcDetail = await oidc.get('wh-2');
    expect(oidcDetail.oidcClientId).toBe('visible-client');
    expect(oidcDetail.oidcClientSecretConfigured).toBe(true);
    expect(JSON.stringify(oidcDetail)).not.toContain('central-echoed-oidc-secret');
  });

  it('never exposes an hmacKey from list or detail GET responses', async () => {
    const hmacKey = 'get-must-never-return-this-hmac';
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (_method, path) =>
          path === '/network-services/v1/webhooks'
            ? { status: 200, body: { items: [webhookRow('wh-1', { hmacKey })] } }
            : { status: 200, body: webhookRow('wh-1', { hmacKey }) },
      }),
    });

    expect(JSON.stringify(await service.list(undefined, undefined, undefined))).not.toContain(hmacKey);
    expect(JSON.stringify(await service.get('wh-1'))).not.toContain(hmacKey);
  });
});

describe('reviewed one-time HMAC-issuing operations', () => {
  it('requires review in hardened mode and the separate one-time-secret acknowledgement before any Central call', async () => {
    settings.update({ configMode: false });
    let called = false;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: publicDns,
      plane: okTransport({ request: async () => ((called = true), { status: 200, body: {} }) }),
    });

    try {
      await expect(service.create(CREATE_FORM, false, true)).rejects.toMatchObject({ status: 400 });
      await expect(service.create(CREATE_FORM, true, false)).rejects.toMatchObject({ status: 400 });
      await expect(service.rotateHmacKey('wh-1', false, true)).rejects.toMatchObject({ status: 400 });
      await expect(service.rotateHmacKey('wh-1', true, false)).rejects.toMatchObject({ status: 400 });
      expect(called).toBe(false);
    } finally {
      settings.update({ configMode: true });
    }
  });

  it('preserves HTTPS and public-DNS callback validation on create before Central', async () => {
    let called = false;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }],
      plane: okTransport({ request: async () => ((called = true), { status: 200, body: {} }) }),
    });

    await expect(
      service.create({ ...CREATE_FORM, endpoint: 'http://hooks.example.com/central' }, true, true),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.create(CREATE_FORM, true, true)).rejects.toMatchObject({ status: 400 });
    expect(called).toBe(false);
  });

  it('uses the official POST paths/auth variants in demo-sourced and live operation, returning hmacKey only on success', async () => {
    const hmacCreate = 'create-one-time-hmac';
    const hmacRotate = 'rotate-one-time-hmac';
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const dataDir = freshDataDir();
    const service = new CentralWebhooksService({
      dataDir,
      effectiveDemoMode: () => true,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async (method, path, body) => {
          calls.push({ method, path, body });
          return path.endsWith('/rotate-hmac-key')
            ? { status: 200, body: { items: { id: 'wh-1', hmacKey: hmacRotate, success: true, message: 'rotated' } } }
            : { status: 200, body: { items: { id: 'wh-new', hmacKey: hmacCreate, success: true, message: 'created' } } };
        },
      }),
    });

    const created = await service.create(CREATE_FORM, true, true);
    if (!('operationId' in created)) throw new Error('expected create operation id');
    await service.acknowledgeHandoff(created.operationId, true);
    const rotated = await service.rotateHmacKey('wh-1', true, true);

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/network-services/v1/webhooks',
        body: {
          input: {
            name: 'noc-hook',
            endpoint: 'https://hooks.example.com/central',
            authMechanism: 'API_KEY',
            apiKey: 'submitted-api-secret',
          },
        },
      },
      {
        method: 'POST',
        path: '/network-services/v1/webhooks/wh-1/rotate-hmac-key',
        body: undefined,
      },
    ]);
    expect(created).toMatchObject({ ok: true, action: 'created', hmacKey: hmacCreate });
    expect(rotated).toMatchObject({ ok: true, action: 'rotated', hmacKey: hmacRotate });
    const audit = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8');
    expect(audit).not.toContain('submitted-api-secret');
    expect(audit).not.toContain(hmacCreate);
    expect(audit).not.toContain(hmacRotate);
    expect(audit.match(/"result":"created"/g)).toHaveLength(1);
    expect(audit.match(/"result":"rotated"/g)).toHaveLength(1);
  });

  it('sends the exact documented OIDC create variant without an API key', async () => {
    let body: unknown;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: publicDns,
      plane: okTransport({
        request: async (_method, _path, requestBody) => {
          body = requestBody;
          return { status: 200, body: { items: { hmacKey: 'oidc-hmac', success: true } } };
        },
      }),
    });
    await service.create(
      {
        name: 'oidc-hook',
        endpoint: 'https://hooks.example.com/oidc',
        authMechanism: 'OIDC',
        oidcClientId: 'client-id',
        oidcClientSecret: 'client-secret',
        oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
      },
      true,
      true,
    );
    expect(body).toEqual({
      input: {
        name: 'oidc-hook',
        endpoint: 'https://hooks.example.com/oidc',
        authMechanism: 'OIDC',
        oidcDetails: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          wellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
        },
      },
    });
  });

  it.each([
    { hmacKey: 'provider-hmac-must-not-escape' },
    { items: { hmac_key: 'provider-hmac-must-not-escape' } },
    { items: { hmacKey: '' } },
    { items: { hmacKey: '   ' } },
    { items: { hmacKey: 42 } },
    { items: [] },
    { items: null },
  ])('classifies malformed HTTP 200 one-time envelopes as unknown without exposing possible secret data: %#', async (body) => {
    const providerHmac = 'provider-hmac-must-not-escape';
    const createDir = freshDataDir();
    const malformedCreate = new CentralWebhooksService({
      dataDir: createDir,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => ({ status: 200, body }),
      }),
    });
    const rotateDir = freshDataDir();
    const malformedRotate = new CentralWebhooksService({
      dataDir: rotateDir,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => ({ status: 200, body }),
      }),
    });
    const createUnknown = await malformedCreate.create(CREATE_FORM, true, true);
    const rotateUnknown = await malformedRotate.rotateHmacKey('wh-1', true, true);
    expect(createUnknown).toMatchObject({
      ok: false,
      action: 'unknown',
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
      httpCode: 200,
    });
    expect(rotateUnknown).toMatchObject({
      ok: false,
      action: 'unknown',
      outcome: 'unknown',
      code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
      httpCode: 200,
    });
    expect(createUnknown.message).toContain('canonical create candidate');
    expect(rotateUnknown.message).toContain('receiver and Central');
    expect(JSON.stringify([createUnknown, rotateUnknown])).not.toContain(providerHmac);
    const audit =
      readFileSync(join(createDir, 'change-log.jsonl'), 'utf8') +
      readFileSync(join(rotateDir, 'change-log.jsonl'), 'utf8');
    expect(audit).not.toContain(providerHmac);
    expect(audit.match(/"result":"unknown"/g)).toHaveLength(2);
  });

  it('treats an unreadable HTTP 200 body as unknown without reading or logging its contents', async () => {
    const possibleSecret = 'unreadable-provider-secret';
    const unreadableBody = Object.defineProperty({}, 'items', {
      get() {
        throw new Error(possibleSecret);
      },
    });
    const dataDir = freshDataDir();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new CentralWebhooksService({
      dataDir,
      resolveHostname: publicDns,
      plane: okTransport({ request: async () => ({ status: 200, body: unreadableBody }) }),
    });

    const result = await service.create(CREATE_FORM, true, true);

    expect(result).toMatchObject({
      action: 'unknown',
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
    });
    expect(JSON.stringify(result)).not.toContain(possibleSecret);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(possibleSecret);
    expect(readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')).not.toContain(possibleSecret);
    consoleSpy.mockRestore();
  });

  it('requires exact items.success true alongside the documented items.hmacKey', async () => {
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: publicDns,
      plane: okTransport({
        request: async (_method, path) => ({
          status: 200,
          body: {
            items: {
              success: true,
              hmacKey: path.endsWith('/rotate-hmac-key') ? 'exact-rotate-hmac' : 'exact-create-hmac',
            },
          },
        }),
      }),
    });

    const created = await service.create(CREATE_FORM, true, true);
    expect(created).toMatchObject({
      action: 'created',
      hmacKey: 'exact-create-hmac',
    });
    if (!('operationId' in created)) throw new Error('expected create operation id');
    await service.acknowledgeHandoff(created.operationId, true);
    await expect(service.rotateHmacKey('wh-1', true, true)).resolves.toMatchObject({
      action: 'rotated',
      hmacKey: 'exact-rotate-hmac',
    });
  });

  it('records transport-unknown outcomes without secret data', async () => {
    const providerHmac = 'provider-hmac-must-not-escape';
    const createDir = freshDataDir();
    const unknownCreate = new CentralWebhooksService({
      dataDir: createDir,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => {
          throw new Error(`socket failed after ${providerHmac}`);
        },
      }),
    });
    const rotateDir = freshDataDir();
    const unknownRotate = new CentralWebhooksService({
      dataDir: rotateDir,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => {
          throw new Error(`socket failed after ${providerHmac}`);
        },
      }),
    });
    await expect(unknownCreate.create(CREATE_FORM, true, true)).resolves.toMatchObject({
      action: 'unknown',
      httpCode: 502,
    });
    await expect(unknownRotate.rotateHmacKey('wh-1', true, true)).resolves.toMatchObject({
      action: 'unknown',
      httpCode: 502,
    });
    const audit =
      readFileSync(join(createDir, 'change-log.jsonl'), 'utf8') +
      readFileSync(join(rotateDir, 'change-log.jsonl'), 'utf8');
    expect(audit.match(/outcome unknown/g)).toHaveLength(2);
    expect(audit).not.toContain(providerHmac);
  });
});

describe('documented success flags and durable handoff journal', () => {
  it.each([
    ['create', { items: { success: false, message: 'provider rejected' } }, 'failed'],
    ['create', { items: { message: 'missing success' } }, 'unknown'],
    ['create', { items: { success: true, hmacKey: 'create-once' } }, 'created'],
    ['rotate', { items: { success: false, message: 'provider rejected' } }, 'failed'],
    ['rotate', { items: { message: 'missing success' } }, 'unknown'],
    ['rotate', { items: { success: true, hmacKey: 'rotate-once' } }, 'rotated'],
  ] as const)(
    'requires items.success === true for %s: %#',
    async (operation, body, expectedAction) => {
      let calls = 0;
      const service = new CentralWebhooksService({
        dataDir: freshDataDir(),
        resolveHostname: publicDns,
        plane: okTransport({
          request: async () => {
            calls += 1;
            return { status: 200, body };
          },
        }),
      });

      const result =
        operation === 'create'
          ? await service.create(CREATE_FORM, true, true)
          : await service.rotateHmacKey('wh-1', true, true);

      expect(result.action).toBe(expectedAction);
      expect(calls).toBe(1);
      const status = await service.getPendingHandoff();
      expect(status.pending).toBe(expectedAction !== 'failed');
      if (expectedAction === 'failed') {
        expect(result.message).toContain('provider rejected');
      } else if (expectedAction === 'unknown') {
        expect(result).toMatchObject({ outcome: 'unknown' });
      } else {
        expect(result).toMatchObject({
          ok: true,
          operationId: expect.any(String),
        });
      }
    },
  );

  it.each([
    [{ items: { success: false, message: 'PATCH rejected' } }, 'failed'],
    [{ items: { message: 'missing success' } }, 'failed'],
    [{ items: { success: true } }, 'patched'],
  ] as const)('requires items.success === true for PATCH: %#', async (body, expectedAction) => {
    let patchCalls = 0;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method) => {
          if (method === 'GET') return { status: 200, body: webhookRow() };
          patchCalls += 1;
          return { status: 200, body };
        },
      }),
    });

    const result = await service.patch(
      'wh-1',
      { expectedGeneration: 1, name: 'renamed' },
      true,
    );

    expect(result.action).toBe(expectedAction);
    expect(patchCalls).toBe(1);
    expect(await service.getPendingHandoff()).toEqual({ pending: false });
  });

  it('sanitizes definite provider failure message/code without leaking credential or key fields', async () => {
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => ({
          status: 200,
          body: {
            items: {
              success: false,
              errorCode: 'WEBHOOK_REJECTED',
              hmacKey: 'provider-key',
              message: 'submitted-api-secret provider-key',
            },
          },
        }),
      }),
    });

    const result = await service.create(CREATE_FORM, true, true);
    expect(result).toMatchObject({ action: 'failed' });
    expect(result.message).toContain('WEBHOOK_REJECTED');
    expect(result.message).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toMatch(/submitted-api-secret|provider-key/);
    expect(await service.getPendingHandoff()).toEqual({ pending: false });
  });

  it('uses one canonical whitespace-trimmed create identity for wire and journal', async () => {
    let wireBody: unknown;
    const dataDir = freshDataDir();
    const service = new CentralWebhooksService({
      dataDir,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async (_method, _path, body) => {
          wireBody = body;
          return {
            status: 200,
            body: { items: { success: true, hmacKey: 'canonical-once' } },
          };
        },
      }),
    });

    const result = await service.create(
      {
        name: '  canonical hook  ',
        endpoint: '  https://hooks.example.com/canonical  ',
        authMechanism: 'OIDC',
        oidcClientId: '  client-id  ',
        oidcClientSecret: ' secret bytes stay exact ',
        oidcWellKnownUrl: '  https://issuer.example/.well-known/openid-configuration  ',
      },
      true,
      true,
    );
    const status = await service.getPendingHandoff();

    expect(wireBody).toEqual({
      input: {
        name: 'canonical hook',
        endpoint: 'https://hooks.example.com/canonical',
        authMechanism: 'OIDC',
        oidcDetails: {
          clientId: 'client-id',
          clientSecret: ' secret bytes stay exact ',
          wellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
        },
      },
    });
    expect(status.operation?.candidate).toEqual({
      name: 'canonical hook',
      endpoint: 'https://hooks.example.com/canonical',
      authMechanism: 'OIDC',
      oidcClientId: 'client-id',
      oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
    });
    const journal = readFileSync(join(dataDir, 'central-webhook-handoff.json'), 'utf8');
    expect(journal).toContain('"canonical hook"');
    expect(journal).not.toContain('secret bytes stay exact');
    expect(journal).not.toContain('canonical-once');
    expect(result).toMatchObject({ operationId: status.operation?.operationId });
  });

  it('persists atomic 0600 preflight, survives restart, and clears only after secretStored true', async () => {
    const hmacKey = 'restart-one-time-secret';
    const dataDir = freshDataDir();
    const opts = {
      dataDir,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => ({
          status: 200,
          body: { items: { success: true, hmacKey } },
        }),
      }),
    };
    const first = new CentralWebhooksService(opts);
    const result = await first.create(CREATE_FORM, true, true);
    if (typeof result.operationId !== 'string') throw new Error('expected operation id');
    const journalPath = join(dataDir, 'central-webhook-handoff.json');

    expect(existsSync(journalPath)).toBe(true);
    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(journalPath, 'utf8')).not.toContain(hmacKey);

    const restarted = new CentralWebhooksService(opts);
    expect(await restarted.getPendingHandoff()).toMatchObject({
      pending: true,
      operation: {
        operationId: result.operationId,
        state: 'secret-issued-awaiting-handoff',
      },
    });
    await expect(restarted.acknowledgeHandoff(result.operationId, false)).rejects.toMatchObject({
      status: 400,
    });
    expect(existsSync(journalPath)).toBe(true);
    await restarted.acknowledgeHandoff(result.operationId, true);
    expect(existsSync(journalPath)).toBe(false);
    expect(await restarted.getPendingHandoff()).toEqual({ pending: false });
  });

  it('does not call Central when durable preflight save fails and redacts storage paths', async () => {
    let calls = 0;
    const store = memoryJournalStore({
      onSave: () => {
        throw new Error('/sensitive/path/central-webhook-handoff.json');
      },
    });
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: publicDns,
      handoffJournalStore: store,
      plane: okTransport({
        request: async () => {
          calls += 1;
          return { status: 200, body: { items: { success: true, hmacKey: 'never' } } };
        },
      }),
    });

    await expect(service.create(CREATE_FORM, true, true)).rejects.toMatchObject({
      status: 503,
      message: expect.not.stringContaining('/sensitive/path'),
    });
    expect(calls).toBe(0);
  });

  it('withholds the key and keeps the preflight block when the issued transition save fails', async () => {
    const hmacKey = 'must-not-return-after-transition-failure';
    const store = memoryJournalStore({
      onSave: (_journal, saveCount) => {
        if (saveCount === 2) throw new Error('/sensitive/transition/path');
      },
    });
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: publicDns,
      handoffJournalStore: store,
      plane: okTransport({
        request: async () => ({
          status: 200,
          body: { items: { success: true, hmacKey } },
        }),
      }),
    });

    const result = await service.create(CREATE_FORM, true, true);
    expect(result).toMatchObject({ action: 'unknown', outcome: 'unknown', httpCode: 503 });
    expect(JSON.stringify(result)).not.toContain(hmacKey);
    expect(await service.getPendingHandoff()).toMatchObject({
      pending: true,
      operation: { state: 'in-flight' },
    });
  });

  it('fails closed when clearing a definite provider failure journal fails', async () => {
    let calls = 0;
    const store = memoryJournalStore({
      onDelete: () => {
        throw new Error('/sensitive/delete/path');
      },
    });
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: publicDns,
      handoffJournalStore: store,
      plane: okTransport({
        request: async () => {
          calls += 1;
          return {
            status: 200,
            body: { items: { success: false, message: 'definite rejection' } },
          };
        },
      }),
    });

    await expect(service.create(CREATE_FORM, true, true)).rejects.toMatchObject({
      status: 503,
      message: expect.not.stringContaining('/sensitive/delete'),
    });
    expect(calls).toBe(1);
    expect(await service.getPendingHandoff()).toMatchObject({ pending: true });
    expect(() => service.assertCentralCredentialsMutable()).toThrow();
  });

  it('serializes create/rotate and makes an overlapping request perform zero provider calls', async () => {
    const provider = deferredValue<{ status: number; body: unknown }>();
    let calls = 0;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => {
          calls += 1;
          return provider.promise;
        },
      }),
    });

    const creating = service.create(CREATE_FORM, true, true);
    const rotating = service.rotateHmacKey('wh-1', true, true);
    await vi.waitFor(() => expect(calls).toBe(1));
    provider.resolve({
      status: 200,
      body: { items: { success: true, hmacKey: 'serialized-once' } },
    });

    await expect(creating).resolves.toMatchObject({ action: 'created' });
    await expect(rotating).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(1);
  });

  it('rejects fingerprint mismatch and blocks Central credential changes while pending', async () => {
    const dataDir = freshDataDir();
    const fingerprintA = 'a'.repeat(64);
    const first = new CentralWebhooksService({
      dataDir,
      tenantFingerprint: () => fingerprintA,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => ({
          status: 200,
          body: { items: { message: 'missing success' } },
        }),
      }),
    });
    const unknown = await first.create(CREATE_FORM, true, true);
    if (typeof unknown.operationId !== 'string') throw new Error('expected operation id');
    expect(() => first.assertCentralCredentialsMutable()).toThrowError(
      expect.objectContaining({ status: 409 }),
    );

    const mismatched = new CentralWebhooksService({
      dataDir,
      tenantFingerprint: () => 'b'.repeat(64),
      plane: okTransport(),
    });
    expect(await mismatched.getPendingHandoff()).toMatchObject({
      operation: { fingerprintMatches: false },
    });
    await expect(
      mismatched.resolveHandoff(
        unknown.operationId,
        'create-absent',
        true,
        { candidateAbsent: true, eventualConsistencyRiskAccepted: true },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('reserves the credential guard before DNS validation and rejects a tenant change before POST', async () => {
    const dns = deferredValue<readonly { address: string; family: number }[]>();
    let fingerprint = 'a'.repeat(64);
    let providerCalls = 0;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      tenantFingerprint: () => fingerprint,
      resolveHostname: async () => dns.promise,
      plane: okTransport({
        request: async (method) => {
          if (method === 'GET') return { status: 200, body: { items: [] } };
          providerCalls += 1;
          return { status: 200, body: { items: { success: true, hmacKey: 'must-not-issue' } } };
        },
      }),
    });
    const reviewedTenantBinding = (await service.list(10, 0, '')).tenantBinding;
    const creating = service.create(CREATE_FORM, true, true, reviewedTenantBinding);

    await vi.waitFor(() => {
      expect(() => service.assertCentralCredentialsMutable()).toThrowError(
        expect.objectContaining({ status: 409 }),
      );
    });
    fingerprint = 'b'.repeat(64);
    dns.resolve([{ address: '93.184.216.34', family: 4 }]);

    await expect(creating).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('tenant changed after this webhook review'),
    });
    expect(providerCalls).toBe(0);
    expect(await service.getPendingHandoff()).toEqual({ pending: false });
    expect(() => service.assertCentralCredentialsMutable()).not.toThrow();
  });

  it('requires reviewed manual reconciliation and never automatically retries', async () => {
    let providerCalls = 0;
    const createService = new CentralWebhooksService({
      dataDir: freshDataDir(),
      resolveHostname: publicDns,
      plane: okTransport({
        request: async (method) => {
          providerCalls += 1;
          if (method === 'GET') return { status: 200, body: webhookRow('located-1') };
          return { status: 200, body: { items: { message: 'missing success' } } };
        },
      }),
    });
    const createUnknown = await createService.create(CREATE_FORM, true, true);
    if (typeof createUnknown.operationId !== 'string') throw new Error('expected operation id');
    settings.update({ configMode: false });
    try {
      await expect(
        createService.resolveHandoff(
          createUnknown.operationId,
          'create-located',
          false,
          { candidateLocated: true },
          'located-1',
        ),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      settings.update({ configMode: true });
    }
    const resolved = await createService.resolveHandoff(
      createUnknown.operationId,
      'create-located',
      true,
      { candidateLocated: true },
      'located-1',
    );
    expect(resolved).toMatchObject({
      resolution: 'create-located',
      webhookId: 'located-1',
    });
    expect(providerCalls).toBe(2);

    const rotateService = new CentralWebhooksService({
      dataDir: freshDataDir(),
      plane: okTransport({
        request: async () => {
          providerCalls += 1;
          return { status: 200, body: { items: { message: 'missing success' } } };
        },
      }),
    });
    const rotateUnknown = await rotateService.rotateHmacKey('wh-1', true, true);
    if (typeof rotateUnknown.operationId !== 'string') throw new Error('expected operation id');
    await expect(
      rotateService.resolveHandoff(
        rotateUnknown.operationId,
        'rotate-reconciled',
        true,
        { receiverReconciled: true },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await rotateService.resolveHandoff(
      rotateUnknown.operationId,
      'rotate-reconciled',
      true,
      { receiverReconciled: true, centralReconciled: true },
    );
    expect(await rotateService.getPendingHandoff()).toEqual({ pending: false });
    expect(providerCalls).toBe(3);
  });
});

describe('reviewed PATCH with generation precondition', () => {
  it('requires review confirmation in hardened mode, expectedGeneration, and at least one reviewed field', async () => {
    settings.update({ configMode: false });
    let called = false;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({ request: async () => ((called = true), { status: 200, body: {} }) }),
    });
    try {
      await expect(service.patch('wh-1', { expectedGeneration: 1, name: 'renamed' }, false)).rejects.toMatchObject({
        status: 400,
      });
      await expect(service.patch('wh-1', { name: 'renamed' }, true)).rejects.toMatchObject({ status: 400 });
      await expect(service.patch('wh-1', { expectedGeneration: 1 }, true)).rejects.toMatchObject({ status: 400 });
      expect(called).toBe(false);
    } finally {
      settings.update({ configMode: true });
    }
  });

  it.each([
    [{ expectedGeneration: 1, authMechanism: 'BASIC', apiKey: 'x' }, /authMechanism/],
    [{ expectedGeneration: 1, name: 'x', apiKey: 'x' }, /apiKey/],
    [{ expectedGeneration: 1, authMechanism: 'API_KEY', apiKey: 'x', oidcClientId: 'x' }, /oidcClientId/],
    [
      {
        expectedGeneration: 1,
        authMechanism: 'OIDC',
        oidcClientId: 'id',
        oidcClientSecret: 'secret',
        oidcWellKnownUrl: 'https://issuer.example',
        apiKey: 'x',
      },
      /apiKey/,
    ],
    [{ expectedGeneration: 1, authMechanism: 'API_KEY' }, /apiKey/],
    [{ expectedGeneration: 1, authMechanism: 'OIDC', oidcClientId: 'id' }, /oidcClientSecret/],
    [{ expectedGeneration: 1, name: 'x', ignoredField: true }, /ignoredField/],
  ])('strictly rejects an invalid auth/field variant %#', async (form, message) => {
    let called = false;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({ request: async () => ((called = true), { status: 200, body: {} }) }),
    });
    await expect(service.patch('wh-1', form, true)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(message),
    });
    expect(called).toBe(false);
  });

  it('re-reads immediately before PATCH and sends only the reviewed generic fields', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method, _path, body) => {
          calls.push({ method, body });
          if (method === 'GET') return { status: 200, body: webhookRow() };
          return {
            status: 200,
            body: {
              items: {
                success: true,
                message: 'submitted-api-secret',
                hmacKey: 'unexpected-provider-secret',
              },
            },
          };
        },
      }),
    });
    const result = await service.patch('wh-1', { expectedGeneration: 1, name: 'renamed' }, true);
    expect(calls).toEqual([
      { method: 'GET', body: undefined },
      { method: 'PATCH', body: { input: { name: 'renamed' } } },
    ]);
    expect(result).toMatchObject({ ok: true, action: 'patched', message: 'webhook patched' });
    expect(JSON.stringify(result)).not.toMatch(/submitted-api-secret|unexpected-provider-secret/);
  });

  it('allows exact API_KEY and OIDC auth PATCH variants without returning credentials', async () => {
    const bodies: unknown[] = [];
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method, _path, body) => {
          if (method === 'GET') return { status: 200, body: webhookRow() };
          bodies.push(body);
          return { status: 200, body: { items: { success: true } } };
        },
      }),
    });
    const api = await service.patch(
      'wh-1',
      { expectedGeneration: 1, authMechanism: 'API_KEY', apiKey: 'new-api-secret' },
      true,
    );
    const oidc = await service.patch(
      'wh-1',
      {
        expectedGeneration: 1,
        authMechanism: 'OIDC',
        oidcClientId: 'client-id',
        oidcClientSecret: 'new-oidc-secret',
        oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
      },
      true,
    );
    expect(bodies).toEqual([
      { input: { authMechanism: 'API_KEY', apiKey: 'new-api-secret' } },
      {
        input: {
          authMechanism: 'OIDC',
          oidcDetails: {
            clientId: 'client-id',
            clientSecret: 'new-oidc-secret',
            wellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
          },
        },
      },
    ]);
    expect(JSON.stringify([api, oidc])).not.toMatch(/new-api-secret|new-oidc-secret/);
  });

  it('returns and audits an honest conflict without issuing PATCH', async () => {
    const methods: string[] = [];
    const dataDir = freshDataDir();
    const service = new CentralWebhooksService({
      dataDir,
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method) => {
          methods.push(method);
          return { status: 200, body: webhookRow('wh-1', { generation: 2 }) };
        },
      }),
    });
    const result = await service.patch('wh-1', { expectedGeneration: 1, name: 'renamed' }, true);
    expect(result).toMatchObject({ ok: false, action: 'conflict', httpCode: 409 });
    expect(methods).toEqual(['GET']);
    expect(readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')).toContain('"result":"conflict"');
  });

  it('does not PATCH when the mandatory re-read is denied and redacts provider text', async () => {
    const methods: string[] = [];
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method) => {
          methods.push(method);
          return {
            status: 403,
            body: { errorCode: 'HPE_GL_ERROR_FORBIDDEN', message: 'new-api-secret' },
          };
        },
      }),
    });
    await expect(
      service.patch('wh-1', { expectedGeneration: 1, name: 'renamed' }, true),
    ).rejects.toMatchObject({
      status: 502,
      message: expect.not.stringContaining('new-api-secret'),
    });
    expect(methods).toEqual(['GET']);
  });

  it('serializes same-ID rereads so the second stale request conflicts without a second PATCH', async () => {
    let currentGeneration = 1;
    let getCalls = 0;
    let patchCalls = 0;
    const firstPatchStarted = deferred();
    const releaseFirstPatch = deferred();
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method) => {
          if (method === 'GET') {
            getCalls += 1;
            return { status: 200, body: webhookRow('wh-1', { generation: currentGeneration }) };
          }
          patchCalls += 1;
          firstPatchStarted.resolve();
          await releaseFirstPatch.promise;
          currentGeneration += 1;
          return { status: 200, body: { items: { success: true } } };
        },
      }),
    });

    const first = service.patch('wh-1', { expectedGeneration: 1, name: 'first' }, true);
    await firstPatchStarted.promise;
    const second = service.patch('wh-1', { expectedGeneration: 1, name: 'second' }, true);
    await Promise.resolve();
    expect({ getCalls, patchCalls }).toEqual({ getCalls: 1, patchCalls: 1 });
    releaseFirstPatch.resolve();

    await expect(first).resolves.toMatchObject({ ok: true, action: 'patched' });
    await expect(second).resolves.toMatchObject({ ok: false, action: 'conflict', httpCode: 409 });
    expect({ getCalls, patchCalls }).toEqual({ getCalls: 2, patchCalls: 1 });
  });

  it('allows different webhook IDs to PATCH in parallel', async () => {
    const started = new Map([
      ['wh-1', deferred()],
      ['wh-2', deferred()],
    ]);
    const releases = new Map([
      ['wh-1', deferred()],
      ['wh-2', deferred()],
    ]);
    const patchCalls: string[] = [];
    let activePatches = 0;
    let maxActivePatches = 0;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method, path) => {
          const id = path.endsWith('/wh-1') ? 'wh-1' : 'wh-2';
          if (method === 'GET') return { status: 200, body: webhookRow(id) };
          patchCalls.push(id);
          activePatches += 1;
          maxActivePatches = Math.max(maxActivePatches, activePatches);
          started.get(id)?.resolve();
          await releases.get(id)?.promise;
          activePatches -= 1;
          return { status: 200, body: { items: { success: true } } };
        },
      }),
    });

    const first = service.patch('wh-1', { expectedGeneration: 1, name: 'first' }, true);
    const second = service.patch('wh-2', { expectedGeneration: 1, name: 'second' }, true);
    await Promise.all([started.get('wh-1')?.promise, started.get('wh-2')?.promise]);
    expect(maxActivePatches).toBe(2);
    releases.get('wh-1')?.resolve();
    releases.get('wh-2')?.resolve();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { ok: true, action: 'patched' },
      { ok: true, action: 'patched' },
    ]);
    expect(patchCalls.sort()).toEqual(['wh-1', 'wh-2']);
  });

  it('releases a same-ID lock after a rejected PATCH so the next request can proceed', async () => {
    const firstPatchStarted = deferred();
    const rejectFirstPatch = deferred();
    let getCalls = 0;
    let patchCalls = 0;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method) => {
          if (method === 'GET') {
            getCalls += 1;
            return { status: 200, body: webhookRow() };
          }
          patchCalls += 1;
          if (patchCalls === 1) {
            firstPatchStarted.resolve();
            await rejectFirstPatch.promise;
          }
          return { status: 200, body: { items: { success: true } } };
        },
      }),
    });

    const firstOutcome = service
      .patch('wh-1', { expectedGeneration: 1, name: 'first' }, true)
      .then(
        () => null,
        (error: unknown) => error,
      );
    await firstPatchStarted.promise;
    const second = service.patch('wh-1', { expectedGeneration: 1, name: 'second' }, true);
    rejectFirstPatch.reject(new Error('transport failed'));

    await expect(firstOutcome).resolves.toMatchObject({ status: 502 });
    await expect(second).resolves.toMatchObject({ ok: true, action: 'patched' });
    expect({ getCalls, patchCalls }).toEqual({ getCalls: 2, patchCalls: 2 });
  });
});

describe('callback URL and DNS validation', () => {
  it('records point-in-time validation and rejects if any DNS answer is non-public', async () => {
    const resolved: string[] = [];
    const dataDir = freshDataDir();
    const service = new CentralWebhooksService({
      dataDir,
      nowMs: () => Date.parse('2026-07-29T16:57:55.328Z'),
      effectiveDemoMode: () => false,
      resolveHostname: async (hostname) => {
        resolved.push(hostname);
        return publicDns(hostname);
      },
      plane: okTransport({
        request: async (method) =>
          method === 'GET'
            ? { status: 200, body: webhookRow() }
            : { status: 200, body: { items: { success: true } } },
      }),
    });
    const result = await service.patch(
      'wh-1',
      { expectedGeneration: 1, endpoint: 'https://hooks.example.com/central' },
      true,
    );
    expect(resolved).toEqual(['hooks.example.com']);
    expect(result.callbackValidatedAt).toBe('2026-07-29T16:57:55.328Z');
    expect(readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')).toContain(
      '"callbackValidatedAt":"2026-07-29T16:57:55.328Z"',
    );

    let centralCalled = false;
    const mixed = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      resolveHostname: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      plane: okTransport({ request: async () => ((centralCalled = true), { status: 200, body: {} }) }),
    });
    await expect(
      mixed.patch('wh-1', { expectedGeneration: 1, endpoint: 'https://hooks.example.com/central' }, true),
    ).rejects.toMatchObject({ status: 400 });
    expect(centralCalled).toBe(false);
  });

  it.each([
    'http://hooks.example.com/central',
    'https://localhost/central',
    'https://localhost./central',
    'https://hooks.example.com./central',
    'https://127.1/central',
    'https://0177.0.0.1/central',
    'https://10.0.0.1/central',
    'https://169.254.169.254/central',
    'https://192.0.2.1/central',
    'https://[::ffff:127.0.0.1]/central',
    'https://[fc00::1]/central',
    'https://[fe80::1]/central',
    'https://[fe80::1%25en0]/central',
  ])('rejects a non-canonical or non-public callback before Central: %s', async (endpoint) => {
    let called = false;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      resolveHostname: publicDns,
      plane: okTransport({ request: async () => ((called = true), { status: 200, body: {} }) }),
    });
    await expect(service.patch('wh-1', { expectedGeneration: 1, endpoint }, true)).rejects.toMatchObject({
      status: 400,
    });
    expect(called).toBe(false);
  });

  it('rejects DNS failures and permits HTTP only through the process-side test seam', async () => {
    const unresolved = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      resolveHostname: async () => {
        throw new Error('resolver details must not escape');
      },
      plane: okTransport(),
    });
    await expect(
      unresolved.patch('wh-1', { expectedGeneration: 1, endpoint: 'https://hooks.example.com/x' }, true),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.not.stringContaining('resolver details'),
    });

    const methods: string[] = [];
    const testOnly = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      allowInsecureCallbackForTests: true,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async (method) => {
          methods.push(method);
          return method === 'GET'
            ? { status: 200, body: webhookRow() }
            : { status: 200, body: { items: { success: true } } };
        },
      }),
    });
    expect(
      (
        await testOnly.patch(
          'wh-1',
          { expectedGeneration: 1, endpoint: 'http://hooks.example.com/test' },
          true,
        )
      ).ok,
    ).toBe(true);
    expect(methods).toEqual(['GET', 'PATCH']);
    await expect(
      testOnly.patch(
        'wh-1',
        {
          expectedGeneration: 1,
          endpoint: 'http://hooks.example.com/test',
          allowInsecureCallback: true,
        },
        true,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('DELETE semantics', () => {
  it('preserves documented 204 success and honest permission errors', async () => {
    const deleted = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({ request: async () => ({ status: 204, body: null }) }),
    });
    expect(await deleted.remove('wh-1', true)).toMatchObject({ ok: true, action: 'deleted', httpCode: 204 });

    const denied = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async () => ({
          status: 403,
          body: { errorCode: 'HPE_GL_ERROR_FORBIDDEN', message: 'provider-secret-text' },
        }),
      }),
    });
    const result = await denied.remove('wh-1', true);
    expect(result).toMatchObject({ ok: false, httpCode: 403 });
    expect(result.message).toContain('HPE_GL_ERROR_FORBIDDEN');
    expect(JSON.stringify(result)).not.toContain('provider-secret-text');
  });

  it('records a transport failure as outcome unknown', async () => {
    const dataDir = freshDataDir();
    const service = new CentralWebhooksService({
      dataDir,
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async () => {
          throw new Error('socket details');
        },
      }),
    });
    await expect(service.remove('wh-1', true)).rejects.toBeInstanceOf(CentralWebhooksError);
    const audit = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8');
    expect(audit).toContain('outcome unknown');
    expect(audit).not.toContain('socket details');
  });
});

async function startRoutedApp(
  service: InstanceType<typeof CentralWebhooksService>,
): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api', makeCentralWebhooksRouter(service));
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message || 'internal error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolveListening) => server.once('listening', resolveListening));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function sendJson(base: string, method: string, path: string, body: unknown): Promise<Res> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('central webhook routes', () => {
  it('admits lab create, patch, delete, and rotation without review confirmation while retaining their other write proofs', async () => {
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async (method, path) => {
          if (method === 'GET') return { status: 200, body: webhookRow() };
          if (method === 'POST' && path.endsWith('/rotate-hmac-key')) {
            return { status: 200, body: { items: { success: true, hmacKey: 'rotation-hmac' } } };
          }
          if (method === 'POST') return { status: 200, body: { items: { success: true, hmacKey: 'create-hmac' } } };
          if (method === 'PATCH') return { status: 200, body: { items: { success: true } } };
          return { status: 204, body: null };
        },
      }),
    });
    const tenantBinding = (await service.list(10, 0, '')).tenantBinding;
    const routed = await startRoutedApp(service);
    try {
      const create = await sendJson(routed.base, 'POST', '/api/central/webhooks', {
        form: CREATE_FORM,
        oneTimeSecretAcknowledged: true,
        reviewedTenantBinding: tenantBinding,
      });
      expect(create).toMatchObject({ status: 200, body: { ok: true, action: 'created', hmacKey: 'create-hmac' } });
      await sendJson(routed.base, 'POST', '/api/central/webhooks/handoff/acknowledge', {
        operationId: (create.body as { operationId: string }).operationId,
        secretStored: true,
      });
      await expect(sendJson(routed.base, 'PATCH', '/api/central/webhooks/wh-1', {
        form: { expectedGeneration: 1, name: 'renamed' },
      })).resolves.toMatchObject({ status: 200, body: { ok: true, action: 'patched' } });
      await expect(sendJson(routed.base, 'DELETE', '/api/central/webhooks/wh-1', {})).resolves.toMatchObject({
        status: 200,
        body: { ok: true, action: 'deleted' },
      });
      await expect(sendJson(routed.base, 'POST', '/api/central/webhooks/wh-1/rotate-hmac-key', {
        oneTimeSecretAcknowledged: true,
        reviewedTenantBinding: tenantBinding,
      })).resolves.toMatchObject({ status: 200, body: { ok: true, action: 'rotated', hmacKey: 'rotation-hmac' } });
    } finally {
      await closeServer(routed.server);
    }
  });

  it('rejects unconfirmed central webhook writes in hardened mode', async () => {
    settings.update({ configMode: false });
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      resolveHostname: publicDns,
      plane: okTransport({ request: async () => ({ status: 200, body: { items: { success: true, hmacKey: 'unused' } } }) }),
    });
    const tenantBinding = (await service.list(10, 0, '')).tenantBinding;
    const routed = await startRoutedApp(service);
    try {
      for (const [method, path, body] of [
        ['POST', '/api/central/webhooks', { form: CREATE_FORM, oneTimeSecretAcknowledged: true, reviewedTenantBinding: tenantBinding }],
        ['PATCH', '/api/central/webhooks/wh-1', { form: { expectedGeneration: 1, name: 'renamed' } }],
        ['DELETE', '/api/central/webhooks/wh-1', {}],
        ['POST', '/api/central/webhooks/wh-1/rotate-hmac-key', { oneTimeSecretAcknowledged: true, reviewedTenantBinding: tenantBinding }],
      ] as const) {
        await expect(sendJson(routed.base, method, path, body)).resolves.toMatchObject({
          status: 400,
          body: { error: expect.stringContaining('review confirmation') },
        });
      }
    } finally {
      settings.update({ configMode: true });
      await closeServer(routed.server);
    }
  });

  it('keeps full PUT replacement disabled without an outbound call', async () => {
    let called = false;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({ request: async () => ((called = true), { status: 200, body: {} }) }),
    });
    const routed = await startRoutedApp(service);
    try {
      const replace = await sendJson(routed.base, 'PUT', '/api/central/webhooks/wh-1', {
        form: CREATE_FORM,
        reviewConfirmed: true,
      });
      expect(replace).toMatchObject({ status: 501, body: { ok: false, action: 'unsupported' } });
      expect(called).toBe(false);
    } finally {
      await closeServer(routed.server);
    }
  });

  it('returns the one-time hmacKey only on successful reviewed create/rotate responses', async () => {
    const createHmac = 'route-create-hmac';
    const rotateHmac = 'route-rotate-hmac';
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async (method, path) => {
          if (method === 'GET') return { status: 200, body: webhookRow() };
          return path.endsWith('/rotate-hmac-key')
            ? { status: 200, body: { items: { id: 'wh-1', hmacKey: rotateHmac, success: true, message: 'rotated' } } }
            : { status: 200, body: { items: { id: 'wh-new', hmacKey: createHmac, success: true, message: 'created' } } };
        },
      }),
    });
    const tenantBinding = (await service.list(10, 0, '')).tenantBinding;
    const routed = await startRoutedApp(service);
    try {
      const create = await sendJson(routed.base, 'POST', '/api/central/webhooks', {
        form: CREATE_FORM,
        reviewConfirmed: true,
        oneTimeSecretAcknowledged: true,
        reviewedTenantBinding: tenantBinding,
      });
      await sendJson(routed.base, 'POST', '/api/central/webhooks/handoff/acknowledge', {
        operationId: (create.body as { operationId: string }).operationId,
        secretStored: true,
      });
      const rotate = await sendJson(routed.base, 'POST', '/api/central/webhooks/wh-1/rotate-hmac-key', {
        reviewConfirmed: true,
        oneTimeSecretAcknowledged: true,
        reviewedTenantBinding: tenantBinding,
      });
      const detailResponse = await fetch(`${routed.base}/api/central/webhooks/wh-1`);
      const detail = await detailResponse.json();

      expect(create).toMatchObject({ status: 200, body: { action: 'created', hmacKey: createHmac } });
      expect(rotate).toMatchObject({ status: 200, body: { action: 'rotated', hmacKey: rotateHmac } });
      expect(JSON.stringify(detail)).not.toMatch(/route-create-hmac|route-rotate-hmac/);
    } finally {
      await closeServer(routed.server);
    }
  });

  it('returns stable unknown results for malformed HTTP 200 create/rotate envelopes without exposing the body', async () => {
    const possibleSecret = 'malformed-route-secret';
    const dataDir = freshDataDir();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new CentralWebhooksService({
      dataDir,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => ({
          status: 200,
          body: { items: { hmac_key: possibleSecret }, diagnostic: possibleSecret },
        }),
      }),
    });
    const tenantBinding = (await service.list(10, 0, '')).tenantBinding;
    const routed = await startRoutedApp(service);
    try {
      const create = await sendJson(routed.base, 'POST', '/api/central/webhooks', {
        form: CREATE_FORM,
        reviewConfirmed: true,
        oneTimeSecretAcknowledged: true,
        reviewedTenantBinding: tenantBinding,
      });
      await sendJson(routed.base, 'POST', '/api/central/webhooks/handoff/resolve', {
        operationId: (create.body as { operationId: string }).operationId,
        resolution: 'create-absent',
        reviewConfirmed: true,
        attestations: {
          candidateAbsent: true,
          eventualConsistencyRiskAccepted: true,
        },
      });
      const rotate = await sendJson(routed.base, 'POST', '/api/central/webhooks/wh-1/rotate-hmac-key', {
        reviewConfirmed: true,
        oneTimeSecretAcknowledged: true,
        reviewedTenantBinding: tenantBinding,
      });

      expect(create).toMatchObject({
        status: 200,
        body: {
          action: 'unknown',
          outcome: 'unknown',
          code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
        },
      });
      expect(rotate).toMatchObject({
        status: 200,
        body: {
          action: 'unknown',
          outcome: 'unknown',
          code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
        },
      });
      expect(JSON.stringify([create, rotate])).not.toContain(possibleSecret);
      expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(possibleSecret);
      expect(readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')).not.toContain(possibleSecret);
    } finally {
      consoleSpy.mockRestore();
      await closeServer(routed.server);
    }
  });

  it('keeps transport details and possible secrets out of the 502 body, console log, and audit file', async () => {
    const possibleSecret = 'transport-secret-must-not-escape';
    const dataDir = freshDataDir();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new CentralWebhooksService({
      dataDir,
      resolveHostname: publicDns,
      plane: okTransport({
        request: async () => {
          throw new Error(`socket closed after ${possibleSecret}`);
        },
      }),
    });
    const tenantBinding = (await service.list(10, 0, '')).tenantBinding;
    const routed = await startRoutedApp(service);
    try {
      const result = await sendJson(routed.base, 'POST', '/api/central/webhooks', {
        form: CREATE_FORM,
        reviewConfirmed: true,
        oneTimeSecretAcknowledged: true,
        reviewedTenantBinding: tenantBinding,
      });
      expect(result.status).toBe(502);
      expect(JSON.stringify(result.body)).not.toContain(possibleSecret);
      expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(possibleSecret);
      expect(readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')).not.toContain(possibleSecret);
    } finally {
      consoleSpy.mockRestore();
      await closeServer(routed.server);
    }
  });

  it('returns HTTP 409 for a generation conflict and 200 for a reviewed PATCH', async () => {
    let generation = 2;
    const service = new CentralWebhooksService({
      dataDir: freshDataDir(),
      effectiveDemoMode: () => false,
      plane: okTransport({
        request: async (method) => {
          if (method === 'GET') return { status: 200, body: webhookRow('wh-1', { generation }) };
          return { status: 200, body: { items: { success: true } } };
        },
      }),
    });
    const routed = await startRoutedApp(service);
    try {
      const conflict = await sendJson(routed.base, 'PATCH', '/api/central/webhooks/wh-1', {
        form: { expectedGeneration: 1, name: 'renamed' },
        reviewConfirmed: true,
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ action: 'conflict' });

      generation = 1;
      const patched = await sendJson(routed.base, 'PATCH', '/api/central/webhooks/wh-1', {
        form: { expectedGeneration: 1, name: 'renamed' },
        reviewConfirmed: true,
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ ok: true, action: 'patched' });
    } finally {
      await closeServer(routed.server);
    }
  });
});
