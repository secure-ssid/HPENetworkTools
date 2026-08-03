import type { ConnectorConfig } from '@hpe/shared';
import { CONNECTOR_PROBE_DATASET, createConnectorAdapter, type RecordConnectorCall } from '../connectors/catalog';
import type { ConnectionProbeResult, PlaneState } from './types';

function stateFor(config: ConnectorConfig): PlaneState {
  return {
    id: config.id,
    linked: true,
    health: 'warning',
    lastSync: null,
    deviceCount: null,
    callsToday: 0,
    note: 'connection probe',
    callBudget: config.callBudget,
    token: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
  };
}

/**
 * Exercise one real, adapter-owned authenticated API read. This function never
 * includes an exception body or credential value in its result; callers can
 * safely return the result and record only the adapter's secret-free call log.
 */
export async function probeConnector(
  config: ConnectorConfig,
  recordCall: RecordConnectorCall,
): Promise<ConnectionProbeResult> {
  const dataset = CONNECTOR_PROBE_DATASET[config.id];
  let adapter;
  try {
    adapter = createConnectorAdapter(config, stateFor(config), recordCall);
  } catch {
    return {
      ok: false,
      authenticated: false,
      dataset,
      message: `${config.id} connector configuration is incomplete or unsafe`,
    };
  }

  try {
    if (!adapter.validateConnection) {
      return {
        ok: false,
        authenticated: false,
        dataset,
        message: `${config.id} has no authenticated connection probe`,
      };
    }
    return await adapter.validateConnection();
  } catch (err) {
    const detail = err instanceof Error ? err.message : '';
    const status = Number(/HTTP (\d{3})/i.exec(detail)?.[1] ?? 0) || undefined;
    const scopeDenied = status === 403;
    const rejected = status === 400 || status === 401 || /invalid_client|rejected|without an access_token/i.test(detail);
    return {
      ok: false,
      authenticated: scopeDenied,
      dataset,
      message: scopeDenied
        ? `${config.id} authenticated, but the credential lacks ${dataset} read privileges`
        : rejected
          ? `${config.id} rejected the credentials`
          : `${config.id} authenticated probe failed`,
      ...(status ? { status } : {}),
    };
  } finally {
    await adapter.dispose?.();
  }
}
