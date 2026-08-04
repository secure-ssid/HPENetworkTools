/**
 * server/src/services/webhookReceiver.ts — the inbound webhook receiver.
 *
 * Mist and New Central POST signed alert events to this portal; this service
 * is the single pipeline those deliveries run through:
 *
 *   verify → parse → normalize → record
 *
 * VERIFY. Each source has its own signature convention (see shared/webhooks.ts
 * for the vendor references): Mist hex-HMACs the raw body (SHA-256 in
 * X-Mist-Signature-v2, SHA-1 in X-Mist-Signature); New Central sends an
 * RFC 9421 HTTP Message Signature (Signature/Signature-Input, hmac-sha256)
 * keyed by the same HMAC secret its create/rotate operations issue — the
 * one-time key the management UI (CentralWebhooksPanel) hands to the
 * operator exactly once, which is why the receiver keeps its own copy.
 * Verification runs over the EXACT raw bytes received, never a re-serialized
 * parse — the routes mount a raw-body parser scoped to just the two paths.
 * Comparisons are timing-safe. The outcome vocabulary is fixed: 401 bad or
 * missing signature, 400 malformed body, 202 accepted, 503 when no secret is
 * configured at all (a receiver that cannot verify anything must say so,
 * not silently accept or silently refuse).
 *
 * SECRETS. Operator-supplied signing secrets persist to
 * data/webhook-receivers.json (0600, atomic write — the silences.ts store
 * pattern), write-only: no API ever returns one. In demo mode with no
 * operator secret stored, the PUBLIC demo secret (WEBHOOK_DEMO_RECEIVER_SECRET)
 * is effective instead, so the whole signed path works without credentials;
 * anything verified against it is labelled demo. Setting/clearing an
 * operator secret is audit-logged (never the secret itself).
 *
 * RECORD. Accepted events are normalized (per-source shapes below) into
 * WebhookReceivedEvent rows and go into two places: a bounded in-memory ring
 * (newest first, default 200) and an append-only data/webhook-events.jsonl
 * that rotates with the same tombstoned retention as change-log.jsonl
 * (logRotation.ts). The ring hydrates from the log on first read, so the
 * recent-events view survives a restart. Events carry raw severity + ISO
 * stamps; the AlertRow projection (webhookEventToAlertRow) is derived at
 * read time, so `age` never goes stale in the record.
 *
 * TOPICS. Mist normalization dispatches on the delivery's `topic`:
 * 'client-sessions' (connect/disconnect, next_ap = ROAM, termination_reason,
 * band/rssi/ssid per client) and 'device-updowns' (AP down = P2 firing, up =
 * P3 cleared) have dedicated mappers; every other topic takes the generic
 * alarm-shaped one. All of them feed the SAME dedup/group/silence alert
 * pipeline via withWebhookAlerts.
 *
 * REPLAYS. A redelivery of an event id already in the ring is accepted
 * idempotently (202, deduplicated) without a second record — vendor retries
 * must not multiply queue rows. The check is ring-scoped by design: it
 * catches the retry storm, and it never pretends to be an all-time ledger.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CENTRAL_SIGNATURE_HEADER,
  CENTRAL_SIGNATURE_INPUT_HEADER,
  MIST_SIGNATURE_V1_HEADER,
  MIST_SIGNATURE_V2_HEADER,
  WEBHOOK_DEMO_RECEIVER_SECRET,
  WEBHOOK_RECEIVER_SOURCES,
  WEBHOOK_SOURCE_PLANE,
  isWebhookReceivedEvent,
  type Sev,
  type Tone,
  type WebhookAlertRow,
  type WebhookClientFailureEpisode,
  type WebhookReceivedEvent,
  type WebhookReceiverSecretState,
  type WebhookReceiverSource,
  type WebhookReceiverSourceStatus,
} from '@hpe/shared';
import { ageString, num, parseTimestamp, sevFor, siteIdForName, str } from '../planes/format';
import { DEFAULT_POLICY, readJsonlNewestFirst, rotateIfNeeded, type RotationPolicy } from './logRotation';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { settings } from '../config/settings';
import { incidentAutomation as defaultIncidentAutomation } from './incidentAutomation';

// ---------------------------------------------------------------------------
// Receiver secret store — data/webhook-receivers.json (0600, write-only)
// ---------------------------------------------------------------------------

export interface StoredReceiverSecret {
  secret: string;
  updatedAt: string;
}

type ReceiverSecretFile = Partial<Record<WebhookReceiverSource, StoredReceiverSecret>>;

/** The silences.ts store pattern: lazy read, atomic tmp+rename write, 0600. */
export class ReceiverSecretStore {
  private secrets: ReceiverSecretFile | null = null;

  constructor(private readonly dataDir: string = process.env.HPE_DATA_DIR ?? brokerDataDir()) {}

  private get file(): string {
    return path.join(this.dataDir, 'webhook-receivers.json');
  }

