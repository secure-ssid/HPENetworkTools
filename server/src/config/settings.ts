/**
 * server/src/config/settings.ts — server-side settings store.
 *
 * Settings live at <repo>/data/settings.json (git-ignored), written atomically
 * (tmp + rename) with mode 0600. Override the path with HPE_SETTINGS_PATH
 * (used by the test suite).
 *
 * Shape:
 *   demoMode        — all screen endpoints serve shared fixtures when true
 *   workspaceName   — shown in the shell sidebar / breadcrumbs
 *   pollIntervalSec — per-plane poll cadence (default 60)
 *   connectors      — typed per-product configuration, null = not connected.
 *   planes          — derived flat compatibility view for legacy consumers;
 *                     never a second persisted source of connector truth.
 *   mcp / llm       — optional chat backend configuration
 *   chatWriteMode   — allow brokered writes from the chat surface
 *   tableColumns /  — the web shell's per-table column configs and per-screen
 *   savedViews        saved views: opaque object maps the server does not
 *                     interpret, stored and served so layout and views sync
 *
 * maskedView() returns a deep copy with every secret-ish value (keys matching
 * /secret|token|key|password|passphrase/i) replaced by a fixed mask — no
 * fragment of the real value leaks. update() refuses to write masked values
 * back, so a UI round-trip of the masked view cannot destroy stored secrets.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  CONNECTOR_IDS,
  connectorCatalogEntry,
  maskConnectorConfig,
  migrateLegacyPlaneRecord,
  parseConnectorConfig,
  type ConnectorConfig,
  type ConnectorId,
} from '@hpe/shared';
import { adapterCredentialsFor, type ConnectorRecord } from '../connectors/catalog';
import { PLANE_IDS, type PlaneId } from '../planes/types';
import { SCREEN_SECTIONS, type ScreenSection, type SectionMode } from '@hpe/shared';

export type PlaneCredentials = Record<string, string>;

export interface McpSettings {
  url: string;
  bearerToken: string | null;
}

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const ASSISTANT_PROVIDER_IDS = ['codex', 'claude', 'kimi', 'copilot', 'ollama', 'openrouter'] as const;
export type AssistantProviderId = typeof ASSISTANT_PROVIDER_IDS[number];
export type AssistantChatWriteMode = 'read-only' | 'confirm' | 'enabled';

const httpUrlSchema = z.string().trim().url().refine(
  (value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  },
  'must be an HTTP(S) URL',
);
const modelSchema = z.string().trim().min(1, 'model is required');
const enabledSchema = z.boolean();

export const codexProviderSchema = z.object({
  enabled: enabledSchema,
  model: modelSchema,
  reasoningEffort: z.enum(['low', 'medium', 'high']),
}).strict();
export const claudeProviderSchema = z.object({
  enabled: enabledSchema,
  model: modelSchema,
  reasoningEffort: z.enum(['low', 'medium', 'high']),
}).strict();
export const kimiProviderSchema = z.object({
  enabled: enabledSchema,
  model: modelSchema,
  thinking: z.boolean(),
}).strict();
export const copilotProviderSchema = z.object({
  enabled: enabledSchema,
  model: modelSchema,
  effort: z.enum(['adaptive', 'low', 'medium', 'high']),
}).strict();
export const ollamaProviderSchema = z.object({
  enabled: enabledSchema,
  baseUrl: httpUrlSchema,
  model: modelSchema,
  apiKey: z.string().optional(),
}).strict();
export const openrouterProviderSchema = z.object({
  enabled: enabledSchema,
  baseUrl: httpUrlSchema,
  model: modelSchema,
  apiKey: z.string().optional(),
}).strict();

export const assistantSettingsSchema = z.object({
  activeProvider: z.enum(ASSISTANT_PROVIDER_IDS),
  mcp: z.object({
    enabled: z.boolean(),
    endpoint: httpUrlSchema,
    authToken: z.string().nullable(),
  }).strict(),
  chatWriteMode: z.enum(['read-only', 'confirm', 'enabled']),
  providers: z.object({
    codex: codexProviderSchema,
    claude: claudeProviderSchema,
    kimi: kimiProviderSchema,
    copilot: copilotProviderSchema,
    ollama: ollamaProviderSchema,
    openrouter: openrouterProviderSchema,
  }).strict(),
}).strict();

export type AssistantProviderConfig =
  | z.infer<typeof codexProviderSchema>
  | z.infer<typeof claudeProviderSchema>
  | z.infer<typeof kimiProviderSchema>
  | z.infer<typeof copilotProviderSchema>
  | z.infer<typeof ollamaProviderSchema>
  | z.infer<typeof openrouterProviderSchema>;
export type AssistantSettings = z.infer<typeof assistantSettingsSchema>;

function defaultAssistantSettings(): AssistantSettings {
  return {
    activeProvider: 'ollama',
    mcp: { enabled: false, endpoint: 'http://127.0.0.1:3000/mcp', authToken: null },
    chatWriteMode: 'enabled',
    providers: {
      codex: { enabled: false, model: 'gpt-5.6-terra', reasoningEffort: 'low' },
      claude: { enabled: false, model: 'sonnet', reasoningEffort: 'low' },
      kimi: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false },
      copilot: { enabled: false, model: 'auto', effort: 'adaptive' },
      ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' },
      openrouter: { enabled: false, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
    },
  };
}

function isLocalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.hostname === 'localhost' || url.hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
      : false;
  } catch {
    return false;
  }
}

/**
 * Convert the pre-registry chat settings into their single canonical shape.
 * A complete existing assistant block is authoritative and is never changed
 * by stale legacy fields saved beside it.
 */
