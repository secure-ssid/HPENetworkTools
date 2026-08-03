import {
  parseConnectorConfig,
  type ConnectorConfig,
  type ConnectorId,
} from '@hpe/shared';
import type { PlaneCredentials } from '../config/settings';
import { Aos8Adapter } from '../planes/aos8';
import { AosCxAdapter } from '../planes/aoscx';
import { CentralAdapter } from '../planes/central';
import { ClearPassAdapter } from '../planes/clearpass';
import { EdgeConnectAdapter } from '../planes/edgeconnect';
import { GreenLakeAdapter } from '../planes/greenlake';
import { MistAdapter } from '../planes/mist';
import { OpsRampAdapter } from '../planes/opsramp';
import { SseAdapter } from '../planes/sse';
import { UxiAdapter } from '../planes/uxi';
import type { ConnectionProbeResult, PlaneAdapter, PlaneState } from '../planes/types';

export type ConnectorRecord = Record<ConnectorId, ConnectorConfig | null>;
export type RecordConnectorCall = (call: { path: string; ms: number; code: string }) => void;

/** The bounded authenticated read each product must pass before persistence. */
export const CONNECTOR_PROBE_DATASET = {
  central: 'devices',
  classic: 'devices',
  mist: 'devices',
  greenlake: 'subscriptions',
  clearpass: 'endpoints',
  uxi: 'sensors',
  aos8: 'devices',
  local: 'devices',
  sse: 'sse',
  edgeconnect: 'devices',
  opsramp: 'devices',
} as const satisfies Record<ConnectorId, ConnectionProbeResult['dataset']>;

function assertNever(value: never): never {
  throw new Error(`unsupported connector configuration: ${JSON.stringify(value)}`);
}

function policyCredentials(config: ConnectorConfig): PlaneCredentials {
  return {
    verifyTls: String(config.verifyTls),
    pollIntervalSec: String(config.pollIntervalSec),
    ...(config.callBudget === null ? {} : { callBudget: String(config.callBudget) }),
    scopes: config.scopes.join(','),
    ...(config.approvedFirmware === undefined ? {} : { approvedFirmware: config.approvedFirmware }),
  };
}

/**
 * Convert a validated typed connector to the exact flat key names consumed by
 * the existing adapters. This is the only typed-to-legacy conversion: the
 * settings store and the adapter registry never reconstruct typed state from
 * these derived credentials.
 */
export function adapterCredentialsFor(input: ConnectorConfig): PlaneCredentials {
  const config = parseConnectorConfig(input.id, input) as ConnectorConfig;
  const policy = policyCredentials(config);
  switch (config.id) {
    case 'central':
    case 'classic':
      return {
        gatewayBaseUrl: config.endpoint,
        clientId: config.auth.clientId,
        clientSecret: config.auth.clientSecret,
        ...policy,
      };
    case 'mist':
      return {
        apiHost: config.endpoint,
        orgId: config.auth.orgId,
        token: config.auth.token,
        ...policy,
      };
    case 'greenlake':
      return {
        baseUrl: config.endpoint,
        workspaceId: config.auth.workspaceId,
        clientId: config.auth.clientId,
        clientSecret: config.auth.clientSecret,
        ...policy,
      };
    case 'clearpass':
      return config.auth.kind === 'oauth_client_credentials'
        ? {
            publisher: config.endpoint,
            clientId: config.auth.clientId,
            clientSecret: config.auth.clientSecret,
            ...(config.auth.coaEnforcementProfile
              ? { coaEnforcementProfile: config.auth.coaEnforcementProfile }
              : {}),
            ...policy,
          }
        : {
            publisher: config.endpoint,
            token: config.auth.token,
            ...(config.auth.coaEnforcementProfile
              ? { coaEnforcementProfile: config.auth.coaEnforcementProfile }
              : {}),
            ...policy,
          };
    case 'uxi':
      return {
        baseUrl: config.endpoint,
        clientId: config.auth.clientId,
        clientSecret: config.auth.clientSecret,
        ...policy,
      };
    case 'aos8':
      return {
        master: config.endpoint,
        username: config.auth.username,
        password: config.auth.password,
        ...policy,
      };
    case 'local':
      return {
        baseUrl: config.endpoint,
        username: config.auth.username,
        ...(config.auth.password ? { password: config.auth.password } : {}),
        ...(config.auth.privateKey ? { privateKey: config.auth.privateKey } : {}),
        ...(config.auth.passphrase ? { passphrase: config.auth.passphrase } : {}),
        ...(config.auth.port ? { port: String(config.auth.port) } : {}),
        ...policy,
      };
    case 'sse':
      return { baseUrl: config.endpoint, token: config.auth.token, ...policy };
    case 'edgeconnect':
      return config.auth.kind === 'api_key'
        ? { baseUrl: config.endpoint, apiKey: config.auth.apiKey, ...policy }
        : {
            baseUrl: config.endpoint,
            username: config.auth.username,
            password: config.auth.password,
            ...policy,
          };
    case 'opsramp':
      return {
        baseUrl: config.endpoint,
        tenantId: config.auth.tenantId,
        clientId: config.auth.clientId,
        clientSecret: config.auth.clientSecret,
        ...policy,
      };
    default:
      return assertNever(config);
  }
}

