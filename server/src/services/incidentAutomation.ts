/**
 * Turns canonical network-incident episodes into durable tickets.
 *
 * This module consumes only DeviceDownEvent decisions from the alert-rules
 * state machine and normalized WebhookReceivedEvent.clientFailure metadata.
 * It has no configuration-write dependency, and configuration services have
 * no dependency on it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WEBHOOK_SOURCE_PLANE,
  type AlertRow,
  type DeviceDownEvent,
  type Plane,
  type Tone,
  type WebhookReceivedEvent,
} from '@hpe/shared';
import { ticketStore, type IncidentTicketInput } from './tickets';

const SEV_TONE: Record<'P1' | 'P2' | 'P3', Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

function validIso(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

function compactMac(value: string): string | null {
  const compact = value.trim().toLowerCase().replace(/[:.-]/g, '');
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

export type IncidentLifecycleState = 'none' | 'open' | 'resolved';

export interface IncidentLifecycleCommand {
  key: string;
  desiredState: Exclude<IncidentLifecycleState, 'none'>;
  appliedState: IncidentLifecycleState;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
  open?: IncidentTicketInput;
  resolutionNote?: string;
}

interface IncidentTicketTarget {
  upsertIncident(input: IncidentTicketInput): unknown;
  resolveIncident(key: string, noteText: string): unknown;
}

export interface IncidentAutomationOptions {
  dataDir?: string;
  intervalMs?: number;
  nowMs?: () => number;
}

const DEFAULT_RETRY_INTERVAL_MS = 30_000;

function isLifecycleCommand(value: unknown): value is IncidentLifecycleCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<IncidentLifecycleCommand>;
  const structurallyValid = (
    typeof row.key === 'string' &&
    (row.desiredState === 'open' || row.desiredState === 'resolved') &&
    (row.appliedState === 'none' || row.appliedState === 'open' || row.appliedState === 'resolved') &&
    typeof row.attempts === 'number' && Number.isSafeInteger(row.attempts) && row.attempts >= 0 &&
    (row.lastError === null || typeof row.lastError === 'string') &&
    typeof row.updatedAt === 'string' && validIso(row.updatedAt) &&
    (row.open === undefined || (typeof row.open === 'object' && row.open !== null && !Array.isArray(row.open))) &&
    (row.resolutionNote === undefined || typeof row.resolutionNote === 'string')
  );
  if (!structurallyValid) return false;
  if (row.desiredState === 'open') {
    const open = row.open as Partial<IncidentTicketInput> | undefined;
    return Boolean(
      row.appliedState !== 'resolved' &&
      open && open.key === row.key && typeof open.alert === 'object' && open.alert !== null,
    );
  }
  return true;
}

function cloneCommand(command: IncidentLifecycleCommand): IncidentLifecycleCommand {
  return {
    ...command,
    ...(command.open ? { open: { ...command.open, alert: { ...command.open.alert } } } : {}),
  };
}

export class IncidentAutomation {
  private readonly dataDir: string;
  private readonly intervalMs: number;
  private readonly nowMs: () => number;
  private commands: IncidentLifecycleCommand[] | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tickets: IncidentTicketTarget = ticketStore,
    opts: IncidentAutomationOptions = {},
  ) {
    this.dataDir = opts.dataDir ?? process.env.HPE_DATA_DIR ?? path.resolve(__dirname, '..', '..', '..', 'data');
    this.intervalMs = opts.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  private get outboxFile(): string {
    return path.join(this.dataDir, 'incident-lifecycle-outbox.json');
  }

  /** Retry is independent of webhook redelivery, alert sampling, and
   * notification dispatch. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.retryPending();
    this.timer = setInterval(() => this.retryPending(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  retryPending(): void {
    try {
      for (const command of this.stored()) {
        if (command.desiredState !== command.appliedState) this.tryApply(command.key);
      }
    } catch (err) {
      console.error(`incident automation retry failed: ${(err as Error).message}`);
    }
  }

  lifecycleSnapshot(): IncidentLifecycleCommand[] {
    return this.stored().map(cloneCommand);
  }

  handleDeviceDownEvent(event: DeviceDownEvent): void {
    if (event.demo) return;
    const key = deviceDownIncidentKey(event);
    if (event.kind === 'recovered') {
      this.enqueueResolved(key, `${event.device.name} recovered after ${event.offlineMinutes}m offline`);
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
    this.enqueueOpen({
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
      this.enqueueResolved(
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
    this.enqueueOpen({
      key,
      kind: 'client-health',
      source: 'webhook',
      episodeStartedAt: event.clientFailure.episodeStartedAt,
      observedAt: event.eventAt ?? event.receivedAt,
      alert,
    });
  }

  /** Persist the desired lifecycle before attempting the ticket mutation.
   * Once desiredState reaches resolved, an out-of-order open can never
   * downgrade it — this record is the durable recovery-before-open marker. */
  private enqueueOpen(open: IncidentTicketInput): void {
    const commands = this.stored();
    const index = commands.findIndex((command) => command.key === open.key);
    const existing = index === -1 ? undefined : commands[index];
    if (existing?.desiredState === 'resolved') return;
    if (existing?.desiredState === 'open' && existing.appliedState === 'open') return;
    const command: IncidentLifecycleCommand = {
      key: open.key,
      desiredState: 'open',
      appliedState: existing?.appliedState ?? 'none',
      attempts: existing?.attempts ?? 0,
      lastError: existing?.lastError ?? null,
      updatedAt: this.nowIso(),
      open,
    };
    if (index === -1) commands.push(command);
    else commands[index] = command;
    this.save(commands); // the enqueue failure is allowed to reach the caller
    this.tryApply(open.key); // mutation failure remains pending and is swallowed
  }

  private enqueueResolved(key: string, resolutionNote: string): void {
    const commands = this.stored();
    const index = commands.findIndex((command) => command.key === key);
    const existing = index === -1 ? undefined : commands[index];
    if (existing?.desiredState === 'resolved' && existing.appliedState === 'resolved') return;
    const command: IncidentLifecycleCommand = {
      ...(existing ? cloneCommand(existing) : {
        key,
        appliedState: 'none' as const,
        attempts: 0,
        lastError: null,
        updatedAt: this.nowIso(),
      }),
      desiredState: 'resolved',
      resolutionNote,
      updatedAt: this.nowIso(),
    };
    if (index === -1) commands.push(command);
    else commands[index] = command;
    this.save(commands);
    this.tryApply(key);
  }

  private tryApply(key: string): void {
    const commands = this.stored();
    const index = commands.findIndex((command) => command.key === key);
    const current = index === -1 ? undefined : commands[index];
    if (!current || current.desiredState === current.appliedState) return;
    const attempted = { ...cloneCommand(current), attempts: current.attempts + 1, updatedAt: this.nowIso() };
    try {
      if (attempted.desiredState === 'open') {
        if (!attempted.open) throw new Error('open incident command has no ticket projection');
        this.tickets.upsertIncident(attempted.open);
      } else {
        this.tickets.resolveIncident(attempted.key, attempted.resolutionNote ?? 'Incident recovered');
      }
    } catch (err) {
      attempted.lastError = (err as Error).message;
      commands[index] = attempted;
      try {
        this.save(commands);
      } catch (saveErr) {
        // The original enqueue is already durable. Leaving its previous
        // appliedState guarantees a later retry, even if this diagnostic
        // update itself cannot be written.
        console.error(`incident automation could not record attempt for ${key}: ${(saveErr as Error).message}`);
      }
      console.error(`incident automation ticket mutation failed for ${key}: ${attempted.lastError}`);
      return;
    }
    attempted.appliedState = attempted.desiredState;
    attempted.lastError = null;
    commands[index] = attempted;
    try {
      this.save(commands);
    } catch (err) {
      // The ticket mutation is idempotent. If acknowledgement persistence
      // fails, the durable pre-mutation command remains pending and retrying
      // it is safer than guessing that it landed.
      console.error(`incident automation could not acknowledge ${key}: ${(err as Error).message}`);
    }
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /** Ordering state fails closed. Treating corruption as an empty queue could
   * allow a late open to resurrect an incident already resolved. */
  private stored(): IncidentLifecycleCommand[] {
    if (this.commands !== null) return this.commands.map(cloneCommand);
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.outboxFile, 'utf8'));
      if (
        !Array.isArray(parsed) ||
        !parsed.every(isLifecycleCommand) ||
        new Set(parsed.map((value) => value.key)).size !== parsed.length
      ) {
        throw new Error('outbox must be an array of valid lifecycle commands');
      }
      this.commands = parsed.map(cloneCommand);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.commands = [];
      else throw new Error(`unreadable incident lifecycle outbox: ${(err as Error).message}`);
    }
    return this.stored();
  }

  private save(commands: IncidentLifecycleCommand[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.outboxFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(commands, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.outboxFile);
    this.commands = commands.map(cloneCommand);
  }
}

export const incidentAutomation = new IncidentAutomation();