export function migrateAssistantSettings(input: unknown): AssistantSettings {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  if (Object.prototype.hasOwnProperty.call(raw, 'assistant')) {
    return assistantSettingsSchema.parse(raw.assistant);
  }

  const assistant = defaultAssistantSettings();
  const legacyMcp = raw.mcp !== null && typeof raw.mcp === 'object' && !Array.isArray(raw.mcp)
    ? raw.mcp as Record<string, unknown>
    : null;
  const endpoint = typeof legacyMcp?.url === 'string' ? legacyMcp.url.trim() : '';
  const authToken = typeof legacyMcp?.bearerToken === 'string' && legacyMcp.bearerToken.trim()
    ? legacyMcp.bearerToken
    : null;
  if (endpoint && httpUrlSchema.safeParse(endpoint).success) {
    assistant.mcp = { enabled: true, endpoint, authToken };
  }

  if (typeof raw.chatWriteMode === 'boolean') {
    assistant.chatWriteMode = raw.chatWriteMode ? 'enabled' : 'read-only';
  }
  const legacyLlm = raw.llm !== null && typeof raw.llm === 'object' && !Array.isArray(raw.llm)
    ? raw.llm as Record<string, unknown>
    : null;
  const baseUrl = typeof legacyLlm?.baseUrl === 'string' ? legacyLlm.baseUrl.trim() : '';
  const model = typeof legacyLlm?.model === 'string' ? legacyLlm.model.trim() : '';
  const apiKey = typeof legacyLlm?.apiKey === 'string' && legacyLlm.apiKey.trim() ? legacyLlm.apiKey : undefined;
  if (baseUrl && httpUrlSchema.safeParse(baseUrl).success && model) {
    const id: 'ollama' | 'openrouter' = isLocalHttpUrl(baseUrl) ? 'ollama' : 'openrouter';
    assistant.activeProvider = id;
    assistant.providers[id] = { enabled: true, baseUrl, model, ...(apiKey ? { apiKey } : {}) };
  }
  return assistantSettingsSchema.parse(assistant);
}

function mergeAssistantSettings(current: AssistantSettings, input: unknown): AssistantSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('assistant must be an object');
  }
  const raw = input as Record<string, unknown>;
  const hasProviders = Object.prototype.hasOwnProperty.call(raw, 'providers');
  if (hasProviders && (raw.providers === null || typeof raw.providers !== 'object' || Array.isArray(raw.providers))) {
    throw new SettingsValidationError('assistant.providers must be an object');
  }
  const providers = hasProviders ? raw.providers as Record<string, unknown> : {};
  for (const id of Object.keys(providers)) {
    if (!(ASSISTANT_PROVIDER_IDS as readonly string[]).includes(id)) {
      throw new SettingsValidationError(`unrecognized assistant provider: ${id}`);
    }
  }
  const mergedProviders: Record<string, unknown> = { ...current.providers };
  for (const id of ASSISTANT_PROVIDER_IDS) {
    if (!Object.prototype.hasOwnProperty.call(providers, id)) continue;
    const incoming = providers[id];
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
      mergedProviders[id] = incoming;
      continue;
    }
    const next = { ...(current.providers[id] as Record<string, unknown>), ...(incoming as Record<string, unknown>) };
    if (next.apiKey === MASK) next.apiKey = (current.providers[id] as { apiKey?: string }).apiKey;
    mergedProviders[id] = next;
  }
  const incomingMcp = raw.mcp === undefined
    ? {}
    : raw.mcp !== null && typeof raw.mcp === 'object' && !Array.isArray(raw.mcp)
      ? raw.mcp as Record<string, unknown>
      : raw.mcp;
  if (incomingMcp === null || typeof incomingMcp !== 'object' || Array.isArray(incomingMcp)) {
    return assistantSettingsSchema.parse({ ...current, ...raw, mcp: incomingMcp, providers: mergedProviders });
  }
  const mcp = { ...current.mcp, ...incomingMcp };
  if (mcp.authToken === MASK) mcp.authToken = current.mcp.authToken;
  return assistantSettingsSchema.parse({
    ...current,
    ...raw,
    mcp,
    providers: mergedProviders,
  });
}

