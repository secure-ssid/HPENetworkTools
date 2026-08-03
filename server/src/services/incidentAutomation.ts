/**
 * Turns canonical network-incident episodes into durable tickets.
 *
 * This module consumes only DeviceDownEvent decisions from the alert-rules
 * state machine and normalized WebhookReceivedEvent.clientFailure metadata.
 * It has no configuration-write dependency, and configuration services have
 * no dependency on it.
 */

import {
  WEBHOOK_SOURCE_PLANE,
  type AlertRow,
  type DeviceDownEvent,
  type Plane,
  type Tone,
  type WebhookReceivedEvent,
} from '@hpe/shared';
import { TicketStore, ticketStore } from './tickets';

const SEV_TONE: Record<'P1' | 'P2' | 'P3', Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

function validIso(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

function compactMac(value: string): string | null {
  const compact = value.trim().toLowerCase().replace(/[:.\-]/g, '');
  return /^[0-9a-f]{12}$/.test(compact) ? compact : null;
}

function devicePlane(event: DeviceDownEvent): Plane {
  const plane = event.device.plane;
  const known: readonly Plane[] = [
    'CENTRAL',
    'CLASSIC',
    'MIST',
    'GREENLAKE',
    'AOS-8',
    'AOS-10',
    'LOCAL',
    'CLEARPASS',
    'UXI',
    'SSE',
    'EDGECONNECT',
    'OPSRAMP',
    'THIRD-PARTY',
  ];
  return known.includes(plane as Plane) ? (plane as Plane) : 'THIRD-PARTY';
}

export function deviceDownIncidentKey(event: DeviceDownEvent): string {
  return `device-down:${event.dedupKey}`;
}

/** Null is the safety boundary: events without canonical metadata, and every
 * session event even if malformed metadata is attached, cannot ticket. */
export function clientIncidentKey(event: WebhookReceivedEvent): string | null {
  if (event.eventType.startsWith('client-sessions:')) return null;
  const failure = event.clientFailure;
  if (!failure) return null;
  const mac = compactMac(failure.mac);
  if (!mac || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(failure.failureClass) || !validIso(failure.episodeStartedAt)) {
    return null;
  }
  return `client-health:${WEBHOOK_SOURCE_PLANE[event.source]}:${mac}:${failure.failureClass}:${failure.episodeStartedAt}`;
}

export class IncidentAutomation {
  constructor(private readonly tickets: TicketStore = ticketStore) {}

  handleDeviceDownEvent(event: DeviceDownEvent): void {
    if (event.demo) return;
    const key = deviceDownIncidentKey(event);
    if (event.kind === 'recovered') {
      this.tickets.resolveIncident(key, `${event.device.name} recovered after ${event.offlineMinutes}m offline`);
      return;
    }
    const alert: AlertRow = {
      sev: 'P2',
      tone: 'warning',
      title: 'Device offline',
      detail:
        `${event.device.name} has been offline for ${event.offlineMinutes}m — ` +
        `rule ${event.rule.id} alerts after ${event.rule.offlineMinutes}m.`,
      siteId: (event.device.siteId ?? 'multiple') as AlertRow['siteId'],
      siteName: event.device.siteName ?? 'Unknown site',
      plane: devicePlane(event),
      state: 'open',
      age: `${event.offlineMinutes}m`,
      device: event.device.name,
    };
    this.tickets.upsertIncident({
      key,
      kind: 'device-down',
      source: 'alert-rules',
      episodeStartedAt: event.outageStart,
      observedAt: event.at,
      alert,
    });
  }

  handleWebhookEvent(event: WebhookReceivedEvent): void {
    if (event.demo) return;
    const key = clientIncidentKey(event);
    if (!key || !event.clientFailure) return;
    if (event.state === 'cleared') {
      this.tickets.resolveIncident(
        key,
        `${event.clientFailure.mac} ${event.clientFailure.failureClass} failure recovered`,
      );
      return;
    }
    const alert: AlertRow = {
      sev: event.sev,
      tone: SEV_TONE[event.sev],
      title: event.title,
      detail: event.detail,
      siteId: event.siteId,
      siteName: event.siteName,
      plane: WEBHOOK_SOURCE_PLANE[event.source],
      state: event.state,
      age: 'now',
      device: event.device || event.clientFailure.mac,
      ...(event.alertId ? { alertId: event.alertId } : {}),
    };
    this.tickets.upsertIncident({
      key,
      kind: 'client-health',
      source: 'webhook',
      episodeStartedAt: event.clientFailure.episodeStartedAt,
      observedAt: event.eventAt ?? event.receivedAt,
      alert,
    });
  }
}

export const incidentAutomation = new IncidentAutomation();
