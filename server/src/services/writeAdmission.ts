/**
 * The server-side admission boundary for configuration writes.
 *
 * Adapter capability is implementation truth, not authorization. A live
 * mutation is admitted only when the requested operation owns the exact
 * plane, that plane has an enabled canonical connector, the connector grants
 * the exact required scope, and the linked runtime adapter advertises the
 * matching capability. Callers use the returned adapter so admission and
 * execution cannot silently resolve different planes.
 */

import type { ConnectorConfig, ConnectorId } from '@hpe/shared';
import { settings } from '../config/settings';
import { registry as defaultRegistry } from '../planes/registry';
import type { PlaneAdapter, PlaneCapabilities, PlaneId, PlaneState } from '../planes/types';

export type WriteOperation =
  | 'central-broker'
  | 'ssid'
  | 'clearpass-object'
  | 'central-webhook'
  | 'mist-webhook';

type RequiredWriteScope = 'write:brokered' | 'write:direct';
type RequiredWriteCapability = 'brokeredWrite' | 'directWrite';

interface WriteRule {
  planes: readonly ConnectorId[];
  scope: RequiredWriteScope;
  capability: RequiredWriteCapability;
  label: string;
}

const WRITE_RULES: Record<WriteOperation, WriteRule> = {
  'central-broker': {
    planes: ['central'],
    scope: 'write:brokered',
    capability: 'brokeredWrite',
    label: 'Central broker write',
  },
  ssid: {
    planes: ['central', 'mist'],
    scope: 'write:direct',
    capability: 'directWrite',
    label: 'direct SSID write',
  },
  'clearpass-object': {
    planes: ['clearpass'],
    scope: 'write:direct',
    capability: 'directWrite',
    label: 'direct ClearPass object write',
  },
  'central-webhook': {
    planes: ['central'],
    scope: 'write:direct',
    capability: 'directWrite',
    label: 'Central webhook write',
  },
  'mist-webhook': {
    planes: ['mist'],
    scope: 'write:direct',
    capability: 'directWrite',
    label: 'Mist webhook write',
  },
};

export interface WriteAdmissionRequest {
  operation: WriteOperation;
  plane: ConnectorId;
}

export interface WriteAdmissionContext {
  connectors?: () => Partial<Record<ConnectorId, ConnectorConfig | null>>;
  registry?: {
    state(id: PlaneId): Pick<PlaneState, 'linked'>;
    get(id: PlaneId): PlaneAdapter;
  };
}

export type WriteAdmissionDenialCode =
  | 'wrong-plane'
  | 'unlinked'
  | 'scope-missing'
  | 'capability-missing';

export type WriteAdmissionResult =
  | { ok: true; plane: ConnectorId; adapter: PlaneAdapter }
  | {
      ok: false;
      status: 403 | 409;
      code: WriteAdmissionDenialCode;
      plane: ConnectorId;
      message: string;
    };

export type AdmitWrite = (request: WriteAdmissionRequest) => WriteAdmissionResult;

function denied(
  plane: ConnectorId,
  status: 403 | 409,
  code: WriteAdmissionDenialCode,
  message: string,
): WriteAdmissionResult {
  return { ok: false, status, code, plane, message };
}

export function evaluateWriteAdmission(
  request: WriteAdmissionRequest,
  context: WriteAdmissionContext = {},
): WriteAdmissionResult {
  const rule = WRITE_RULES[request.operation];
  if (!rule.planes.includes(request.plane)) {
    return denied(
      request.plane,
      409,
      'wrong-plane',
      `${rule.label} cannot target ${request.plane}; allowed plane${rule.planes.length === 1 ? '' : 's'}: ${rule.planes.join(', ')}`,
    );
  }

  const connectors = (context.connectors ?? (() => settings.get().connectors))();
  const connector = connectors[request.plane];
  if (!connector || connector.id !== request.plane || connector.enabled !== true) {
    return denied(
      request.plane,
      409,
      connector && connector.id !== request.plane ? 'wrong-plane' : 'unlinked',
      connector && connector.id !== request.plane
        ? `${rule.label} connector identity does not match ${request.plane}`
        : `${request.plane} is not linked with an enabled connector`,
    );
  }

  const runtime = context.registry ?? defaultRegistry;
  if (runtime.state(request.plane).linked !== true) {
    return denied(request.plane, 409, 'unlinked', `${request.plane} is not linked in the active runtime`);
  }
  if (!connector.scopes.includes(rule.scope)) {
    return denied(
      request.plane,
      403,
      'scope-missing',
      `${request.plane} connector does not grant the required ${rule.scope} scope`,
    );
  }

  const adapter = runtime.get(request.plane);
  if (adapter.id !== request.plane) {
    return denied(
      request.plane,
      409,
      'wrong-plane',
      `${rule.label} resolved a ${adapter.id} adapter instead of ${request.plane}`,
    );
  }
  const capabilities: PlaneCapabilities = adapter.capabilities?.() ?? {};
  if (capabilities[rule.capability] !== true) {
    return denied(
      request.plane,
      409,
      'capability-missing',
      `${request.plane} adapter does not support this ${rule.label}`,
    );
  }
  return { ok: true, plane: request.plane, adapter };
}

/** Exposed for server/UI projections that need the exact required grant. */
export function requiredScopeForWrite(operation: WriteOperation): RequiredWriteScope {
  return WRITE_RULES[operation].scope;
}

/** Exposed only for tests and honest capability projections. */
export function requiredCapabilityForWrite(operation: WriteOperation): keyof PlaneCapabilities {
  return WRITE_RULES[operation].capability;
}