/**
 * Translate an old chat-form update into the canonical registry without
 * treating it as a replacement registry. Legacy MCP and write-mode fields
 * describe shared assistant state; a legacy LLM updates its matching
 * compatible provider but never changes the operator's active selection.
 */
function mergeLegacyAssistantSettings(
  current: AssistantSettings,
  input: Record<string, unknown>,
  legacy: Pick<Settings, 'mcp' | 'llm' | 'chatWriteMode'>,
  previousLegacyLlm: LlmSettings | null,
): AssistantSettings {
  const patch: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(input, 'mcp')) {
    patch.mcp = legacy.mcp
      ? { enabled: true, endpoint: legacy.mcp.url, authToken: legacy.mcp.bearerToken }
      : { enabled: false, authToken: null };
  }
  if (typeof input.chatWriteMode === 'boolean') {
    patch.chatWriteMode = input.chatWriteMode ? 'enabled' : 'read-only';
  }
  if (Object.prototype.hasOwnProperty.call(input, 'llm')) {
    if (legacy.llm) {
      const id: 'ollama' | 'openrouter' = isLocalHttpUrl(legacy.llm.baseUrl) ? 'ollama' : 'openrouter';
      patch.providers = {
        [id]: {
          enabled: true,
          baseUrl: legacy.llm.baseUrl,
          model: legacy.llm.model,
          ...(legacy.llm.apiKey ? { apiKey: legacy.llm.apiKey } : {}),
        },
      };
    } else if (input.llm === null && previousLegacyLlm) {
      const id: 'ollama' | 'openrouter' = isLocalHttpUrl(previousLegacyLlm.baseUrl) ? 'ollama' : 'openrouter';
      patch.providers = { [id]: { enabled: false } };
    }
  }
  return mergeAssistantSettings(current, patch);
}

/**
 * OIDC single sign-on (Authentik, or any compliant provider).
 *
 * `issuer` is the provider's base URL — discovery appends
 * /.well-known/openid-configuration. `redirectUri` must be registered with
 * the provider verbatim; a mismatch is rejected at the provider, not here.
 *
 * `allowedGroups` is an optional additional gate: when non-empty, a verified
 * identity must also carry one of these groups or it is refused. Empty or
 * absent means any identity the provider vouches for may use the portal —
 * which is the right default only when the provider's own application
 * assignment is doing that job.
 */
export interface AuthSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedGroups?: string[];
}

export interface Settings {
  demoMode: boolean;
  /**
   * Blend mode (only meaningful with demoMode on): a demo screen swaps a
   * section to real poller rows as soon as any plane reports them, while
   * sections without live rows stay on fixtures. Off by default.
   */
  blendLive?: boolean;
  /** Per-screen demo/live overrides; a section absent here follows demoMode. */
  sectionMode?: SectionMode;
  /** Fixture device names hidden from the demo inventory (pruned by the operator). */
  hiddenDemoDevices?: string[];
  /**
   * Lab config mode. This estate is a lab used to demonstrate what the portal
   * can do, so writes do not need the brokered-change ceremony. It defaults
   * on; set it explicitly false to retain the hardened ticketed workflow.
   */
  configMode: boolean;
  workspaceName: string;
  pollIntervalSec: number;
  /** Sole persisted connector source of truth. AOS-10 is derived from Central. */
  connectors: ConnectorRecord;
  /** Derived compatibility view for consumers that have not moved to connectors yet. */
  planes: Record<PlaneId, PlaneCredentials | null>;
  /** Canonical provider registry; legacy chat fields below remain read-compatible only. */
  assistant: AssistantSettings;
  mcp: McpSettings | null;
  llm: LlmSettings | null;
  /** OIDC SSO configuration; null = no identity provider configured. */
  auth: AuthSettings | null;
  chatWriteMode: boolean;
  /** UI shell preferences (optional — absent means the client uses its own defaults). */
  density?: 'comfortable' | 'compact';
  inventoryView?: 'Unified table' | 'Platform lanes';
  showPlatformTags?: boolean;
  /** Web-shell per-table column-manager configs, keyed by the screen's table
   *  id. Opaque to the server: validated as an object map, passed through. */
  tableColumns?: Record<string, unknown>;
  /** Web-shell per-screen saved views, keyed by the screen's id. Opaque to
   *  the server: validated as an object map, passed through. */
  savedViews?: Record<string, unknown>;
}