  private stored(): ReceiverSecretFile {
    if (this.secrets !== null) return { ...this.secrets };
    this.secrets = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const source of WEBHOOK_RECEIVER_SOURCES) {
          const row = (parsed as Record<string, unknown>)[source];
          if (
            row &&
            typeof row === 'object' &&
            typeof (row as StoredReceiverSecret).secret === 'string' &&
            typeof (row as StoredReceiverSecret).updatedAt === 'string'
          ) {
            this.secrets[source] = row as StoredReceiverSecret;
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`webhook receivers: unreadable secret store, starting empty: ${(err as Error).message}`);
      }
    }
    return this.stored();
  }

  /** The stored secret for a source, or null when none is configured. The
   *  value leaves this store only to verify signatures — never to a response. */
  get(source: WebhookReceiverSource): StoredReceiverSecret | null {
    return this.stored()[source] ?? null;
  }

  set(source: WebhookReceiverSource, secret: string, now: number = Date.now()): void {
    const next = this.stored();
    next[source] = { secret, updatedAt: new Date(now).toISOString() };
    this.save(next);
  }

  /** Remove an operator secret. False when there was nothing to remove — the
   *  route turns that into a 404 and nothing is audit-logged. */
  clear(source: WebhookReceiverSource): boolean {
    const next = this.stored();
    if (!next[source]) return false;
    delete next[source];
    this.save(next);
    return true;
  }

  private save(secrets: ReceiverSecretFile): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.secrets = secrets;
  }
}

export const receiverSecretStore = new ReceiverSecretStore();

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/** Read a request header by lowercase name — the seam the routes bind to
 *  Express with, so verification itself never touches Express types. */
export type HeaderGetter = (name: string) => string | undefined;

/** What verification needs to know about the request beyond its bytes. */
export interface ReceiverRequestContext {
  method: string;
  /** Full path, no query ('/api/hooks/central'). */
  path: string;
  /** Query string INCLUDING the leading '?', or '' — part of @target-uri. */
  query: string;
  /** The scheme as observed by this server ('http' behind a TLS proxy). */
  protocol: string;
  /** The Host header as received. */
  host: string;
  /** Set by the demo simulate path so the accepted event is labelled demo. */
  demo?: boolean;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function hmac(alg: 'sha1' | 'sha256', secret: string, data: string | Buffer): Buffer {
  return createHmac(alg, secret).update(data).digest();
}

/**
 * Mist signs the raw body twice (see shared/webhooks.ts): SHA-256 hex in
 * X-Mist-Signature-v2, SHA-1 hex in X-Mist-Signature. v2 is checked first;
 * either matching accepts the delivery. A delivery carrying neither header
 * fails, as does a header that is not the right hex digest — no partial
 * credit, no unsigned fallback.
 */
export function verifyMistDelivery(secret: string, raw: Buffer, headers: HeaderGetter): boolean {
  const v2 = headers(MIST_SIGNATURE_V2_HEADER)?.trim();
  const v1 = headers(MIST_SIGNATURE_V1_HEADER)?.trim();
  if (!v2 && !v1) return false;
  if (v2 && safeEqual(Buffer.from(hmac('sha256', secret, raw).toString('hex'), 'utf8'), Buffer.from(v2, 'utf8'))) {
    return true;
  }
  if (v1 && safeEqual(Buffer.from(hmac('sha1', secret, raw).toString('hex'), 'utf8'), Buffer.from(v1, 'utf8'))) {
    return true;
  }
  return false;
}

/** The signing half of the Mist convention — the demo simulate path and the
 *  tests sign real deliveries with it. */
export function signMistDelivery(secret: string, raw: Buffer): Record<string, string> {
  return {
    [MIST_SIGNATURE_V1_HEADER]: hmac('sha1', secret, raw).toString('hex'),
    [MIST_SIGNATURE_V2_HEADER]: hmac('sha256', secret, raw).toString('hex'),
  };
}

interface ParsedSignatureInput {
  components: string[];
  /** The verbatim "(...)";created=…;keyid=…;alg=… string the signer covered —
   *  it goes into the signature base byte-for-byte. */
  paramsRaw: string;
}

/**
 * Parse `Signature-Input: sig1=("@method" … "date");created=…;alg="hmac-sha256"`.
 * Only the sig1 label New Central documents is understood, and only the
 * hmac-sha256 algorithm — anything else fails closed (a base we cannot
 * reconstruct cannot verify, and guessing is not a verification strategy).
 */
export function parseCentralSignatureInput(header: string): ParsedSignatureInput | null {
  const trimmed = header.trim();
  if (!trimmed.startsWith('sig1=(')) return null;
  const close = trimmed.indexOf(')');
  if (close === -1) return null;
  const components = trimmed
    .slice('sig1=('.length, close)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^"|"$/g, ''));
  if (components.length === 0 || components.some((c) => !/^(@[a-z-]+|date)$/.test(c))) return null;
  const paramsRaw = trimmed.slice('sig1='.length);
  const alg = /;alg="([^"]*)"/.exec(paramsRaw)?.[1];
  if (alg !== undefined && alg !== 'hmac-sha256') return null;
  return { components, paramsRaw };
}

/** RFC 9421 signature base: one `"<component>": <value>` line per covered
 *  component, then the `"signature-params": …` line. Null when a covered
 *  component cannot be resolved — verification fails rather than guesses. */
function buildSignatureBase(
  components: string[],
  paramsRaw: string,
  resolve: (component: string) => string | null,
): string | null {
  const lines: string[] = [];
  for (const component of components) {
    const value = resolve(component);
    if (value === null) return null;
    lines.push(`"${component}": ${value}`);
  }
  lines.push(`"signature-params": ${paramsRaw}`);
  return lines.join('\n');
}

