/**
 * server/src/services/silences.ts — the alert-silence store.
 *
 * Time-boxed alert suppressions (shared/alertEngine.ts) persist to
 * data/silences.json (0600, atomic write, HPE_DATA_DIR override for tests),
 * the same pattern as the ticket store. Silences are real user data and
 * apply in BOTH demo and live mode, exactly like raised tickets: hushing
 * the demo queue is how the feature is tried out, and a silence that only
 * worked live would make the demo a lie about the feature.
 *
 * Expiry is honest, never a silent deletion. list() returns every silence
 * with a derived `expired` flag; active() — the only read the queue view
 * uses — filters the expired ones OUT OF MATCHING but they stay on disk and
 * stay listed. An expired silence is a record that an operator hushed the
 * queue, and the calendar turning over must not erase that record. Nothing
 * here ever rewrites the file to drop rows; only DELETE /api/silences/:id
 * removes one, and that is an audited operator action.
 *
 * Creation is audit-logged through the same append-only change log as every
 * other operator write (writeBroker.appendBrokerLog) — with ticket '—',
 * because a silence is NOT a brokered write: nothing leaves the portal, so
 * no ticket authorises it. What it changes is what the portal shows, and
 * the log line says who hushed what and until when.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  alertFingerprint,
  groupAlerts,
  maintenanceSiteMatches,
  partitionAlertGroups,
  silenceIsActive,
  silenceMatches,
  type AlertGroup,
  type AlertRow,
  type AlertSilence,
  type SilencedAlertGroup,
} from '@hpe/shared';
import { appendBrokerLog, brokerDataDir } from './writeBroker';

/** What a silence create needs from the route — the store stamps the rest. */
export interface SilenceInput {
  plane?: string;
  device?: string;
  titleContains?: string;
  reason: string;
  /** Operator silences are created by duration (the /api/silences route
   *  requires it). Trusted internal callers may instead pin an absolute end… */
  durationMinutes?: number;
  /** …which wins when set. The maintenance scheduler uses it so a window's
   *  silence ends at exactly the window's end, however late the tick ran. */
  until?: string;
  /** Site narrowing the shared silence matcher cannot express (it has no site
   *  key). Stamped by the maintenance scheduler; honored by alertQueueView's
   *  second partition phase. */
  site?: string;
  /** The maintenance window this silence was materialized from (absent =
   *  operator-created) — provenance for the timeline and the queue. */
  windowId?: string;
}

/**
 * A silence row plus the maintenance-window provenance the scheduler stamps.
 * The extra keys ride through the shared matchers untouched — silenceMatches
 * reads plane/device/titleContains only, so a window's silence still cannot
 * match by accident what its matchers did not name.
 */
export interface WindowSilence extends AlertSilence {
  site?: string;
  windowId?: string;
}

/** The /api/alerts queue view: active groups, silenced groups WITH their
 *  silences, and the flat rows with silenced firings taken out. */
export interface AlertQueueView {
  alerts: AlertRow[];
  groups: AlertGroup[];
  silenced: SilencedAlertGroup[];
}

export class SilenceStore {
  private silences: WindowSilence[] | null = null;

  constructor(private readonly dataDir: string = process.env.HPE_DATA_DIR ?? brokerDataDir()) {}

  private get file(): string {
    return path.join(this.dataDir, 'silences.json');
  }