export type SectionSource = 'demo' | 'live';

/** Resolve a section's explicit source before falling back to the portal-wide mode. */
export function effectiveSectionSource(
  value: Pick<Settings, 'demoMode' | 'sectionMode'>,
  section: ScreenSection,
): SectionSource {
  return value.sectionMode?.[section] ?? (value.demoMode ? 'demo' : 'live');
}

export const MASK = '••••••';

/** Is this value the placeholder a masked view round-trips, rather than a secret? */
export function isMasked(value: string): boolean {
  return value.trim() === MASK;
}

function defaultSettings(): Settings {
  const connectors = {} as ConnectorRecord;
  for (const id of CONNECTOR_IDS) connectors[id] = null;
  return {
    demoMode: true,
    configMode: true,
    workspaceName: 'Meridian Health',
    pollIntervalSec: 60,
    connectors,
    planes: derivedPlanes(connectors),
    assistant: defaultAssistantSettings(),
    mcp: null,
    llm: null,
    auth: null,
    chatWriteMode: false,
  };
}

function defaultPath(): string {
  if (process.env.HPE_SETTINGS_PATH) return process.env.HPE_SETTINGS_PATH;
  // server/src/config → repo root is three levels up.
  return path.resolve(__dirname, '..', '..', '..', 'data', 'settings.json');
}

function maskSecret(): string {
  return MASK;
}

function derivedPlanes(connectors: ConnectorRecord): Record<PlaneId, PlaneCredentials | null> {
  const planes = {} as Record<PlaneId, PlaneCredentials | null>;
  for (const id of PLANE_IDS) planes[id] = null;
  for (const id of CONNECTOR_IDS) {
    const config = connectors[id];
    if (!config?.enabled) continue;
    try {
      planes[id] = adapterCredentialsFor(config);
    } catch {
      // Keep the invalid typed record so the registry can expose its precise
      // degraded configuration state. It must never become flat credentials.
      planes[id] = null;
    }
  }
  // AOS-10 is inventory discovered through Central, never independently credentialed.
  planes.aos10 = null;
  return planes;
}

function parseConnectorForStore(id: ConnectorId, input: unknown): ConnectorConfig {
  try {
    return parseConnectorConfig(id, input) as ConnectorConfig;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const raw = input as Record<string, unknown> | null;
    const endpoint = raw && typeof raw.endpoint === 'string' ? raw.endpoint : null;
    // A syntactically complete connector with an unsafe public HTTP endpoint
    // remains typed but invalid, so the registry can contain it as a degraded
    // configuration error. It is never converted to adapter credentials.
    if (!endpoint || !why.includes('endpoint must use HTTPS')) throw err;
    const validated = parseConnectorConfig(id, {
      ...raw,
      endpoint: endpoint.replace(/^http:/i, 'https:'),
    }) as ConnectorConfig;
    return { ...validated, endpoint } as ConnectorConfig;
  }
}

function migrateLegacyForStore(
  id: ConnectorId,
  legacy: Record<string, string>,
): ConnectorConfig | null {
  const normalized = { ...legacy };
  // ClearPass has no safe implicit target: a token without publisher/host is
  // incomplete compatibility input, not authority to dial the catalog's UI
  // hint. Keep it unlinked until the operator supplies the endpoint.
  if (id === 'clearpass' && ![normalized.publisher, normalized.host, normalized.baseUrl].some((v) => v?.trim())) {
    return null;
  }
  if (normalized.scopes !== undefined) {
    const entry = connectorCatalogEntry(id);
    const allowed = new Set(entry.scopeOptions.map((scope) => scope.value));
    const requested = normalized.scopes.split(/[\s,]+/).filter(Boolean);
    const scopes = new Set<string>();
    for (const scope of requested) {
      if (allowed.has(scope)) scopes.add(scope);
      else if (scope === 'read' && allowed.has('read:inventory')) scopes.add('read:inventory');
      else if (scope.includes('write')) {
        if (allowed.has('write:brokered')) scopes.add('write:brokered');
        else if (allowed.has('write:direct')) scopes.add('write:direct');
      }
    }
    normalized.scopes = [...scopes].join(',');
  }
  const endpointKeys = ['gatewayBaseUrl', 'apiHost', 'baseUrl', 'publisher', 'host', 'master'];
  for (const key of endpointKeys) {
    const value = normalized[key];
    if (!value || !/^https?:\/\//i.test(value)) continue;
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) {
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        normalized[key] = url.toString().replace(/\/$/, '');
      }
    } catch {
      // Shared parsing below reports the useful validation error.
    }
  }
  try {
    return migrateLegacyPlaneRecord(id, normalized);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (!why.includes('endpoint must use HTTPS')) throw err;
    const endpointKey = endpointKeys.find((key) => /^http:/i.test(normalized[key] ?? ''));
    if (!endpointKey) throw err;
    const endpoint = normalized[endpointKey]!;
    const migrated = migrateLegacyPlaneRecord(id, {
      ...normalized,
      [endpointKey]: endpoint.replace(/^http:/i, 'https:'),
    });
    return migrated ? ({ ...migrated, endpoint } as ConnectorConfig) : null;
  }
}

