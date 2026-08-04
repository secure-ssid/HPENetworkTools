import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_IDS,
  migrateLegacyPlaneRecord,
  parseConnectorConfig,
  type ConnectorConfig,
} from '@hpe/shared';
import { Aos8Adapter } from '../planes/aos8';
import { AosCxAdapter } from '../planes/aoscx';
import { CentralAdapter } from '../planes/central';
import { ClearPassAdapter } from '../planes/clearpass';
import { EdgeConnectAdapter } from '../planes/edgeconnect';
import { GreenLakeAdapter } from '../planes/greenlake';
import { MistAdapter } from '../planes/mist';
import { OpsRampAdapter } from '../planes/opsramp';
import { PlaneRegistry, StubAdapter, UnconfiguredAdapter } from '../planes/registry';
import { SseAdapter } from '../planes/sse';
import { UxiAdapter } from '../planes/uxi';
import type { PlaneState } from '../planes/types';
import type { SettingsStore } from '../config/settings';
import {
  adapterCredentialsFor,
  connectorConfigFor,
  createConnectorAdapter,
} from './catalog';

const stateFor = (id: PlaneState['id']): PlaneState => ({
  id,
  linked: true,
  health: 'warning',
  lastSync: null,
  deviceCount: null,
  callsToday: 0,
  note: null,
});

const legacyById = {
  central: { gatewayBaseUrl: 'https://us4.api.central.arubanetworks.com', clientId: 'id', clientSecret: 'secret' },
  classic: { gatewayBaseUrl: 'https://classic.example.com', clientId: 'id', clientSecret: 'secret' },
  mist: { apiHost: 'https://api.mist.com', orgId: 'org-a', token: 'secret' },
  greenlake: { baseUrl: 'https://global.api.greenlake.hpe.com', workspaceId: 'workspace-a', clientId: 'id', clientSecret: 'secret' },
  clearpass: { publisher: 'https://cppm.example.com', clientId: 'id', clientSecret: 'secret' },
  uxi: { baseUrl: 'https://api.capenetworks.com', clientId: 'id', clientSecret: 'secret' },
  aos8: { master: 'https://10.48.0.10:4343', username: 'admin', password: 'secret' },
  local: { baseUrl: 'https://10.42.0.9', username: 'admin', password: 'secret' },
  sse: { baseUrl: 'https://admin-api.axissecurity.com', token: 'secret' },
  edgeconnect: { baseUrl: 'https://orchestrator.example.com', apiKey: 'secret' },
  opsramp: { baseUrl: 'https://app.opsramp.net', tenantId: 'tenant-a', clientId: 'id', clientSecret: 'secret' },
} as const;

const expectedClasses = {
  central: CentralAdapter,
  classic: CentralAdapter,
  mist: MistAdapter,
  greenlake: GreenLakeAdapter,
  clearpass: ClearPassAdapter,
  uxi: UxiAdapter,
  aos8: Aos8Adapter,
  local: AosCxAdapter,
  sse: SseAdapter,
  edgeconnect: EdgeConnectAdapter,
  opsramp: OpsRampAdapter,
} as const;

function configFor(id: (typeof CONNECTOR_IDS)[number]): ConnectorConfig {
  const migrated = migrateLegacyPlaneRecord(id, legacyById[id]);
  if (!migrated) throw new Error(`test fixture for ${id} did not migrate`);
  return migrated;
}

function registryFor(configs: Partial<Record<(typeof CONNECTOR_IDS)[number], ConnectorConfig | null>>): PlaneRegistry {
  const connectors = Object.fromEntries(CONNECTOR_IDS.map((id) => [id, configs[id] ?? null]));
  return new PlaneRegistry({
    get: () => ({ connectors, pollIntervalSec: 60 }),
  } as unknown as SettingsStore);
}

