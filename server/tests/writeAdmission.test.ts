import { describe, expect, it } from 'vitest';
import type { ConnectorConfig, ConnectorId } from '@hpe/shared';
import type { PlaneAdapter, PlaneCapabilities, PlaneId, PlaneState } from '../src/planes/types';
import {
  evaluateWriteAdmission,
  type WriteOperation,
} from '../src/services/writeAdmission';

const RULES: Array<{
  operation: WriteOperation;
  plane: ConnectorId;
  scope: 'write:brokered' | 'write:direct';
  capability: keyof PlaneCapabilities;
}> = [
  { operation: 'central-broker', plane: 'central', scope: 'write:brokered', capability: 'brokeredWrite' },
  { operation: 'ssid', plane: 'central', scope: 'write:direct', capability: 'directWrite' },
  { operation: 'ssid', plane: 'mist', scope: 'write:direct', capability: 'directWrite' },
  { operation: 'clearpass-object', plane: 'clearpass', scope: 'write:direct', capability: 'directWrite' },
  { operation: 'central-webhook', plane: 'central', scope: 'write:direct', capability: 'directWrite' },
  { operation: 'mist-webhook', plane: 'mist', scope: 'write:direct', capability: 'directWrite' },
];

function connector(id: ConnectorId, scopes: string[], enabled = true): ConnectorConfig {
  return {
    id,
    enabled,
    endpoint: `https://${id}.example.com`,
    auth: id === 'mist'
      ? { kind: 'token', token: 'secret', orgId: 'org-1' }
      : { kind: 'oauth_client_credentials', clientId: 'client', clientSecret: 'secret' },
    verifyTls: true,
    pollIntervalSec: 60,
    callBudget: null,
    datasets: [],
    scopes,
  } as ConnectorConfig;
}

function adapter(id: PlaneId, capabilities: PlaneCapabilities): PlaneAdapter {
  const state: PlaneState = {
    id,
    linked: true,
    health: 'healthy',
    lastSync: null,
    deviceCount: null,
    callsToday: 0,
    note: null,
  };
  return {
    id,
    state: () => state,
    pull: async () => ({}),
    capabilities: () => capabilities,
  };
}

function context(options: {
  configuredPlane?: ConnectorId;
  scopes?: string[];
  enabled?: boolean;
  linked?: boolean;
  capability?: PlaneCapabilities;
  adapterId?: PlaneId;
} = {}) {
  const configuredPlane = options.configuredPlane ?? 'central';
  const runtimeAdapter = adapter(options.adapterId ?? configuredPlane, options.capability ?? { brokeredWrite: true, directWrite: true });
  return {
    runtimeAdapter,
    context: {
      connectors: () => ({
        [configuredPlane]: connector(configuredPlane, options.scopes ?? ['write:brokered', 'write:direct'], options.enabled),
      }),
      registry: {
        state: (_id: PlaneId) => ({ ...runtimeAdapter.state(), linked: options.linked ?? true }),
        get: (_id: PlaneId) => runtimeAdapter,
      },
    },
  };
}

describe('evaluateWriteAdmission', () => {
  it.each(RULES)('admits $operation only when exact $plane linkage, scope, and capability agree', (rule) => {
    const { context: admissionContext, runtimeAdapter } = context({
      configuredPlane: rule.plane,
      scopes: [rule.scope],
      capability: { [rule.capability]: true },
    });

    const result = evaluateWriteAdmission({ operation: rule.operation, plane: rule.plane }, admissionContext);

    expect(result).toEqual({ ok: true, plane: rule.plane, adapter: runtimeAdapter });
  });

  it('rejects a plane the operation does not own before consulting its adapter', () => {
    let adapterReads = 0;
    const result = evaluateWriteAdmission(
      { operation: 'central-broker', plane: 'mist' },
      {
        connectors: () => ({ mist: connector('mist', ['write:brokered']) }),
        registry: {
          state: () => {
            adapterReads += 1;
            return { linked: true } as never;
          },
          get: () => {
            adapterReads += 1;
            return adapter('mist', { brokeredWrite: true });
          },
        },
      },
    );

    expect(result).toMatchObject({ ok: false, status: 409, code: 'wrong-plane' });
    expect(adapterReads).toBe(0);
  });

  it.each([
    ['missing connector', { configuredPlane: 'mist' as const }, 'unlinked'],
    ['disabled connector', { enabled: false }, 'unlinked'],
    ['unlinked runtime', { linked: false }, 'unlinked'],
    ['missing exact scope', { scopes: ['write:direct-extra'] }, 'scope-missing'],
    ['false capability', { capability: { brokeredWrite: false } }, 'capability-missing'],
    ['absent capability', { capability: {} }, 'capability-missing'],
    ['mismatched adapter identity', { adapterId: 'mist' as const }, 'wrong-plane'],
  ])('rejects %s', (_label, options, expectedCode) => {
    const { context: admissionContext } = context(options);
    const result = evaluateWriteAdmission({ operation: 'central-broker', plane: 'central' }, admissionContext);
    expect(result).toMatchObject({ ok: false, code: expectedCode });
  });
});