function mergeTypedConnector(
  id: ConnectorId,
  current: ConnectorConfig | null,
  input: unknown,
): ConnectorConfig | null {
  if (input === null) return null;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${id} connector must be an object or null`);
  }
  const raw = input as Record<string, unknown>;
  const currentAuth = current?.auth as unknown as Record<string, unknown> | undefined;
  const incomingAuth = raw.auth;
  let auth: unknown = incomingAuth ?? currentAuth;
  if (incomingAuth !== null && typeof incomingAuth === 'object' && !Array.isArray(incomingAuth)) {
    const incomingRecord = incomingAuth as Record<string, unknown>;
    const incomingKind = typeof incomingRecord.kind === 'string' ? incomingRecord.kind : undefined;
    const sameKind = incomingKind === undefined || incomingKind === currentAuth?.kind;
    const mergedAuth: Record<string, unknown> = {
      ...(sameKind ? (currentAuth ?? {}) : {}),
      ...incomingRecord,
    };
    for (const [key, value] of Object.entries(mergedAuth)) {
      if (typeof value !== 'string' || !value.startsWith(MASK)) continue;
      const stored = sameKind ? currentAuth?.[key] : undefined;
      if (typeof stored !== 'string' || stored.length === 0) {
        throw new Error(`masked ${id} auth.${key} has no stored value to preserve`);
      }
      mergedAuth[key] = stored;
    }
    auth = mergedAuth;
  }
  return parseConnectorForStore(id, {
    ...(current ?? {}),
    ...raw,
    id,
    auth,
  });
}

/** Keep only string-valued entries from an untrusted credential record. */
function sanitizeCreds(input: unknown): PlaneCredentials | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: PlaneCredentials = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Raised when a write would contradict configuration the environment owns.
 * Distinct from a validation error: the value may be perfectly valid, it is
 * the *source* that makes accepting it a lie.
 */
export class SettingsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsConflictError';
  }
}

/** Invalid persisted assistant input. Kept distinct from environmental conflicts. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

/** Do two identity-provider blocks say the same thing? */
function sameAuth(a: AuthSettings | null, b: AuthSettings | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.issuer === b.issuer &&
    a.clientId === b.clientId &&
    a.clientSecret === b.clientSecret &&
    a.redirectUri === b.redirectUri &&
    (a.allowedGroups ?? []).join(',') === (b.allowedGroups ?? []).join(',')
  );
}

export class SettingsStore {
  private current: Settings | null = null;

  /**
   * The identity-provider block the environment supplied, and the one that
   * belongs on disk.
   *
   * These exist because `save()` serialises `current` wholesale, and
   * `overlayEnvAuth` puts the environment's client secret *into* `current` so
   * the running process can use it. Without somewhere to remember what the
   * file actually said, the next unrelated write — saving plane credentials,
   * toggling demo mode — would copy that secret into the file the operator
   * deliberately kept it out of. Keeping the two apart is what makes rule 2
   * on `overlayEnvAuth` true rather than merely stated.
   */
  private envAuth: AuthSettings | null = null;
  private fileAuth: AuthSettings | null = null;

  constructor(private readonly filePath: string = defaultPath()) {}

  /** Read from disk (merging over defaults); writes defaults on first run. */
  load(): Settings {
    if (!fs.existsSync(this.filePath)) {
      this.current = defaultSettings();
      this.save();
      return this.current;
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`settings file ${this.filePath} is not valid JSON: ${(err as Error).message}`);
    }
    // Migrate before default merging so a saved legacy LLM is not obscured by
    // the new assistant defaults. The legacy fields remain on disk solely for
    // the old chat surface until its later adapter migration.
    this.current = this.merged(defaultSettings(), parsed, false);
    this.current.assistant = migrateAssistantSettings(parsed);
    return this.current;
  }

  get(): Settings {
    return this.current ?? this.load();
  }

  /**
   * Apply a partial update. Plane credentials are deep-merged per plane
   * (pass null for a plane to clear it); scalars replace. Masked values
   * ('••••••…') are ignored so a round-tripped masked view is a no-op.
   */
  update(partial: unknown): Settings {
    const previous = this.get();
    const next = this.merged(previous, partial, true);
    // The environment overlay is the source of truth for auth while it is in
    // force. Silently accepting a change here would leave the API reporting
    // one identity provider and the login flow using another, so refuse and
    // say why instead.
    if (this.envAuth && !sameAuth(next.auth ?? null, this.envAuth)) {
      throw new SettingsConflictError(
        'the identity provider is configured through the environment; ' +
          'change HPE_OIDC_* and restart rather than saving it here',
      );
    }
    this.current = next;
    try {
      this.save();
    } catch (err) {
      this.current = previous;
      throw err;
    }
    return next;
  }

  /**
   * Overlay identity-provider configuration supplied through the environment.
   *
   * settings.json is the primary home for this, but a deployment that keeps
   * secrets out of files on disk needs somewhere else to put the client
   * secret. The environment is the conventional answer, so it is supported —
   * with two rules that keep a second source of truth from becoming a second
   * *disagreement*:
   *
   *   1. It is all-or-nothing. A half-filled set (issuer but no client id) is
   *      an error, not a partial overlay silently merged with the file. A
   *      typo'd variable name must not quietly fall back to file config the
   *      operator thought they had replaced.
   *   2. It is in-memory only and never saved. Writing it back would copy the
   *      secret into the file the operator was deliberately keeping it out of.
   *
   * Returns the overlay applied, or null when the environment says nothing.
   */
  overlayEnvAuth(env: NodeJS.ProcessEnv = process.env): AuthSettings | null {
    const issuer = env.HPE_OIDC_ISSUER?.trim();
    const clientId = env.HPE_OIDC_CLIENT_ID?.trim();
    const clientSecret = env.HPE_OIDC_CLIENT_SECRET?.trim();
    const redirectUri = env.HPE_OIDC_REDIRECT_URI?.trim();
    const present = [issuer, clientId, clientSecret, redirectUri].filter(Boolean).length;
    if (present === 0) return null;
    if (present < 4) {
      throw new Error(
        'incomplete OIDC environment configuration: HPE_OIDC_ISSUER, HPE_OIDC_CLIENT_ID, ' +
          'HPE_OIDC_CLIENT_SECRET and HPE_OIDC_REDIRECT_URI must all be set together, or none of them',
      );
    }
    const groups = (env.HPE_OIDC_ALLOWED_GROUPS ?? '')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
    const auth: AuthSettings = {
      issuer: issuer!,
      clientId: clientId!,
      clientSecret: clientSecret!,
      redirectUri: redirectUri!,
      ...(groups.length ? { allowedGroups: groups } : {}),
    };
    this.fileAuth = this.get().auth ?? null;
    this.envAuth = auth;
    this.current = { ...this.get(), auth };
    return auth;
  }

  /** Where the identity-provider configuration in force actually came from. */
  authSource(): 'environment' | 'settings' | 'none' {
    if (this.envAuth) return 'environment';
    return this.get().auth ? 'settings' : 'none';
  }

  /** Settings as safe to send over the API — every secret masked. */
  maskedView(): Settings {
    const s = this.get();
    const connectors = {} as ConnectorRecord;
    for (const id of CONNECTOR_IDS) {
      const config = s.connectors[id];
      connectors[id] = config ? maskConnectorConfig(config) : null;
    }
    const planes = derivedPlanes(connectors);
    return {
      ...s,
      connectors,
      planes,
      assistant: {
        ...s.assistant,
        mcp: {
          ...s.assistant.mcp,
          authToken: s.assistant.mcp.authToken ? maskSecret() : null,
        },
        providers: {
          ...s.assistant.providers,
          ollama: s.assistant.providers.ollama.apiKey
            ? { ...s.assistant.providers.ollama, apiKey: maskSecret() }
            : { ...s.assistant.providers.ollama },
          openrouter: s.assistant.providers.openrouter.apiKey
            ? { ...s.assistant.providers.openrouter, apiKey: maskSecret() }
            : { ...s.assistant.providers.openrouter },
        },
      },
      mcp: s.mcp
        ? { ...s.mcp, bearerToken: s.mcp.bearerToken ? maskSecret() : null }
        : null,
      llm: s.llm ? { ...s.llm, apiKey: maskSecret() } : null,
      auth: s.auth ? { ...s.auth, clientSecret: s.auth.clientSecret ? maskSecret() : '' } : null,
    };
  }

  // -- internals -------------------------------------------------------------

  /** Merge untrusted input over a base, keeping only known, well-typed keys. */
  private merged(base: Settings, input: unknown, translateLegacyUpdates: boolean): Settings {
    const out: Settings = {
      ...base,
      connectors: { ...base.connectors },
      planes: derivedPlanes(base.connectors),
      assistant: base.assistant,
      mcp: base.mcp ? { ...base.mcp } : null,
      llm: base.llm ? { ...base.llm } : null,
      auth: base.auth ? { ...base.auth } : null,
    };
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return out;
    const p = input as Record<string, unknown>;

    if (typeof p.demoMode === 'boolean') out.demoMode = p.demoMode;
    if (typeof p.blendLive === 'boolean') out.blendLive = p.blendLive;
    if (p.sectionMode !== null && typeof p.sectionMode === 'object' && !Array.isArray(p.sectionMode)) {
      const sm: SectionMode = {};
      for (const [k, v] of Object.entries(p.sectionMode as Record<string, unknown>)) {
        if ((SCREEN_SECTIONS as readonly string[]).includes(k) && (v === 'demo' || v === 'live')) {
          sm[k as ScreenSection] = v;
        }
      }
      out.sectionMode = sm;
    }
    if (Array.isArray(p.hiddenDemoDevices)) {
      out.hiddenDemoDevices = [
        ...new Set(
          p.hiddenDemoDevices
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .map((v) => v.trim()),
        ),
      ];
    }
    if (typeof p.workspaceName === 'string' && p.workspaceName.trim().length > 0) {
      out.workspaceName = p.workspaceName.trim();
    }
    if (typeof p.pollIntervalSec === 'number' && Number.isFinite(p.pollIntervalSec) && p.pollIntervalSec >= 5) {
      out.pollIntervalSec = Math.floor(p.pollIntervalSec);
    }
    if (typeof p.chatWriteMode === 'boolean') out.chatWriteMode = p.chatWriteMode;
    if (typeof p.configMode === 'boolean') out.configMode = p.configMode;
    if (p.density === 'comfortable' || p.density === 'compact') out.density = p.density;
    if (p.inventoryView === 'Unified table' || p.inventoryView === 'Platform lanes') {
      out.inventoryView = p.inventoryView;
    }
    if (typeof p.showPlatformTags === 'boolean') out.showPlatformTags = p.showPlatformTags;
    /* The web shell's table column configs and saved views: opaque maps the
       server does not interpret — validate the shape and pass them through
       (whole-map replace; the client always sends its full map). */
    if (p.tableColumns !== null && typeof p.tableColumns === 'object' && !Array.isArray(p.tableColumns)) {
      out.tableColumns = { ...(p.tableColumns as Record<string, unknown>) };
    }
    if (p.savedViews !== null && typeof p.savedViews === 'object' && !Array.isArray(p.savedViews)) {
      out.savedViews = { ...(p.savedViews as Record<string, unknown>) };
    }

    const typedIds = new Set<ConnectorId>();
    if (p.connectors !== null && typeof p.connectors === 'object' && !Array.isArray(p.connectors)) {
      for (const [id, value] of Object.entries(p.connectors as Record<string, unknown>)) {
        if (!(CONNECTOR_IDS as readonly string[]).includes(id)) continue;
        const connectorId = id as ConnectorId;
        typedIds.add(connectorId);
        out.connectors[connectorId] = mergeTypedConnector(connectorId, out.connectors[connectorId], value);
      }
    }

    if (p.planes !== null && typeof p.planes === 'object' && !Array.isArray(p.planes)) {
      for (const [id, value] of Object.entries(p.planes as Record<string, unknown>)) {
        if (!(CONNECTOR_IDS as readonly string[]).includes(id)) continue;
        const connectorId = id as ConnectorId;
        if (typedIds.has(connectorId)) continue;
        // On file load, a typed record always wins over the stale compatibility
        // record saved beside it. During the transition, a legacy API update is
        // translated one-way into the typed record and immediately re-derived.
        if (!translateLegacyUpdates && out.connectors[connectorId]) continue;
        if (value === null) {
          if (translateLegacyUpdates) out.connectors[connectorId] = null;
          continue;
        }
        const incoming = sanitizeCreds(value);
        if (!incoming) continue;
        const currentCreds = out.connectors[connectorId]
          ? adapterCredentialsFor(out.connectors[connectorId]!)
          : null;
        const mergedCreds: PlaneCredentials = { ...(currentCreds ?? {}) };
        for (const [k, v] of Object.entries(incoming)) {
          if (v.startsWith(MASK)) continue; // masked write-back — keep stored secret
          mergedCreds[k] = v;
        }
        const migrated = migrateLegacyForStore(connectorId, mergedCreds);
        if (migrated) out.connectors[connectorId] = migrated;
      }
    }

    out.planes = derivedPlanes(out.connectors);

    if ('mcp' in p) {
      if (p.mcp === null) {
        out.mcp = null;
      } else if (p.mcp !== null && typeof p.mcp === 'object') {
        const m = p.mcp as Record<string, unknown>;
        const url = typeof m.url === 'string' ? m.url : out.mcp?.url;
        if (url !== undefined) {
          const incomingToken = m.bearerToken;
          const token =
            incomingToken === null
              ? null
              : typeof incomingToken === 'string'
                ? incomingToken.startsWith(MASK)
                  ? (out.mcp?.bearerToken ?? null)
                  : incomingToken
                : (out.mcp?.bearerToken ?? null);
          out.mcp = {
            url,
            bearerToken: token,
          };
        }
      }
    }

    if ('llm' in p) {
      if (p.llm === null) {
        out.llm = null;
      } else if (p.llm !== null && typeof p.llm === 'object') {
        const l = p.llm as Record<string, unknown>;
        const baseUrl = typeof l.baseUrl === 'string' ? l.baseUrl : out.llm?.baseUrl;
        const model = typeof l.model === 'string' ? l.model : out.llm?.model;
        if (baseUrl !== undefined && model !== undefined) {
          const incomingKey = l.apiKey;
          const key =
            typeof incomingKey === 'string'
              ? incomingKey.startsWith(MASK)
                ? (out.llm?.apiKey ?? '')
                : incomingKey
              : (out.llm?.apiKey ?? '');
          out.llm = {
            baseUrl,
            model,
            apiKey: key,
          };
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(p, 'assistant')) {
      out.assistant = mergeAssistantSettings(base.assistant, p.assistant);
    } else if (
      Object.prototype.hasOwnProperty.call(p, 'mcp') ||
      Object.prototype.hasOwnProperty.call(p, 'llm') ||
      Object.prototype.hasOwnProperty.call(p, 'chatWriteMode')
    ) {
      // Old forms still update the compatible legacy fields, but those fields
      // are not a replacement source for a registry the operator already
      // configured. Patch only their canonical counterparts instead.
      out.assistant = mergeLegacyAssistantSettings(base.assistant, p, out, base.llm);
    }

    if ('auth' in p) {
      if (p.auth === null) {
        out.auth = null;
      } else if (typeof p.auth === 'object' && !Array.isArray(p.auth)) {
        const a = p.auth as Record<string, unknown>;
        const issuer = typeof a.issuer === 'string' ? a.issuer.trim() : out.auth?.issuer;
        const clientId = typeof a.clientId === 'string' ? a.clientId.trim() : out.auth?.clientId;
        const redirectUri =
          typeof a.redirectUri === 'string' ? a.redirectUri.trim() : out.auth?.redirectUri;
        // A masked write-back must keep the stored secret, exactly as plane
        // credentials do — otherwise loading the settings screen and saving it
        // would silently break login.
        const incomingSecret = a.clientSecret;
        const clientSecret =
          typeof incomingSecret === 'string' && !incomingSecret.startsWith(MASK)
            ? incomingSecret
            : (out.auth?.clientSecret ?? '');
        const groups = Array.isArray(a.allowedGroups)
          ? a.allowedGroups.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map((g) => g.trim())
          : out.auth?.allowedGroups;
        if (issuer && clientId && redirectUri) {
          out.auth = { issuer, clientId, clientSecret, redirectUri, ...(groups ? { allowedGroups: groups } : {}) };
        }
      }
    }

    return out;
  }

  /** Atomic write: tmp file + rename, mode 0600 throughout. */
  private save(): void {
    // Never persist an identity provider the environment supplied. `current`
    // holds it so the running process can serve logins; the file must keep
    // saying whatever it said before the overlay was applied.
    const persisted = this.envAuth ? { ...this.current, auth: this.fileAuth } : this.current;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // in case tmp already existed with looser mode
    fs.renameSync(tmp, this.filePath);
  }
}

/** Process-wide singleton. */
export const settings = new SettingsStore();