describe('server connector catalog', () => {
  it.each(CONNECTOR_IDS)('maps %s to a complete real adapter, never a stub', (id) => {
    const config = configFor(id);
    const adapter = createConnectorAdapter(config, stateFor(id), () => {});

    expect(adapter).toBeInstanceOf(expectedClasses[id]);
  });

  it('maps typed OpsRamp policy and authentication to the legacy keys its adapter consumes', () => {
    const config = parseConnectorConfig('opsramp', {
      ...configFor('opsramp'),
      verifyTls: false,
      pollIntervalSec: 120,
      callBudget: 50_000,
      scopes: ['read:inventory'],
    });

    expect(adapterCredentialsFor(config)).toEqual({
      baseUrl: 'https://app.opsramp.net',
      tenantId: 'tenant-a',
      clientId: 'id',
      clientSecret: 'secret',
      verifyTls: 'false',
      pollIntervalSec: '120',
      callBudget: '50000',
      scopes: 'read:inventory',
    });
  });

  it('rejects an enabled Local connector the current AOS-CX adapter cannot authenticate', () => {
    const invalidLocal = parseConnectorConfig('local', {
      ...configFor('local'),
      auth: { kind: 'ssh', username: 'admin', privateKey: 'private-key' },
    });

    expect(() => createConnectorAdapter(invalidLocal, stateFor('local'), () => {})).toThrow(
      /baseUrl plus username\/password/,
    );
  });

  it('reads only the typed connector record and never falls back to a stale legacy plane', () => {
    const opsramp = configFor('opsramp');
    const settings = {
      connectors: { opsramp },
      planes: { opsramp: { tenantId: 'stale' } },
    };

    expect(connectorConfigFor(settings, 'opsramp')).toBe(opsramp);
    expect(connectorConfigFor({ connectors: { opsramp: null }, planes: settings.planes }, 'opsramp')).toBeNull();
  });

  it('contains an invalid enabled configuration as a degraded error without creating a stub', () => {
    const invalidLocal = parseConnectorConfig('local', {
      ...configFor('local'),
      auth: { kind: 'ssh', username: 'admin', privateKey: 'private-key' },
    });
    const registry = registryFor({ local: invalidLocal });

    expect(registry.state('local')).toMatchObject({
      linked: true,
      health: 'degraded',
      note: expect.stringMatching(/baseUrl plus username\/password/),
    });
    expect(registry.get('local')).toBeInstanceOf(UnconfiguredAdapter);
    expect(registry.get('local')).not.toBeInstanceOf(StubAdapter);
  });

  it('keeps a disabled malformed connector unlinked without parsing credentials or endpoint', () => {
    const disabled = {
      ...configFor('opsramp'),
      enabled: false,
      endpoint: 'http://unsafe.example.com',
      auth: { kind: 'oauth_client_credentials', tenantId: '', clientId: '', clientSecret: '' },
    } as ConnectorConfig;
    const registry = registryFor({ opsramp: disabled });

    expect(registry.state('opsramp')).toMatchObject({
      linked: false,
      health: 'unlinked',
      note: 'connector disabled',
    });
    expect(registry.get('opsramp')).toBeInstanceOf(UnconfiguredAdapter);
  });

  it('binds Central identity and write capabilities to the configured product, not its hostname', () => {
    const newCentral = createConnectorAdapter(configFor('central'), stateFor('central'), () => {});
    const classicAtNewEndpoint = createConnectorAdapter(
      parseConnectorConfig('classic', {
        ...configFor('classic'),
        endpoint: 'https://us4.api.central.arubanetworks.com',
      }),
      stateFor('classic'),
      () => {},
    );

    expect(newCentral.id).toBe('central');
    expect(newCentral.capabilities?.()).toMatchObject({
      brokeredWrite: true,
      configRead: true,
      directWrite: true,
      activeDiagnostics: true,
    });
    expect(classicAtNewEndpoint.id).toBe('classic');
    expect(classicAtNewEndpoint.capabilities?.()).toMatchObject({
      brokeredWrite: false,
      configRead: false,
      directWrite: false,
      activeDiagnostics: false,
    });
  });

  it('derives AOS-10 visibility and capabilities from Central without an independent adapter', () => {
    const registry = registryFor({ central: configFor('central') });

    expect(registry.state('aos10')).toMatchObject({
      linked: false,
      health: 'unlinked',
      note: expect.stringContaining('derived from HPE Aruba Central'),
      capabilities: registry.state('central').capabilities,
    });
    expect(registry.get('aos10')).toBeInstanceOf(UnconfiguredAdapter);
  });
});
