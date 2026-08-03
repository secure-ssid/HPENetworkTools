import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_CATALOG,
  maskConnectorConfig,
  migrateLegacyPlaneRecord,
  parseConnectorConfig,
} from './connectors';
import type { ConnectorId } from './connectors';
import { CONNECT_ENDPOINTS, CONNECT_ENDPOINT_KEY } from './fixtures';

const mistInput = {
  id: 'mist',
  enabled: true,
  endpoint: 'https://api.mist.com',
  auth: { kind: 'token', orgId: 'org-a', token: 'mist-secret' },
  verifyTls: true,
  pollIntervalSec: 60,
  callBudget: 20_000,
  datasets: ['devices', 'sites', 'clients', 'alerts'],
  scopes: ['read:inventory', 'read:clients-auth'],
};

describe('connector catalog', () => {
  it('lists every independently configurable product once and excludes AOS-10', () => {
    expect(CONNECTOR_CATALOG.map((entry) => entry.id)).toEqual([
      'central',
      'classic',
      'mist',
      'greenlake',
      'clearpass',
      'uxi',
      'aos8',
      'local',
      'sse',
      'edgeconnect',
      'opsramp',
    ]);
    expect(new Set(CONNECTOR_CATALOG.map((entry) => entry.id)).size).toBe(11);
  });

  it('parses a product-matched complete Mist configuration', () => {
    expect(parseConnectorConfig('mist', mistInput)).toMatchObject({
      id: 'mist',
      enabled: true,
      auth: { kind: 'token', orgId: 'org-a' },
    });
  });

  it.each([
    ['central', 'https://us4.api.central.arubanetworks.com', { kind: 'oauth_client_credentials', clientId: 'central-client', clientSecret: 'central-secret' }, ['clients'], ['write:brokered'], ['central-secret']],
    ['classic', 'https://classic.example.com', { kind: 'oauth_client_credentials', clientId: 'classic-client', clientSecret: 'classic-secret' }, ['clients'], ['read:inventory'], ['classic-secret']],
    ['mist', 'https://api.mist.com', { kind: 'token', orgId: 'mist-org', token: 'mist-token' }, ['clients'], ['write:direct'], ['mist-token']],
    ['greenlake', 'https://global.api.greenlake.hpe.com', { kind: 'oauth_client_credentials', workspaceId: 'workspace-a', clientId: 'gl-client', clientSecret: 'gl-secret' }, ['subscriptions'], ['write:direct'], ['gl-secret']],
    ['clearpass', 'https://cppm.example.com', { kind: 'token', token: 'cppm-token', coaEnforcementProfile: 'disconnect-a' }, ['authEvents'], ['write:direct'], ['cppm-token']],
    ['uxi', 'https://api.capenetworks.com', { kind: 'oauth_client_credentials', clientId: 'uxi-client', clientSecret: 'uxi-secret' }, ['uxiSensors'], ['read:inventory'], ['uxi-secret']],
    ['aos8', 'https://10.48.0.10:4343', { kind: 'username_password', username: 'aos8-user', password: 'aos8-password' }, ['clients'], ['ssh:recorded'], ['aos8-password']],
    ['local', 'https://10.42.0.9', { kind: 'ssh', username: 'cx-user', password: 'cx-password', privateKey: 'cx-private-key', passphrase: 'cx-passphrase', port: 22 }, ['devices'], ['ssh:recorded'], ['cx-password', 'cx-private-key', 'cx-passphrase']],
    ['sse', 'https://admin-api.axissecurity.com', { kind: 'token', token: 'sse-token' }, ['sse'], ['write:direct'], ['sse-token']],
    ['edgeconnect', 'https://orchestrator.example.com', { kind: 'api_key', apiKey: 'edge-api-key' }, ['alerts'], ['read:inventory'], ['edge-api-key']],
    ['opsramp', 'https://app.opsramp.net', { kind: 'oauth_client_credentials', tenantId: 'tenant-a', clientId: 'ops-client', clientSecret: 'ops-secret' }, ['alerts'], ['read:inventory'], ['ops-secret']],
  ] as const)('parses and masks %s', (id, endpoint, auth, datasets, scopes, secrets) => {
    const config = parseConnectorConfig(id as ConnectorId, {
      id,
      enabled: true,
      endpoint,
      auth,
      verifyTls: true,
      pollIntervalSec: 60,
      callBudget: null,
      datasets: [...datasets],
      scopes: [...scopes],
    });
    const masked = JSON.stringify(maskConnectorConfig(config));

    expect(config.id).toBe(id);
    for (const secret of secrets) expect(masked).not.toContain(secret);
  });

  it('keeps the flat drawer endpoint labels aligned with the legacy keys they populate', () => {
    expect([CONNECT_ENDPOINT_KEY.greenlake, CONNECT_ENDPOINTS.greenlake.label]).toEqual([
      'workspaceId',
      'GreenLake workspace ID',
    ]);
    expect([CONNECT_ENDPOINT_KEY.local, CONNECT_ENDPOINTS.local.label]).toEqual([
      'host',
      'Collector agent address',
    ]);
    expect([CONNECT_ENDPOINT_KEY.opsramp, CONNECT_ENDPOINTS.opsramp.label]).toEqual([
      'tenantId',
      'OpsRamp tenant ID',
    ]);
  });

  it.each([
    ['a different product id', { ...mistInput, id: 'central' }],
    ['an unsupported authentication kind', { ...mistInput, auth: { kind: 'api_key', apiKey: 'key-a' } }],
    ['an unknown nested authentication field', { ...mistInput, auth: { ...mistInput.auth, surprise: 'nope' } }],
    ['an empty required authentication field', { ...mistInput, auth: { ...mistInput.auth, orgId: ' ' } }],
    ['an unsupported dataset', { ...mistInput, datasets: ['subscriptions'] }],
    ['an unsupported scope', { ...mistInput, scopes: ['write:brokered'] }],
    ['a public plain-HTTP endpoint', { ...mistInput, endpoint: 'http://mist.example.com' }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseConnectorConfig('mist', input)).toThrow();
  });

  it('allows plain HTTP only for an explicit loopback lab endpoint', () => {
    expect(parseConnectorConfig('mist', { ...mistInput, endpoint: 'http://127.0.0.1:4010' }).endpoint)
      .toBe('http://127.0.0.1:4010');
  });

  it('masks every credential value without mutating the configuration', () => {
    const mistConfig = parseConnectorConfig('mist', mistInput);
    const masked = maskConnectorConfig(mistConfig);

    expect(JSON.stringify(masked)).not.toContain('mist-secret');
    expect(masked.auth).toMatchObject({ token: '••••••' });
    expect(mistConfig.auth).toMatchObject({ token: 'mist-secret' });
  });

  it('migrates legacy OpsRamp credentials to its real default endpoint', () => {
    expect(migrateLegacyPlaneRecord('opsramp', {
      tenantId: 'tenant-a',
      clientId: 'client-a',
      clientSecret: 'secret-a',
    })).toMatchObject({
      id: 'opsramp',
      endpoint: 'https://app.opsramp.net',
      auth: {
        kind: 'oauth_client_credentials',
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientSecret: 'secret-a',
      },
    });
  });

  it('retains legacy connector policy and firmware metadata', () => {
    expect(migrateLegacyPlaneRecord('central', {
      gatewayBaseUrl: 'https://us4.api.central.arubanetworks.com',
      clientId: 'client-a',
      clientSecret: 'secret-a',
      scopes: 'read:inventory,write:brokered',
      callBudget: '50000',
      verifyTls: 'false',
      pollIntervalSec: '120',
      approvedFirmware: '{"AP-635":"10.6.0.2"}',
    })).toMatchObject({
      scopes: ['read:inventory', 'write:brokered'],
      callBudget: 50_000,
      verifyTls: false,
      pollIntervalSec: 120,
      approvedFirmware: '{"AP-635":"10.6.0.2"}',
    });
  });
});