/** Resolve one connector from typed settings only. Legacy planes are derived compatibility data. */
export function connectorConfigFor(
  settings: { connectors: Partial<ConnectorRecord>; planes?: unknown },
  id: ConnectorId,
): ConnectorConfig | null {
  return settings.connectors[id] ?? null;
}

/** Build the product's real adapter, or throw a precise configuration error. */
export function createConnectorAdapter(
  input: ConnectorConfig,
  state: PlaneState,
  recordCall: RecordConnectorCall,
): PlaneAdapter {
  const config = parseConnectorConfig(input.id, input) as ConnectorConfig;
  if (!config.enabled) throw new Error(`${config.id} connector is disabled`);
  const credentials = adapterCredentialsFor(config);
  // Explicit loopback HTTP is the labelled lab exception accepted by the
  // shared parser. The node:https transports cannot speak that scheme, so use
  // the platform fetch only for this already-validated loopback case.
  const labFetch = config.endpoint.startsWith('http://')
    ? ((url: string, init?: RequestInit) => fetch(url, init))
    : undefined;
  switch (config.id) {
    case 'central':
      return new CentralAdapter(credentials, state, recordCall);
    case 'classic': {
      const adapter = new CentralAdapter(credentials, state, recordCall);
      const capabilities = {
        localShell: false,
        brokeredWrite: false,
        configRead: false,
        directWrite: false,
        activeDiagnostics: false,
        alertFeed: true,
      } as const;
      // CentralAdapter chooses generation-specific paths from the endpoint,
      // but product identity and write authority come from the connector the
      // operator configured. A Classic record stays Classic/read-only even if
      // a lab points it at a hostname shaped like New Central.
      Object.defineProperty(adapter, 'id', { value: 'classic', enumerable: true });
      Object.defineProperty(adapter, 'capabilities', { value: () => capabilities });
      state.capabilities = capabilities;
      return adapter;
    }
    case 'mist':
      return new MistAdapter(credentials, state, recordCall);
    case 'greenlake':
      return new GreenLakeAdapter(credentials, state, recordCall);
    case 'clearpass':
      return new ClearPassAdapter(credentials, state, recordCall, labFetch);
    case 'uxi':
      return new UxiAdapter(credentials, state, recordCall);
    case 'aos8':
      return new Aos8Adapter(credentials, state, recordCall, labFetch);
    case 'local':
      return new AosCxAdapter('local', state, credentials, recordCall, labFetch);
    case 'sse':
      return new SseAdapter(credentials, state, recordCall);
    case 'edgeconnect':
      return new EdgeConnectAdapter('edgeconnect', state, credentials, recordCall, labFetch);
    case 'opsramp':
      return new OpsRampAdapter(credentials, state, recordCall);
    default:
      return assertNever(config);
  }
}