/** The Host values a signature might plausibly cover: the header as received,
 *  plus the same host without a default port (a TLS-terminating proxy often
 *  rewrites one form into the other). */
function authorityVariants(host: string): string[] {
  const variants = [host];
  const match = /^(.*):(\d+)$/.exec(host);
  if (match && (match[2] === '443' || match[2] === '80') && match[1]) variants.push(match[1]);
  return [...new Set(variants)];
}

/**
 * New Central's RFC 9421 delivery signature (hmac-sha256 over the documented
 * derived components, keyed by the webhook's HMAC secret).
 *
 * The signed @scheme/@target-uri/@authority describe the URL CENTRAL posted
 * to, which is not necessarily what this server observes: TLS is expected to
 * terminate in front of the portal, so the request may arrive as plain http
 * with a rewritten Host. Verification therefore tries the observed scheme
 * AND its counterpart, and the Host with and without a default port — a
 * bounded set of honest candidates, not a loosening: every candidate still
 * has to produce the exact signature base the key signed.
 *
 * Deliberately NOT enforced: a `created` freshness window. Replay resistance
 * matters when acceptance triggers an action; here acceptance appends to an
 * idempotent-by-event-id record, so a replayed delivery dedupes to the row
 * it already produced, and a skewed receiver clock must not turn every
 * delivery into a 401.
 */
export function verifyCentralDelivery(
  secret: string,
  raw: Buffer,
  headers: HeaderGetter,
  ctx: ReceiverRequestContext,
): boolean {
  void raw; // the signature covers derived components, not the body bytes
  const signatureInput = headers(CENTRAL_SIGNATURE_INPUT_HEADER);
  const signatureHeader = headers(CENTRAL_SIGNATURE_HEADER);
  if (!signatureInput || !signatureHeader) return false;
  const parsed = parseCentralSignatureInput(signatureInput);
  const signatureMatch = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(signatureHeader.trim());
  if (!parsed || !signatureMatch) return false;
  const expected = Buffer.from(signatureMatch[1], 'base64');
  if (expected.length === 0) return false;
  const date = headers('date') ?? null;
  const schemes = [...new Set([ctx.protocol, ctx.protocol === 'https' ? 'http' : 'https'])];
  for (const scheme of schemes) {
    for (const authority of authorityVariants(ctx.host)) {
      const base = buildSignatureBase(parsed.components, parsed.paramsRaw, (component) => {
        switch (component) {
          case '@method':
            return ctx.method.toLowerCase();
          case '@target-uri':
            return `${scheme}://${authority}${ctx.path}${ctx.query}`;
          case '@authority':
            return authority;
          case '@scheme':
            return scheme;
          case '@path':
            return ctx.path;
          case 'date':
            return date;
          default:
            // A covered component this receiver cannot reconstruct — fail
            // closed for every candidate.
            return null;
        }
      });
      if (base === null) continue;
      if (safeEqual(hmac('sha256', secret, base), expected)) return true;
    }
  }
  return false;
}

/** The signing half of the Central convention — the demo simulate path signs
 *  its fixture delivery with exactly the components Central documents. */
export function signCentralDelivery(
  secret: string,
  ctx: ReceiverRequestContext,
  now: number = Date.now(),
): Record<string, string> {
  const components = ['@method', '@target-uri', '@authority', '@scheme', '@path', 'date'];
  const date = new Date(now).toUTCString();
  const created = Math.floor(now / 1000);
  const paramsRaw = `(${components.map((c) => `"${c}"`).join(' ')});created=${created};keyid="central-webhook";alg="hmac-sha256"`;
  const base = buildSignatureBase(components, paramsRaw, (component) => {
    switch (component) {
      case '@method':
        return ctx.method.toLowerCase();
      case '@target-uri':
        return `${ctx.protocol}://${ctx.host}${ctx.path}${ctx.query}`;
      case '@authority':
        return ctx.host;
      case '@scheme':
        return ctx.protocol;
      case '@path':
        return ctx.path;
      case 'date':
        return date;
      default:
        return null;
    }
  });
  if (base === null) throw new Error('cannot construct the Central signature base');
  return {
    date,
    [CENTRAL_SIGNATURE_INPUT_HEADER]: `sig1=${paramsRaw}`,
    [CENTRAL_SIGNATURE_HEADER]: `sig1=:${hmac('sha256', secret, base).toString('base64')}:`,
  };
}

// ---------------------------------------------------------------------------
// Normalization — vendor payload → the stored event shape
// ---------------------------------------------------------------------------

/** What a normalizer extracts from one vendor event — everything a stored
 *  WebhookReceivedEvent carries except the receiver's own id/stamps. */
interface NormalizedWebhookEvent {
  eventType: string;
  sev: Sev;
  title: string;
  detail: string;
  state: 'open' | 'acked' | 'cleared';
  device: string;
  siteId: WebhookReceivedEvent['siteId'];
  siteName: string;
  alertId?: string;
  eventAt: string | null;
  /** The source's own event id, when it sent one — the ring dedupe key. */
  externalId: string | null;
  clientFailure?: WebhookClientFailureEpisode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const s = str(item);
    if (s) return s;
  }
  return null;
}

/** 'rogue_ap' → 'Rogue Ap' — display casing only; the raw type survives in
 *  eventType, so no vendor vocabulary is lost to prettifying. */
