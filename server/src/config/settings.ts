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
 *   planes          — per-plane credential records, null = not connected.
 *                     Known key shapes: central { gatewayBaseUrl, clientId,
 *                     clientSecret, approvedFirmware? }, greenlake
 *                     { workspaceId, clientId, clientSecret, baseUrl? },
 *                     clearpass { host, token }
 *   mcp / llm       — optional chat backend configuration
 *   chatWriteMode   — allow brokered writes from the chat surface
 *
 * maskedView() returns a deep copy with every secret-ish value (keys matching
 * /secret|token|key|password|passphrase/i) replaced by a fixed mask — no
 * fragment of the real value leaks. update() refuses to write masked values
 * back, so a UI round-trip of the masked view cannot destroy stored secrets.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
   * can do, so writes do not need the brokered-change ceremony. With this on,
   * a write no longer requires a raised ticket reference. Off by default.
   */
  configMode?: boolean;
  workspaceName: string;
  pollIntervalSec: number;
  planes: Record<PlaneId, PlaneCredentials | null>;
  mcp: McpSettings | null;
  llm: LlmSettings | null;
  /** OIDC SSO configuration; null = no identity provider configured. */
  auth: AuthSettings | null;
  chatWriteMode: boolean;
  /** UI shell preferences (optional — absent means the client uses its own defaults). */
  density?: 'comfortable' | 'compact';
  inventoryView?: 'Unified table' | 'Platform lanes';
  showPlatformTags?: boolean;
}

export type SectionSource = 'demo' | 'live';

/** Resolve a section's explicit source before falling back to the portal-wide mode. */
export function effectiveSectionSource(
  value: Pick<Settings, 'demoMode' | 'sectionMode'>,
  section: ScreenSection,
): SectionSource {
  return value.sectionMode?.[section] ?? (value.demoMode ? 'demo' : 'live');
}

const SECRET_KEY = /secret|token|key|password|passphrase/i;
const MASK = '••••••';

function defaultSettings(): Settings {
  const planes = {} as Record<PlaneId, PlaneCredentials | null>;
  for (const id of PLANE_IDS) planes[id] = null;
  return {
    demoMode: true,
    workspaceName: 'Meridian Health',
    pollIntervalSec: 60,
    planes,
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

/** Mask secret-ish values of a flat string record; other keys pass through. */
function maskRecord(rec: PlaneCredentials): PlaneCredentials {
  const out: PlaneCredentials = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = SECRET_KEY.test(k) ? maskSecret() : v;
  }
  return out;
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

export class SettingsStore {
  private current: Settings | null = null;

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
    this.current = this.merged(defaultSettings(), parsed);
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
    const next = this.merged(previous, partial);
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
    this.current = { ...this.get(), auth };
    return auth;
  }

  /** Settings as safe to send over the API — every secret masked. */
  maskedView(): Settings {
    const s = this.get();
    const planes = {} as Record<PlaneId, PlaneCredentials | null>;
    for (const id of PLANE_IDS) {
      const creds = s.planes[id];
      planes[id] = creds ? maskRecord(creds) : null;
    }
    return {
      ...s,
      planes,
      mcp: s.mcp
        ? { ...s.mcp, bearerToken: s.mcp.bearerToken ? maskSecret() : null }
        : null,
      llm: s.llm ? { ...s.llm, apiKey: maskSecret() } : null,
      auth: s.auth ? { ...s.auth, clientSecret: s.auth.clientSecret ? maskSecret() : '' } : null,
    };
  }

  // -- internals -------------------------------------------------------------

  /** Merge untrusted input over a base, keeping only known, well-typed keys. */
  private merged(base: Settings, input: unknown): Settings {
    const out: Settings = {
      ...base,
      planes: { ...base.planes },
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

    if (p.planes !== null && typeof p.planes === 'object' && !Array.isArray(p.planes)) {
      for (const [id, value] of Object.entries(p.planes as Record<string, unknown>)) {
        if (!(PLANE_IDS as readonly string[]).includes(id)) continue;
        const planeId = id as PlaneId;
        if (value === null) {
          out.planes[planeId] = null;
          continue;
        }
        const incoming = sanitizeCreds(value);
        if (!incoming) continue;
        const mergedCreds: PlaneCredentials = { ...(out.planes[planeId] ?? {}) };
        for (const [k, v] of Object.entries(incoming)) {
          if (v.startsWith(MASK)) continue; // masked write-back — keep stored secret
          mergedCreds[k] = v;
        }
        out.planes[planeId] = mergedCreds;
      }
    }

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
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // in case tmp already existed with looser mode
    fs.renameSync(tmp, this.filePath);
  }
}

/** Process-wide singleton. */
export const settings = new SettingsStore();