  /** Rows exactly as persisted — the basis for every mutation and write. */
  private stored(): WindowSilence[] {
    if (this.silences !== null) return this.silences.map((s) => ({ ...s }));
    this.silences = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.silences = parsed as WindowSilence[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`silences: unreadable store, starting empty: ${(err as Error).message}`);
      }
    }
    return this.stored();
  }

  /** Every silence on file, each annotated with whether its clock has run
   *  out. Expired rows are READ, never dropped — see the header. */
  list(now: number = Date.now()): WindowSilence[] {
    return this.stored().map((s) => ({ ...s, expired: !silenceIsActive(s, now) }));
  }

  /** The silences that apply RIGHT NOW — the only set the queue view reads. */
  active(now: number = Date.now()): WindowSilence[] {
    return this.list(now).filter((s) => !s.expired);
  }

  /** Create and persist a silence. Validation lives in the route (it owns
   *  the 400s); by the time this runs the input is well-formed. */
  create(input: SilenceInput, now: number = Date.now()): WindowSilence {
    const created = new Date(now);
    const silence: WindowSilence = {
      id: `sil-${created.getTime().toString(36)}${randomBytes(3).toString('hex')}`,
      ...(input.plane ? { plane: input.plane } : {}),
      ...(input.device ? { device: input.device } : {}),
      ...(input.titleContains ? { titleContains: input.titleContains } : {}),
      ...(input.site ? { site: input.site } : {}),
      ...(input.windowId ? { windowId: input.windowId } : {}),
      reason: input.reason,
      createdAt: created.toISOString(),
      until: input.until ?? new Date(created.getTime() + (input.durationMinutes ?? 0) * 60_000).toISOString(),
    };
    this.save([silence, ...this.stored()]);
    return silence;
  }

  /** Remove a silence by id. Returns the removed row, or null for an unknown
   *  id — the route turns that into a 404, and nothing is audit-logged for a
   *  removal that removed nothing. */
  remove(id: string): WindowSilence | null {
    const silences = this.stored();
    const idx = silences.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const [removed] = silences.splice(idx, 1);
    this.save(silences);
    return removed ?? null;
  }

  private save(silences: WindowSilence[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(silences, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.silences = silences;
  }
}

export const silenceStore = new SilenceStore();

/**
 * The maintenance service's demo-fixture silences, registered while the
 * scheduler runs (server/src/services/maintenance.ts). They are VIRTUAL:
 * computed from the fixture windows on each read, never written to the
 * silence store or the audit log — fixtures must not put rows in the
 * operator's data. With no scheduler running (tests mounting createApp(),
 * a portal without the service) the source is null and the queue is exactly
 * what the store alone says.
 */
let fixtureSilenceSource: ((now: number) => WindowSilence[]) | null = null;

export function registerFixtureSilenceSource(source: ((now: number) => WindowSilence[]) | null): void {
  fixtureSilenceSource = source;
}

/**
 * The queue as the /api/alerts payload serves it: deduped groups with the
 * silenced ones lifted OUT of the active list and into their own collection
 * — with the silence that hushed them, so suppression is always visible.
 *
 * The flat `alerts` array loses the silenced firings too, because everything
 * derived from it (the correlateAlerts banner, the queue counts) must agree
 * with the queue on screen: a silenced P1 cannot headline "needs you now"
 * while its row is benched. The silenced collection carries the full group,
 * so nothing about the hushed firing is lost — it is moved, not hidden.
 *
 * Site-scoped silences (maintenance windows with a `site` matcher) run a
 * second partition phase: the shared matcher has no site key, so without this
 * they would hush the named device or title at EVERY site. The first phase is
 * exactly the partition the queue has always run; the second benches only
 * groups whose site the silence actually names.
 */
export function alertQueueView(alerts: AlertRow[], now: number = Date.now()): AlertQueueView {
  const applicable = [...silenceStore.active(now), ...(fixtureSilenceSource?.(now) ?? [])];
  const plain = applicable.filter((s) => !s.site);
  const siteScoped = applicable.filter((s) => s.site);
  const { active, silenced } = partitionAlertGroups(groupAlerts(alerts), plain, now);
  const stillActive: AlertGroup[] = [];
  for (const group of active) {
    const hit = siteScoped.find((s) => silenceMatches(s, group.latest) && maintenanceSiteMatches(s.site ?? '', group.latest));
    if (hit) silenced.push({ group, silence: hit });
    else stillActive.push(group);
  }
  const hushed = new Set(silenced.map((s) => s.group.fingerprint));
  return {
    alerts: alerts.filter((a) => !hushed.has(alertFingerprint(a))),
    groups: stillActive,
    silenced,
  };
}

/** One audit-log line for a silence create/remove. Never a payload body. */
export function logSilenceEvent(
  dataDir: string,
  event: 'alert-silence' | 'alert-unsilence' | 'maintenance-window',
  silence: AlertSilence,
  result: string,
  now: number = Date.now(),
): void {
  appendBrokerLog(dataDir, {
    ts: new Date(now).toISOString(),
    event,
    changeId: silence.id,
    // A silence is not a brokered write — nothing is pushed to a plane — so
    // no ticket authorises it. The log says that plainly rather than
    // inventing a reference.
    ticket: '—',
    kind: 'alert',
    result,
    ...(silence.device ? { device: silence.device } : {}),
    ...(silence.plane ? { plane: silence.plane } : {}),
  });
}