function humanizeEventType(type: string): string {
  return type
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function stateFor(raw: string | null): 'open' | 'acked' | 'cleared' {
  const s = (raw ?? '').toLowerCase();
  if (/clear|resolv|clos|recover|healthy/.test(s)) return 'cleared';
  if (s.includes('ack')) return 'acked';
  return 'open';
}

function canonicalMac(raw: unknown): string | null {
  const value = str(raw);
  if (!value) return null;
  const compact = value.toLowerCase().replace(/[:.-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(compact)) return null;
  return compact.match(/.{2}/g)!.join(':');
}

function canonicalFailureClass(raw: unknown): string | null {
  const value = str(raw);
  if (!value) return null;
  const canonical = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return canonical && canonical.length <= 80 ? canonical : null;
}

type CanonicalFailureState = 'open' | 'cleared';

interface CanonicalClientFailure {
  episode: WebhookClientFailureEpisode;
  state: CanonicalFailureState;
}

function failureState(raw: string): CanonicalFailureState | null {
  const value = raw.trim().toLowerCase();
  if (/^(open|active|firing|failed|failure|down|acked)$/.test(value)) return 'open';
  if (/^(cleared|resolved|recovered|healthy|closed)$/.test(value)) return 'cleared';
  return null;
}

function canonicalIndicator(raw: unknown): string | null {
  const value = str(raw);
  return value ? value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null;
}

/** A client incident needs a positive machine-readable class. Failure fields
 * attached to config/session/telemetry events are explicitly denied. */
function isClientHealthEvent(
  source: WebhookReceiverSource,
  event: Record<string, unknown>,
  topic: string | null,
): boolean {
  const indicators = [
    canonicalIndicator(topic),
    canonicalIndicator(event.category),
    canonicalIndicator(event.type),
    canonicalIndicator(event.event_type),
    canonicalIndicator(event.incident_type),
    canonicalIndicator(event.incidentType),
  ].filter((value): value is string => value !== null);
  const pair = [canonicalIndicator(event.category), canonicalIndicator(event.type)].filter(Boolean).join('-');
  if (pair) indicators.push(pair);
  const denied = new Set(['config', 'configuration', 'session', 'sessions', 'telemetry', 'connect', 'disconnect', 'roam']);
  if (indicators.some((indicator) => indicator.split('-').some((token) => denied.has(token)))) return false;
  const positiveBySource: Record<WebhookReceiverSource, ReadonlySet<string>> = {
    mist: new Set([
      'client-health',
      'client-health-failure',
      'client-failure',
      'client-connectivity',
      'client-connectivity-failure',
      'client-authentication',
      'client-authentication-failure',
    ]),
    central: new Set([
      'client-health',
      'client-health-failure',
      'client-connectivity',
      'client-connectivity-failure',
      'client-authentication',
      'client-authentication-failure',
      'client-assurance',
      'client-assurance-failure',
    ]),
  };
  const positive = positiveBySource[source];
  return indicators.some((indicator) => positive.has(indicator));
}

/** Extract only a structured client-failure episode and its one canonical
 * lifecycle. Generic title/detail/severity/health fields are never inputs;
 * two supplied lifecycle fields that disagree fail closed. */
function explicitClientFailure(
  source: WebhookReceiverSource,
  event: Record<string, unknown>,
  topic: string | null,
): CanonicalClientFailure | null {
  if (!isClientHealthEvent(source, event, topic)) return null;
  const lifecycleValues = [event.failure_state, event.failureState, event.state, event.status]
    .map(str)
    .filter((value): value is string => value !== null);
  if (lifecycleValues.length === 0) return null;
  const states = lifecycleValues.map(failureState);
  if (states.some((state) => state === null)) return null;
  const distinctStates = new Set(states as CanonicalFailureState[]);
  if (distinctStates.size !== 1) return null;
  const mac = canonicalMac(
    event.client_mac ?? event.clientMac ?? event.client_mac_address ?? event.clientMacAddress ??
      event.mac_address ?? event.macAddress ?? event.mac,
  );
  const failureClass = canonicalFailureClass(event.failure_class ?? event.failureClass);
  const episodeMs = parseTimestamp(
    event.episode_start ?? event.episodeStart ?? event.episode_started_at ?? event.episodeStartedAt,
  );
  if (!mac || !failureClass || episodeMs === null) return null;
  return {
    episode: { mac, failureClass, episodeStartedAt: new Date(episodeMs).toISOString() },
    state: [...distinctStates][0]!,
  };
}

/**
 * A Mist 'client-sessions' event: one client's connect, disconnect or roam
 * (the roam word is `next_ap` — a connect carrying one IS a roam). These are
 * session telemetry, not alarms: every one maps P3 'open' with the CLIENT as
 * the row's device, so the alert queue shows who moved, where to, and on
 * which SSID — deduped against vendor redelivery by the event's own id (or
 * mac+type+timestamp when it carries none).
 */
function normalizeMistClientSession(event: Record<string, unknown>): NormalizedWebhookEvent | null {
  const mac = str(event.mac);
  if (!mac) return null; // a session event without a client is junk
  const type = (str(event.type) ?? '').toLowerCase();
  const nextAp = str(event.next_ap_name) ?? str(event.next_ap);
  const roamed = nextAp !== null || type === 'roam';
  const disconnected = type === 'disconnect' && !roamed;
  const title = roamed ? 'Client roamed' : disconnected ? 'Client disconnected' : 'Client connected';
  const client = str(event.hostname) ?? str(event.username) ?? mac;
  const ap = str(event.ap_name) ?? str(event.ap) ?? str(event.ap_mac);
  const band = str(event.band);
  const channel = num(event.channel);
  const rssi = num(event.rssi);
  const reason = str(event.termination_reason);
  const detail = [
    str(event.ssid) !== null ? `ssid ${str(event.ssid)}` : null,
    ap !== null ? `ap ${ap}` : null,
    roamed && nextAp !== null ? `→ ${nextAp}` : null,
    band !== null ? `${band} GHz` : null,
    channel !== null ? `ch ${channel}` : null,
    rssi !== null ? `rssi ${rssi} dBm` : null,
    disconnected && reason !== null ? `reason: ${reason}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const ts = parseTimestamp(event.timestamp ?? event.ts ?? event.time);
  const site = siteIdForName(str(event.site_name ?? event.site ?? event.siteName));
  return {
    eventType: `client-sessions:${roamed ? 'roam' : disconnected ? 'disconnect' : 'connect'}`,
    sev: 'P3',
    title,
    detail,
    state: 'open',
    device: client,
    siteId: site.siteId,
    siteName: site.siteName,
    ...(str(event.id) ? { alertId: str(event.id)! } : {}),
    eventAt: ts !== null ? new Date(ts).toISOString() : null,
    externalId: str(event.id) ?? (ts !== null ? `${mac}:${roamed ? 'roam' : disconnected ? 'disconnect' : 'connect'}:${ts}` : null),
  };
}

/**
 * A Mist 'device-updowns' event: an AP (or switch/gateway) going down or
 * coming back up. Down is the firing (P2, 'open' — the row the queue
 * groups/silences like a polled device_down alarm); up is the recovery
 * (P3, 'cleared' — the same alert vocabulary the polled path uses, so an
 * up never reads as a new problem). An event that is neither up nor down is
 * not this mapper's job and falls through to the generic normalizer.
 */
function normalizeMistDeviceUpdown(event: Record<string, unknown>): NormalizedWebhookEvent | null {
  const type = (str(event.type) ?? '').toLowerCase();
  const down = type === 'down';
  const up = type === 'up';
  if (!down && !up) return null;
  const device =
    str(event.device_name) ?? str(event.name) ?? str(event.hostname) ?? str(event.ap_name) ?? str(event.mac);
  if (!device) return null;
  const mac = str(event.mac);
  const detail = [str(event.model), mac !== null ? `mac ${mac}` : null]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const ts = parseTimestamp(event.timestamp ?? event.ts ?? event.time);
  const site = siteIdForName(str(event.site_name ?? event.site ?? event.siteName));
  return {
    eventType: `device-updowns:${type}`,
    sev: down ? 'P2' : 'P3',
    title: down ? 'Device down' : 'Device up',
    detail,
    state: down ? 'open' : 'cleared',
    device,
    siteId: site.siteId,
    siteName: site.siteName,
    ...(str(event.id) ? { alertId: str(event.id)! } : {}),
    eventAt: ts !== null ? new Date(ts).toISOString() : null,
    externalId: str(event.id) ?? (mac !== null && ts !== null ? `${mac}:${type}:${ts}` : null),
  };
}

/** The generic Mist event → normalized row (the pre-topic-mapper behaviour):
 *  alarms and any topic without a dedicated mapper. */
function normalizeMistGenericEvent(event: Record<string, unknown>, topic: string | null): NormalizedWebhookEvent | null {
  const type = str(event.type ?? event.event_type ?? event.name);
  const title = str(event.title) ?? (type ? humanizeEventType(type) : null);
  if (!title) return null;
  const sev = sevFor(str(event.severity ?? event.level));
  const ts = parseTimestamp(event.timestamp ?? event.last_seen ?? event.ts ?? event.time);
  const site = siteIdForName(str(event.site_name ?? event.site ?? event.siteName));
  const clientFailure = explicitClientFailure('mist', event, topic);
  const state = clientFailure?.state ?? stateFor(str(event.state ?? event.status));
  const externalId = str(event.id);
  return {
    eventType: topic && type ? `${topic}:${type}` : (type ?? topic ?? 'event'),
    sev,
    title,
    detail: str(event.detail ?? event.message ?? event.description) ?? '',
    state,
    device:
      str(event.device_name ?? event.device ?? event.hostname ?? event.ap_name ?? event.switch) ??
      firstString(event.aps) ??
      str(event.mac) ??
      '',
    siteId: site.siteId,
    siteName: site.siteName,
    ...(str(event.id) ? { alertId: str(event.id)! } : {}),
    eventAt: ts !== null ? new Date(ts).toISOString() : null,
    externalId: externalId ? `${externalId}:${state}` : null,
    ...(clientFailure ? { clientFailure: clientFailure.episode } : {}),
  };
}

/**
 * Mist deliveries are `{topic, events: [...]}` per the topic reference, but
 * the normalizer also accepts a bare event array or a single bare event —
 * a defensible reading of a signed body, never an invented one. Null when
 * nothing in the payload is recognizable as an event (the 400 case).
 *
 * The topic drives the mapper: 'client-sessions' and 'device-updowns' have
 * dedicated ones above (their fields mean specific things); everything else
 * takes the generic alarm-shaped mapper.
 */
function normalizeMistPayload(payload: unknown): NormalizedWebhookEvent[] | null {
  let events: Record<string, unknown>[];
  let topic: string | null = null;
  if (Array.isArray(payload)) {
    events = payload.filter(isRecord);
  } else if (isRecord(payload)) {
    topic = str(payload.topic);
    events = Array.isArray(payload.events) ? payload.events.filter(isRecord) : [payload];
  } else {
    return null;
  }
  const normalized: NormalizedWebhookEvent[] = [];
  for (const event of events) {
    const mapped =
      topic === 'client-sessions'
        ? normalizeMistClientSession(event)
        : topic === 'device-updowns'
          ? normalizeMistDeviceUpdown(event)
          : null;
    const n = mapped ?? normalizeMistGenericEvent(event, topic);
    if (n) normalized.push(n);
  }
  return normalized.length > 0 ? normalized : null;
}

/** New Central alert notifications name no device field, but the summary
 *  leads with it ('Device LR655 configuration is out of sync…') — the same
 *  leading-pattern rule the poller's own notification mapper follows. */
function deviceFromSummary(summary: string | null): string | null {
  if (!summary) return null;
  return /^Device\s+(\S+)/.exec(summary)?.[1] ?? null;
}

/** additionalDetails is a list of single-key objects; a site may ride there
 *  when the top-level fields do not carry one. */
function siteFromAdditionalDetails(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    for (const [key, value] of Object.entries(entry)) {
      if (/^site(_name)?$/i.test(key)) {
        const s = str(value);
        if (s) return s;
      }
    }
  }
  return null;
}

/** New Central's alert notification — the field vocabulary its documented
 *  ServiceNow workflow reads (name/summary/category/state/severity/time/
 *  impactedEntities/additionalDetails), with the same fallbacks the poller's
 *  notification mapper tolerates. Null when nothing is recognizable. */
function normalizeCentralPayload(payload: unknown): NormalizedWebhookEvent[] | null {
  let events: Record<string, unknown>[];
  if (Array.isArray(payload)) {
    events = payload.filter(isRecord);
  } else if (isRecord(payload)) {
    const nested = payload.events ?? payload.items ?? payload.notifications;
    events = Array.isArray(nested) ? nested.filter(isRecord) : [payload];
  } else {
    return null;
  }
  const normalized: NormalizedWebhookEvent[] = [];
  for (const event of events) {
    const title = str(event.name ?? event.title ?? event.alert_name);
    const detail = str(event.summary ?? event.description ?? event.message ?? event.details) ?? '';
    if (!title && !detail) continue;
    const sev = sevFor(str(event.severity ?? event.level ?? event.priority));
    const ts = parseTimestamp(event.time ?? event.timestamp ?? event.created_time ?? event.createdAt);
    const siteName = str(event.site ?? event.site_name ?? event.siteName) ?? siteFromAdditionalDetails(event.additionalDetails);
    const site = siteIdForName(siteName);
    const impacted = isRecord(event.impactedEntities) ? event.impactedEntities : null;
    const clientFailure = explicitClientFailure('central', event, null);
    const state = clientFailure?.state ?? stateFor(str(event.state ?? event.status));
    const alertId = str(event.alertId ?? event.alert_id ?? event.id);
    normalized.push({
      eventType: str(event.category ?? event.type) ?? 'alert',
      sev,
      title: title ?? 'Alert notification',
      detail,
      state,
      device:
        str(event.device ?? event.device_name ?? event.hostname) ??
        deviceFromSummary(detail) ??
        firstString(impacted?.deviceSerial) ??
        '',
      siteId: site.siteId,
      siteName: site.siteName,
      ...(alertId ? { alertId } : {}),
      eventAt: ts !== null ? new Date(ts).toISOString() : null,
      // The same alert arriving in a new state (Open → Cleared) is a new
      // firing of the same problem — the group, not a duplicate.
      externalId: alertId ? `${alertId}:${state}` : null,
      ...(clientFailure ? { clientFailure: clientFailure.episode } : {}),
    });
  }
  return normalized.length > 0 ? normalized : null;
}

// ---------------------------------------------------------------------------
// The AlertRow projection — derived at read time, never stored
// ---------------------------------------------------------------------------

const SEV_TONE: Record<Sev, Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

/** A stored event as an alert-queue row: a full AlertRow through the SAME
 *  fingerprint/group/silence path as polled rows, marked source 'webhook'
 *  and badged with the plane that actually delivered it. `age` is computed
 *  from the source's own event stamp (falling back to receipt time) at the
 *  moment of the read, so it never goes stale. */
export function webhookEventToAlertRow(event: WebhookReceivedEvent, nowMs: number = Date.now()): WebhookAlertRow {
  const eventMs = event.eventAt ? Date.parse(event.eventAt) : Number.NaN;
  const receivedMs = Date.parse(event.receivedAt);
  const when = Number.isFinite(eventMs) ? eventMs : receivedMs;
  return {
    sev: event.sev,
    tone: SEV_TONE[event.sev],
    title: event.title,
    detail: event.detail,
    siteId: event.siteId,
    siteName: event.siteName,
    plane: WEBHOOK_SOURCE_PLANE[event.source],
    state: event.state,
    age: Number.isFinite(when) ? ageString(when, nowMs) : '—',
    device: event.device,
    ...(event.alertId ? { alertId: event.alertId } : {}),
    source: 'webhook',
  };
}

// ---------------------------------------------------------------------------
// The receiver
// ---------------------------------------------------------------------------

/** The redelivery-dedupe key of a STORED event, derived the same way the
 *  normalizer derives externalId for a fresh one: the recorded `dedupeKey`
 *  wins; events recorded before that field existed fall back to the legacy
 *  rule (alertId+state — an Open→Cleared transition is a new firing for
 *  either source). Null when neither exists —
 *  such events are recorded every time. */
function storedDedupeKey(event: WebhookReceivedEvent): string | null {
  if (event.dedupeKey) return `${event.source}:${event.dedupeKey}`;
  if (!event.alertId) return null;
  return `${event.source}:${event.alertId}:${event.state}`;
}

export interface IngestOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookReceiverOptions {
  dataDir?: string;
  /** Bounded in-memory record size; the jsonl keeps the longer history. */
  ringSize?: number;
  /** Rotation for webhook-events.jsonl — injected small in tests. */
  rotationPolicy?: RotationPolicy;
  secrets?: ReceiverSecretStore;
  /** Demo-mode read, injected so tests do not depend on global settings. */
  demoMode?: () => boolean;
  nowMs?: () => number;
  /** Test seam; production forwards newly recorded events to the incident
   * automation singleton after the webhook record is durable. */
  incidentAutomation?: { handleWebhookEvent(event: WebhookReceivedEvent): void };
}

const DEFAULT_RING_SIZE = 200;
const MIN_SECRET_CHARS = 8;
const MAX_SECRET_CHARS = 1024;

export class WebhookReceiver {
  private readonly dataDir: string;
  private readonly ringSize: number;
  private readonly rotationPolicy: RotationPolicy | undefined;
  private readonly secrets: ReceiverSecretStore;
  private readonly demoMode: () => boolean;
  private readonly nowMs: () => number;
  private readonly incidentAutomation: { handleWebhookEvent(event: WebhookReceivedEvent): void };
  /** Newest-first record; null until first read hydrates it from the log. */
  private ring: WebhookReceivedEvent[] | null = null;

  constructor(opts: WebhookReceiverOptions = {}) {
    this.dataDir = opts.dataDir ?? process.env.HPE_DATA_DIR ?? brokerDataDir();
    this.ringSize = opts.ringSize ?? DEFAULT_RING_SIZE;
    this.rotationPolicy = opts.rotationPolicy;
    this.secrets = opts.secrets ?? receiverSecretStore;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.incidentAutomation = opts.incidentAutomation ?? defaultIncidentAutomation;
  }

  private get eventsFile(): string {
    return path.join(this.dataDir, 'webhook-events.jsonl');
  }

  /** The secret a delivery for this source verifies against RIGHT NOW:
   *  the operator's when stored, the public demo secret in demo mode
   *  otherwise, nothing at all outside demo mode without one. */
  effectiveSecret(source: WebhookReceiverSource): { secret: string; state: WebhookReceiverSecretState } | null {
    const stored = this.secrets.get(source);
    if (stored) return { secret: stored.secret, state: 'operator' };
    if (this.demoMode()) return { secret: WEBHOOK_DEMO_RECEIVER_SECRET, state: 'demo' };
    return null;
  }

  /** Store an operator signing secret and audit-log the fact (never the
   *  value). A stored secret replaces the demo secret for that source. */
  setSecret(source: WebhookReceiverSource, secret: string): void {
    this.secrets.set(source, secret, this.nowMs());
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'webhook-receiver-secret-set',
      changeId: `whsec-${source}-${this.nowMs().toString(36)}${randomBytes(3).toString('hex')}`,
      ticket: '—',
      kind: 'webhook',
      result: `${source} receiver signing secret stored (write-only, never logged)`,
    });
  }

  /** Clear an operator secret. False when none was stored — nothing to log. */
  clearSecret(source: WebhookReceiverSource): boolean {
    if (!this.secrets.clear(source)) return false;
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'webhook-receiver-secret-cleared',
      changeId: `whsec-${source}-${this.nowMs().toString(36)}${randomBytes(3).toString('hex')}`,
      ticket: '—',
      kind: 'webhook',
      result: `${source} receiver signing secret cleared`,
    });
    return true;
  }

  /** Newest-first received events, bounded by the ring. Hydrated from the
   *  append-only log on first read so the view survives a restart. */
  recent(limit?: number): WebhookReceivedEvent[] {
    const events = this.events();
    return limit !== undefined ? events.slice(0, Math.max(0, limit)) : events.map((e) => ({ ...e }));
  }

  /** The queue-ready projection of every event on record. */
  recentAlertRows(nowMs: number = this.nowMs()): WebhookAlertRow[] {
    return this.events().map((event) => webhookEventToAlertRow(event, nowMs));
  }

  /** Per-source receiver status — the nothing-received-yet state is explicit
   *  (lastReceivedAt null, count 0), never an absent object. */
  status(): WebhookReceiverSourceStatus[] {
    const events = this.events();
    return WEBHOOK_RECEIVER_SOURCES.map((source) => {
      const own = events.filter((event) => event.source === source);
      return {
        source,
        label: source === 'mist' ? 'Mist' : 'New Central',
        path: `/api/hooks/${source}`,
        secret: this.effectiveSecret(source)?.state ?? 'none',
        lastReceivedAt: own[0]?.receivedAt ?? null,
        receivedCount: own.length,
      };
    });
  }

  /**
   * The one pipeline every delivery runs through — the mounted routes and
   * the demo simulate path alike. 401 bad/missing signature, 400 malformed
   * body or unrecognizable payload, 503 no secret configured, 202 accepted
   * (with `deduplicated` naming any vendor redelivery that added nothing).
   */
  ingest(
    source: WebhookReceiverSource,
    raw: Buffer,
    headers: HeaderGetter,
    ctx: ReceiverRequestContext,
  ): IngestOutcome {
    const effective = this.effectiveSecret(source);
    if (!effective) {
      return {
        status: 503,
        body: {
          error:
            `no ${source} webhook signing secret is configured — the receiver cannot verify ` +
            'deliveries and refuses them rather than accepting unsigned input',
        },
      };
    }
    const verified =
      source === 'mist'
        ? verifyMistDelivery(effective.secret, raw, headers)
        : verifyCentralDelivery(effective.secret, raw, headers, ctx);
    if (!verified) {
      return { status: 401, body: { error: 'signature verification failed' } };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'malformed JSON body' } };
    }
    const normalized = source === 'mist' ? normalizeMistPayload(payload) : normalizeCentralPayload(payload);
    if (!normalized) {
      return { status: 400, body: { error: 'no recognizable events in payload' } };
    }
    // Demo stays labelled: a delivery through the simulate path, or one
    // verified against the public demo secret, is demo data wherever it lands.
    const demo = ctx.demo === true || effective.state === 'demo';
    const accepted: WebhookReceivedEvent[] = [];
    let deduplicated = 0;
    for (const n of normalized) {
      const key = n.externalId ? `${source}:${n.externalId}` : null;
      const duplicate = key ? this.events().find((event) => storedDedupeKey(event) === key) : undefined;
      if (duplicate) {
        deduplicated += 1;
        continue;
      }
      const event = this.toEvent(source, n, demo);
      // Qualifying incidents must be in the durable lifecycle outbox before
      // this receiver acknowledges or records acceptance. A ticket-store
      // mutation failure is swallowed by the outbox; only enqueue persistence
      // failure reaches this boundary as a 503.
      const failure = this.enqueueIncident(event);
      if (failure) return failure;
      this.record(event);
      accepted.push(event);
    }
    return {
      status: 202,
      body: {
        accepted: accepted.length,
        ...(deduplicated > 0 ? { deduplicated } : {}),
        events: accepted.map((e) => ({ id: e.id, title: e.title })),
      },
    };
  }

  private enqueueIncident(event: WebhookReceivedEvent): IngestOutcome | null {
    try {
      this.incidentAutomation.handleWebhookEvent(event);
      return null;
    } catch (err) {
      console.error(`incident lifecycle enqueue failed for webhook ${event.id}: ${(err as Error).message}`);
      return {
        status: 503,
        body: { error: 'incident lifecycle could not be durably enqueued; retry this delivery' },
      };
    }
  }

  private toEvent(source: WebhookReceiverSource, n: NormalizedWebhookEvent, demo: boolean): WebhookReceivedEvent {
    return {
      id: `evt-${this.nowMs().toString(36)}${randomBytes(3).toString('hex')}`,
      source,
      receivedAt: new Date(this.nowMs()).toISOString(),
      eventType: n.eventType,
      demo,
      sev: n.sev,
      title: n.title,
      detail: n.detail,
      state: n.state,
      device: n.device,
      siteId: n.siteId,
      siteName: n.siteName,
      ...(n.alertId ? { alertId: n.alertId } : {}),
      ...(n.externalId ? { dedupeKey: n.externalId } : {}),
      eventAt: n.eventAt,
      ...(n.clientFailure ? { clientFailure: n.clientFailure } : {}),
    };
  }

  private record(event: WebhookReceivedEvent): void {
    this.events().unshift(event);
    if (this.ring && this.ring.length > this.ringSize) this.ring.length = this.ringSize;
    this.append(event);
  }

  private events(): WebhookReceivedEvent[] {
    if (this.ring !== null) return this.ring;
    this.ring = [];
    const read = readJsonlNewestFirst(this.eventsFile, this.ringSize, isWebhookReceivedEvent);
    if (read.unreadable.length > 0) {
      console.error(`webhook receivers: unreadable event log generations: ${read.unreadable.join(', ')}`);
    }
    this.ring = read.entries;
    return this.ring;
  }

  /** Append-only record with the change-log's rotation discipline. A log
   *  failure must not fail the pipeline — the event is already accepted; the
   *  write failure is shouted to the console instead. */
  private append(event: WebhookReceivedEvent): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      rotateIfNeeded(this.eventsFile, this.rotationPolicy ?? DEFAULT_POLICY);
      fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n', { mode: 0o600 });
      fs.chmodSync(this.eventsFile, 0o600); // in case it pre-existed with a looser mode
    } catch (err) {
      console.error(`webhook receivers: event log write failed: ${(err as Error).message}`);
    }
  }
}

export const webhookReceiver = new WebhookReceiver();

export { MIN_SECRET_CHARS as WEBHOOK_SECRET_MIN_CHARS, MAX_SECRET_CHARS as WEBHOOK_SECRET_MAX_CHARS };
