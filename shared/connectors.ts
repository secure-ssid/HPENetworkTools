import type {
  ConnectField,
  PlaneDatasetKey,
  SelectOption,
  SystemTypeKey,
  Tone,
} from './types';

export const CONNECTOR_IDS = [
  'central',
  'classic',
  'mist',
  'greenlake',
  'clearpass',
  'uxi',
  'aos8',
  'local',
  'sse',
  'edgeconnect',
  'opsramp',
] as const satisfies readonly SystemTypeKey[];

export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export type ConnectorAuthKind =
  | 'oauth_client_credentials'
  | 'token'
  | 'api_key'
  | 'username_password'
  | 'ssh';

export interface OAuthClientCredentialsAuth {
  kind: 'oauth_client_credentials';
  clientId: string;
  clientSecret: string;
  workspaceId?: string;
  tenantId?: string;
  coaEnforcementProfile?: string;
}

export interface TokenAuth {
  kind: 'token';
  token: string;
  orgId?: string;
  coaEnforcementProfile?: string;
}

export interface ApiKeyAuth {
  kind: 'api_key';
  apiKey: string;
}

export interface UsernamePasswordAuth {
  kind: 'username_password';
  username: string;
  password: string;
}

export interface SshCredentialsAuth {
  kind: 'ssh';
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  port?: number;
}

export type ConnectorAuth =
  | OAuthClientCredentialsAuth
  | TokenAuth
  | ApiKeyAuth
  | UsernamePasswordAuth
  | SshCredentialsAuth;

interface ConnectorConfigBase<I extends ConnectorId, A extends ConnectorAuth> {
  id: I;
  enabled: boolean;
  endpoint: string;
  auth: A;
  verifyTls: boolean;
  pollIntervalSec: number;
  callBudget: number | null;
  datasets: PlaneDatasetKey[];
  scopes: string[];
  /** Legacy adapter policy that is still consumed while settings migrate. */
  approvedFirmware?: string;
}

export type CentralConnectorConfig = ConnectorConfigBase<'central', OAuthClientCredentialsAuth>;
export type ClassicConnectorConfig = ConnectorConfigBase<'classic', OAuthClientCredentialsAuth>;
export type MistConnectorConfig = ConnectorConfigBase<'mist', TokenAuth & { orgId: string }>;
export type GreenLakeConnectorConfig = ConnectorConfigBase<
  'greenlake',
  OAuthClientCredentialsAuth & { workspaceId: string }
>;
export type ClearPassConnectorConfig = ConnectorConfigBase<
  'clearpass',
  OAuthClientCredentialsAuth | TokenAuth
>;
export type UxiConnectorConfig = ConnectorConfigBase<'uxi', OAuthClientCredentialsAuth>;
export type Aos8ConnectorConfig = ConnectorConfigBase<'aos8', UsernamePasswordAuth>;
export type LocalConnectorConfig = ConnectorConfigBase<'local', SshCredentialsAuth>;
export type SseConnectorConfig = ConnectorConfigBase<'sse', TokenAuth>;
export type EdgeConnectConnectorConfig = ConnectorConfigBase<
  'edgeconnect',
  ApiKeyAuth | UsernamePasswordAuth
>;
export type OpsRampConnectorConfig = ConnectorConfigBase<
  'opsramp',
  OAuthClientCredentialsAuth & { tenantId: string }
>;

export type ConnectorConfig =
  | CentralConnectorConfig
  | ClassicConnectorConfig
  | MistConnectorConfig
  | GreenLakeConnectorConfig
  | ClearPassConnectorConfig
  | UxiConnectorConfig
  | Aos8ConnectorConfig
  | LocalConnectorConfig
  | SseConnectorConfig
  | EdgeConnectConnectorConfig
  | OpsRampConnectorConfig;

export type ConnectorWriteCapability =
  | 'brokered_configuration'
  | 'direct_ssid'
  | 'direct_greenlake_objects'
  | 'direct_clearpass_objects'
  | 'direct_sse_objects'
  | 'active_diagnostics'
  | 'recorded_ssh';

export interface ConnectorAuthField {
  key:
    | 'clientId'
    | 'clientSecret'
    | 'workspaceId'
    | 'tenantId'
    | 'token'
    | 'orgId'
    | 'coaEnforcementProfile'
    | 'apiKey'
    | 'username'
    | 'password'
    | 'privateKey'
    | 'passphrase'
    | 'port';
  label: string;
  help: string;
  type: 'string' | 'number';
  required: boolean;
  secret?: boolean;
}

export interface ConnectorAuthOption {
  kind: ConnectorAuthKind;
  label: string;
  fields: readonly ConnectorAuthField[];
}

export interface ConnectorEndpointMetadata {
  label: string;
  help: string;
  hint: string;
  default: string;
  options?: readonly SelectOption[];
}

export interface ConnectorScopeOption {
  value: string;
  label: string;
  help: string;
}

export interface ConnectorCatalogEntry {
  id: ConnectorId;
  label: string;
  tone: Tone;
  endpoint: ConnectorEndpointMetadata;
  auth: readonly ConnectorAuthOption[];
  supportedDatasets: readonly PlaneDatasetKey[];
  scopeOptions: readonly ConnectorScopeOption[];
  contributesClients: boolean;
  writeCapabilities: readonly ConnectorWriteCapability[];
  defaultPollIntervalSec: number;
  defaultCallBudget: number | null;
  /** Exact flat-record shape used by the current drawer during migration. */
  legacy: {
    endpointKey: string;
    hideClientCredentials: boolean;
    fields: readonly ConnectField[];
    /** Current flat drawer semantics while its payload is still untyped. */
    endpoint?: Omit<ConnectorEndpointMetadata, 'default' | 'options'>;
  };
}

const MIST_ENDPOINT_OPTIONS: readonly SelectOption[] = [
  { value: 'api.mist.com', label: 'Global (US) — api.mist.com' },
  { value: 'api.eu.mist.com', label: 'Europe — api.eu.mist.com' },
  { value: 'api.gc1.mist.com', label: 'Global 01 — api.gc1.mist.com' },
  { value: 'api.gc2.mist.com', label: 'Global 02 — api.gc2.mist.com' },
  { value: 'api.gc3.mist.com', label: 'Global 03 — api.gc3.mist.com' },
  { value: 'api.gc4.mist.com', label: 'Global 04 — api.gc4.mist.com' },
  { value: 'api.gc5.mist.com', label: 'Global 05 — api.gc5.mist.com' },
  { value: 'api.gc7.mist.com', label: 'Global 07 — api.gc7.mist.com' },
  { value: 'api.ac2.mist.com', label: 'APAC 02 — api.ac2.mist.com' },
  { value: 'api.ac5.mist.com', label: 'APAC 05 — api.ac5.mist.com' },
  { value: 'api.ac6.mist.com', label: 'APAC 06 — api.ac6.mist.com' },
];

const CENTRAL_ENDPOINT_OPTIONS: readonly SelectOption[] = [
  { value: 'https://us1.api.central.arubanetworks.com', label: 'US-1 (us1)' },
  { value: 'https://us2.api.central.arubanetworks.com', label: 'US-2 (us2)' },
  { value: 'https://us4.api.central.arubanetworks.com', label: 'US-WEST-4 (us4)' },
  { value: 'https://us5.api.central.arubanetworks.com', label: 'US-WEST-5 (us5)' },
  { value: 'https://us6.api.central.arubanetworks.com', label: 'US-East1 (us6)' },
  { value: 'https://ca1.api.central.arubanetworks.com', label: 'Canada-1 (ca1)' },
  { value: 'https://de1.api.central.arubanetworks.com', label: 'EU-1 / Germany (de1)' },
  { value: 'https://de2.api.central.arubanetworks.com', label: 'EU-Central2 (de2)' },
  { value: 'https://de3.api.central.arubanetworks.com', label: 'EU-Central3 (de3)' },
  { value: 'https://gb1.api.central.arubanetworks.com', label: 'UK (gb1)' },
  { value: 'https://in1.api.central.arubanetworks.com', label: 'APAC-1 / India (in1)' },
  { value: 'https://jp1.api.central.arubanetworks.com', label: 'APAC-EAST1 / Japan (jp1)' },
  { value: 'https://au1.api.central.arubanetworks.com', label: 'APAC-SOUTH1 / Australia (au1)' },
  { value: 'https://ae1.api.central.arubanetworks.com', label: 'UAE (ae1)' },
  { value: 'https://cn1.api.central.arubanetworks.com.cn', label: 'China (cn1)' },
  { value: 'https://internal.api.central.arubanetworks.com', label: 'Internal / Lab' },
];

const CLIENT_ID: ConnectorAuthField = {
  key: 'clientId', label: 'Client ID', help: 'OAuth client identifier.', type: 'string', required: true,
};
const CLIENT_SECRET: ConnectorAuthField = {
  key: 'clientSecret', label: 'Client secret', help: 'OAuth client secret.', type: 'string', required: true, secret: true,
};
const USERNAME: ConnectorAuthField = {
  key: 'username', label: 'Username', help: 'Read-only management account.', type: 'string', required: true,
};
const PASSWORD: ConnectorAuthField = {
  key: 'password', label: 'Password', help: 'Password for the management account.', type: 'string', required: true, secret: true,
};

const oauth = (...extra: ConnectorAuthField[]): ConnectorAuthOption => ({
  kind: 'oauth_client_credentials',
  label: 'OAuth client credentials',
  fields: [CLIENT_ID, CLIENT_SECRET, ...extra],
});
const userPassword = (): ConnectorAuthOption => ({
  kind: 'username_password', label: 'Username and password', fields: [USERNAME, PASSWORD],
});

const READ_INVENTORY: ConnectorScopeOption = {
  value: 'read:inventory', label: 'Inventory', help: 'Read product inventory.',
};
const READ_CLIENTS: ConnectorScopeOption = {
  value: 'read:clients-auth', label: 'Clients and authentication', help: 'Read clients or authentication observations.',
};
const READ_CONFIG: ConnectorScopeOption = {
  value: 'read:config-licences', label: 'Configuration and licences', help: 'Read supported configuration or licence datasets.',
};
const WRITE_BROKERED: ConnectorScopeOption = {
  value: 'write:brokered', label: 'Brokered configuration', help: 'Push only through the reviewed broker workflow.',
};
const WRITE_DIRECT: ConnectorScopeOption = {
  value: 'write:direct', label: 'Reviewed direct write', help: 'Use only the product-specific reviewed write API.',
};
const SSH_RECORDED: ConnectorScopeOption = {
  value: 'ssh:recorded', label: 'Recorded SSH', help: 'Permit the recorded shell path for this on-prem product.',
};

const READ_SCOPES = [READ_INVENTORY, READ_CLIENTS, READ_CONFIG] as const;

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: 'central', label: 'HPE Aruba Central (new)', tone: 'accent',
    endpoint: {
      label: 'Central region / base URL',
      help: 'Pick a region or type a custom gateway hostname. Tokens are minted by HPE GreenLake SSO.',
      hint: 'us4.api.central.arubanetworks.com',
      default: 'https://us4.api.central.arubanetworks.com',
      options: CENTRAL_ENDPOINT_OPTIONS,
    },
    auth: [oauth()],
    supportedDatasets: ['devices', 'sites', 'clients', 'alerts', 'config'],
    scopeOptions: [...READ_SCOPES, WRITE_BROKERED, WRITE_DIRECT],
    contributesClients: true,
    writeCapabilities: ['brokered_configuration', 'direct_ssid', 'active_diagnostics'],
    defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: { endpointKey: 'gatewayBaseUrl', hideClientCredentials: false, fields: [] },
  },
  {
    id: 'classic', label: 'Central Classic (legacy)', tone: 'warning',
    endpoint: {
      label: 'Classic tenant URL', help: 'Legacy tenant; expect a low rate limit.',
      hint: 'eu-central.classic.arubanetworks.com', default: 'https://eu-central.classic.arubanetworks.com',
    },
    auth: [oauth()],
    supportedDatasets: ['devices', 'sites', 'clients', 'alerts'],
    scopeOptions: READ_SCOPES,
    contributesClients: true, writeCapabilities: [], defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: { endpointKey: 'gatewayBaseUrl', hideClientCredentials: false, fields: [] },
  },
  {
    id: 'mist', label: 'Mist', tone: 'info',
    endpoint: {
      label: 'Mist cloud region', help: 'Pick the cloud your Mist org is on, or enter a custom host.',
      hint: 'api.mist.com', default: 'https://api.mist.com', options: MIST_ENDPOINT_OPTIONS,
    },
    auth: [{
      kind: 'token', label: 'Organisation API token', fields: [
        { key: 'orgId', label: 'Org ID', help: 'Mist organisation UUID.', type: 'string', required: true },
        { key: 'token', label: 'API token', help: 'Org API token.', type: 'string', required: true, secret: true },
      ],
    }],
    supportedDatasets: ['devices', 'sites', 'clients', 'alerts', 'config', 'mistSle', 'mistLicenseUsages', 'mistApStats', 'mistMaps', 'mistRogues'],
    scopeOptions: [...READ_SCOPES, WRITE_DIRECT], contributesClients: true,
    writeCapabilities: ['direct_ssid'], defaultPollIntervalSec: 60, defaultCallBudget: 20_000,
    legacy: {
      endpointKey: 'apiHost', hideClientCredentials: true,
      fields: [
        { key: 'orgId', label: 'Org ID', help: 'Mist organisation UUID.' },
        { key: 'token', label: 'API token', help: 'Org API token — sent as Authorization: Token.', secret: true },
      ],
    },
  },
  {
    id: 'greenlake', label: 'GreenLake platform', tone: 'accent',
    endpoint: {
      label: 'GreenLake API base URL', help: 'Defaults to the global GreenLake API.',
      hint: 'global.api.greenlake.hpe.com', default: 'https://global.api.greenlake.hpe.com',
    },
    auth: [oauth({ key: 'workspaceId', label: 'Workspace ID', help: 'GreenLake workspace identifier.', type: 'string', required: true })],
    supportedDatasets: ['devices', 'subscriptions', 'assignments', 'greenlake'],
    scopeOptions: [...READ_SCOPES, WRITE_DIRECT], contributesClients: false,
    writeCapabilities: ['direct_greenlake_objects'], defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: {
      endpointKey: 'workspaceId', hideClientCredentials: false,
      endpoint: {
        label: 'GreenLake workspace ID',
        help: 'Platform workspace, not the application instance.',
        hint: 'wks-meridian-health',
      },
      fields: [{ key: 'workspaceId', label: 'Workspace ID', help: 'Platform workspace, not the application instance.' }],
    },
  },
  {
    id: 'clearpass', label: 'ClearPass', tone: 'neutral',
    endpoint: {
      label: 'ClearPass publisher URL', help: 'Publisher node serving the REST API.',
      hint: 'cppm-01.example.com', default: 'https://cppm.example.com',
    },
    auth: [
      oauth({ key: 'coaEnforcementProfile', label: 'CoA enforcement profile', help: 'Optional Disconnect-Request profile.', type: 'string', required: false }),
      { kind: 'token', label: 'Static API token', fields: [
        { key: 'token', label: 'API token', help: 'Publisher API token.', type: 'string', required: true, secret: true },
        { key: 'coaEnforcementProfile', label: 'CoA enforcement profile', help: 'Optional Disconnect-Request profile.', type: 'string', required: false },
      ] },
    ],
    supportedDatasets: ['authEvents', 'endpoints', 'networkDevices', 'authSources', 'roles', 'enforcementPolicies', 'enforcementProfiles', 'localUsers', 'services', 'deviceGroups'],
    scopeOptions: [...READ_SCOPES, WRITE_DIRECT], contributesClients: false,
    writeCapabilities: ['direct_clearpass_objects'], defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: {
      endpointKey: 'host', hideClientCredentials: false,
      endpoint: {
        label: 'ClearPass publisher URL',
        help: 'Publisher node, API client credentials.',
        hint: 'cppm-01.meridian.health',
      },
      fields: [
        { key: 'token', label: 'API token', help: 'OAuth access token for the publisher API client.', secret: true },
        { key: 'coaEnforcementProfile', label: 'CoA enforcement profile', help: 'Sent on a CoA disconnect when set. Leave blank to use the publisher default — a wrong name fails the request.', optional: true },
      ],
    },
  },
  {
    id: 'uxi', label: 'HPE Aruba UXI (sensors)', tone: 'warning',
    endpoint: {
      label: 'UXI API base', help: 'Defaults to api.capenetworks.com; authentication uses HPE SSO.',
      hint: 'api.capenetworks.com', default: 'https://api.capenetworks.com',
    },
    auth: [oauth()], supportedDatasets: ['uxiSensors'], scopeOptions: [READ_INVENTORY],
    contributesClients: false, writeCapabilities: [], defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: {
      endpointKey: 'baseUrl', hideClientCredentials: false, fields: [],
      endpoint: {
        label: 'UXI API base — optional',
        help: 'Defaults to api.capenetworks.com; auth is always HPE SSO client credentials.',
        hint: 'api.capenetworks.com',
      },
    },
  },
  {
    id: 'aos8', label: 'AOS-8 mobility master', tone: 'accent',
    endpoint: {
      label: 'Mobility master address', help: 'HTTPS API address for the Mobility Master.',
      hint: '10.48.0.10:4343', default: 'https://10.48.0.10:4343',
    },
    auth: [userPassword()], supportedDatasets: ['devices', 'sites', 'clients', 'config'],
    scopeOptions: [...READ_SCOPES, SSH_RECORDED], contributesClients: true,
    writeCapabilities: ['recorded_ssh'], defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: {
      endpointKey: 'master', hideClientCredentials: false,
      endpoint: {
        label: 'Mobility master address',
        help: 'Portal reaches it through a jump host.',
        hint: '10.48.0.10:4343',
      },
      fields: [
        { key: 'username', label: 'Username', help: 'Read-only management account on the master.' },
        { key: 'password', label: 'Password', help: 'Stored with the plane credentials.', secret: true },
      ],
    },
  },
  {
    id: 'local', label: 'Local AOS-CX', tone: 'neutral',
    endpoint: {
      label: 'AOS-CX switch REST URL', help: 'HTTPS URL of the switch management interface.',
      hint: 'https://10.42.0.9', default: 'https://127.0.0.1',
    },
    auth: [{
      kind: 'ssh', label: 'AOS-CX management credentials', fields: [
        USERNAME,
        PASSWORD,
        { key: 'privateKey', label: 'SSH private key', help: 'Optional PEM key for recorded SSH.', type: 'string', required: false, secret: true },
        { key: 'passphrase', label: 'Key passphrase', help: 'Passphrase for the private key.', type: 'string', required: false, secret: true },
        { key: 'port', label: 'SSH port', help: 'Defaults to 22.', type: 'number', required: false },
      ],
    }],
    supportedDatasets: ['devices'], scopeOptions: [READ_INVENTORY, SSH_RECORDED], contributesClients: false,
    writeCapabilities: ['recorded_ssh'], defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: {
      endpointKey: 'host', hideClientCredentials: true,
      endpoint: {
        label: 'Collector agent address',
        help: 'The agent dials out; this is for verification only.',
        hint: '10.42.0.9:8443',
      },
      fields: [
        { key: 'baseUrl', label: 'Switch URL', help: 'HTTPS URL of the switch management interface, e.g. https://10.0.0.1', optional: true },
        { key: 'username', label: 'SSH username', help: 'Account the collector opens recorded sessions with.' },
        { key: 'password', label: 'SSH password', help: 'Omit when a private key is supplied.', secret: true, optional: true },
        { key: 'privateKey', label: 'SSH private key', help: 'PEM body; preferred over a password.', secret: true, optional: true },
        { key: 'passphrase', label: 'Key passphrase', help: 'Only when the private key is encrypted.', secret: true, optional: true },
        { key: 'port', label: 'Jump host port', help: 'Defaults to 22.', optional: true },
      ],
    },
  },
  {
    id: 'sse', label: 'HPE Aruba Networking SSE', tone: 'accent',
    endpoint: {
      label: 'SSE Admin API base', help: 'Defaults to admin-api.axissecurity.com.',
      hint: 'admin-api.axissecurity.com', default: 'https://admin-api.axissecurity.com',
    },
    auth: [{ kind: 'token', label: 'Admin API token', fields: [
      { key: 'token', label: 'Admin API token', help: 'Scoped static token from Settings → Admin API.', type: 'string', required: true, secret: true },
    ] }],
    supportedDatasets: ['sse'], scopeOptions: [READ_CONFIG, WRITE_DIRECT], contributesClients: false,
    writeCapabilities: ['direct_sse_objects'], defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: {
      endpointKey: 'baseUrl', hideClientCredentials: true,
      endpoint: {
        label: 'SSE Admin API base — optional',
        help: 'Defaults to admin-api.axissecurity.com; auth is a scoped static Admin API token (Settings → Admin API in the SSE console).',
        hint: 'admin-api.axissecurity.com',
      },
      fields: [{ key: 'token', label: 'Admin API token', help: 'Scoped static token from Settings → Admin API in the SSE console — sent as Authorization: Bearer.', secret: true }],
    },
  },
  {
    id: 'edgeconnect', label: 'HPE Aruba EdgeConnect SD-WAN', tone: 'info',
    endpoint: {
      label: 'Orchestrator URL', help: 'HTTPS URL of the EdgeConnect Orchestrator.',
      hint: 'https://orchestrator.example.com', default: 'https://orchestrator.example.com',
    },
    auth: [
      { kind: 'api_key', label: 'API key', fields: [
        { key: 'apiKey', label: 'API Key', help: 'Orchestrator automation key.', type: 'string', required: true, secret: true },
      ] },
      userPassword(),
    ],
    supportedDatasets: ['devices', 'sites', 'alerts'], scopeOptions: [READ_INVENTORY], contributesClients: false,
    writeCapabilities: [], defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: {
      endpointKey: 'baseUrl', hideClientCredentials: true,
      fields: [
        { key: 'apiKey', label: 'API Key', help: 'Preferred for automation — generate from Orchestrator Settings › API Keys. If set, username/password are not required.', secret: true },
        { key: 'username', label: 'Username', help: 'Read-only management account on the Orchestrator (required if no API key).' },
        { key: 'password', label: 'Password', help: 'Stored with the plane credentials.', secret: true },
      ],
    },
  },
  {
    id: 'opsramp', label: 'HPE OpsRamp', tone: 'warning',
    endpoint: {
      label: 'OpsRamp API base', help: 'Defaults to app.opsramp.net.',
      hint: 'app.opsramp.net', default: 'https://app.opsramp.net',
    },
    auth: [oauth({ key: 'tenantId', label: 'Tenant ID', help: 'OpsRamp tenant identifier.', type: 'string', required: true })],
    supportedDatasets: ['devices', 'alerts'], scopeOptions: [READ_INVENTORY], contributesClients: false,
    writeCapabilities: [], defaultPollIntervalSec: 60, defaultCallBudget: null,
    legacy: {
      endpointKey: 'tenantId', hideClientCredentials: false,
      endpoint: {
        label: 'OpsRamp tenant ID',
        help: 'OpsRamp tenant ID from your account settings.',
        hint: 'tenant-123',
      },
      fields: [{ key: 'baseUrl', label: 'Base URL', help: 'Leave blank for app.opsramp.net.', optional: true }],
    },
  },
];

const CATALOG_BY_ID = new Map(CONNECTOR_CATALOG.map((entry) => [entry.id, entry] as const));
const CONFIG_FIELDS = new Set([
  'id', 'enabled', 'endpoint', 'auth', 'verifyTls', 'pollIntervalSec', 'callBudget',
  'datasets', 'scopes', 'approvedFirmware',
]);
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;
const MASK = '••••••';

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

function endpointUrl(value: unknown): string {
  const raw = requiredString(value, 'endpoint');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('endpoint must be a valid URL');
  }
  if (parsed.protocol === 'https:') return candidate.replace(/\/+$/, '');
  if (parsed.protocol === 'http:' && LOOPBACK_HOST.test(parsed.hostname)) return candidate.replace(/\/+$/, '');
  throw new Error('endpoint must use HTTPS unless it is an explicit loopback lab endpoint');
}

function positiveInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const items = value.map((item) => (item as string).trim());
  if (new Set(items).size !== items.length) throw new Error(`${label} must not contain duplicates`);
  return items;
}

function parseAuth(entry: ConnectorCatalogEntry, value: unknown): ConnectorAuth {
  const raw = record(value, 'auth');
  const kind = requiredString(raw.kind, 'auth.kind') as ConnectorAuthKind;
  const option = entry.auth.find((candidate) => candidate.kind === kind);
  if (!option) throw new Error(`${entry.id} does not support ${kind} authentication`);
  const permitted = new Set(['kind', ...option.fields.map((field) => field.key)]);
  for (const key of Object.keys(raw)) {
    if (!permitted.has(key)) throw new Error(`unknown ${entry.id} auth field: ${key}`);
  }
  const out: Record<string, unknown> = { kind };
  for (const field of option.fields) {
    const input = raw[field.key];
    if (input === undefined && !field.required) continue;
    if (field.type === 'number') {
      out[field.key] = positiveInteger(input, `auth.${field.key}`, 1);
    } else if (field.required) {
      out[field.key] = requiredString(input, `auth.${field.key}`);
    } else if (input !== undefined) {
      if (typeof input !== 'string') throw new Error(`auth.${field.key} must be a string`);
      if (input.trim()) out[field.key] = input.trim();
    }
  }
  return out as unknown as ConnectorAuth;
}

/** Validate and normalize an untrusted connector payload for one product. */
export function parseConnectorConfig<I extends ConnectorId>(id: I, input: unknown): Extract<ConnectorConfig, { id: I }> {
  const entry = CATALOG_BY_ID.get(id);
  if (!entry) throw new Error(`unsupported connector: ${id}`);
  const raw = record(input, `${id} connector`);
  for (const key of Object.keys(raw)) {
    if (!CONFIG_FIELDS.has(key)) throw new Error(`unknown ${id} connector field: ${key}`);
  }
  if (raw.id !== undefined && raw.id !== id) throw new Error(`connector id must be ${id}`);
  if (typeof raw.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  if (typeof raw.verifyTls !== 'boolean') throw new Error('verifyTls must be a boolean');
  const datasets = stringList(raw.datasets, 'datasets');
  const allowedDatasets = new Set<string>(entry.supportedDatasets);
  for (const dataset of datasets) {
    if (!allowedDatasets.has(dataset)) throw new Error(`${entry.id} does not support dataset ${dataset}`);
  }
  const scopes = stringList(raw.scopes, 'scopes');
  const allowedScopes = new Set(entry.scopeOptions.map((scope) => scope.value));
  for (const scope of scopes) {
    if (!allowedScopes.has(scope)) throw new Error(`${entry.id} does not support scope ${scope}`);
  }
  const callBudget = raw.callBudget === null
    ? null
    : positiveInteger(raw.callBudget, 'callBudget', 1);
  if (raw.approvedFirmware !== undefined && typeof raw.approvedFirmware !== 'string') {
    throw new Error('approvedFirmware must be a string');
  }
  return {
    id,
    enabled: raw.enabled,
    endpoint: endpointUrl(raw.endpoint),
    auth: parseAuth(entry, raw.auth),
    verifyTls: raw.verifyTls,
    pollIntervalSec: positiveInteger(raw.pollIntervalSec, 'pollIntervalSec', 5),
    callBudget,
    datasets: datasets as PlaneDatasetKey[],
    scopes,
    ...(raw.approvedFirmware === undefined ? {} : { approvedFirmware: raw.approvedFirmware }),
  } as Extract<ConnectorConfig, { id: I }>;
}

/** Return a deep, non-mutating copy with every replayable credential masked. */
export function maskConnectorConfig<I extends ConnectorConfig>(config: I): I {
  const clone = structuredClone(config) as I;
  const auth = clone.auth as unknown as Record<string, unknown>;
  for (const key of Object.keys(auth)) {
    if (/secret|token|key|password|passphrase/i.test(key) && typeof auth[key] === 'string') auth[key] = MASK;
  }
  return clone;
}

function legacyEndpoint(id: ConnectorId, legacy: Record<string, string>, fallback: string): string {
  const candidates: Record<ConnectorId, string[]> = {
    central: ['gatewayBaseUrl'], classic: ['gatewayBaseUrl'], mist: ['apiHost'],
    greenlake: ['baseUrl'], clearpass: ['publisher', 'host', 'baseUrl'], uxi: ['baseUrl'],
    aos8: ['master'], local: ['baseUrl'], sse: ['baseUrl'], edgeconnect: ['baseUrl'], opsramp: ['baseUrl'],
  };
  return candidates[id].map((key) => legacy[key]?.trim()).find(Boolean) ?? fallback;
}

function legacyAuth(id: ConnectorId, legacy: Record<string, string>): ConnectorAuth | null {
  const oauthAuth = (extra: Record<string, string> = {}): OAuthClientCredentialsAuth | null => {
    if (!legacy.clientId?.trim() || !legacy.clientSecret?.trim()) return null;
    return {
      kind: 'oauth_client_credentials', clientId: legacy.clientId.trim(), clientSecret: legacy.clientSecret,
      ...extra,
    };
  };
  switch (id) {
    case 'central':
    case 'classic':
    case 'uxi':
      return oauthAuth();
    case 'mist':
      return legacy.orgId?.trim() && legacy.token?.trim()
        ? { kind: 'token', orgId: legacy.orgId.trim(), token: legacy.token }
        : null;
    case 'greenlake':
      return legacy.workspaceId?.trim() ? oauthAuth({ workspaceId: legacy.workspaceId.trim() }) : null;
    case 'clearpass':
      if (legacy.clientId?.trim() && legacy.clientSecret?.trim()) {
        return oauthAuth(legacy.coaEnforcementProfile?.trim()
          ? { coaEnforcementProfile: legacy.coaEnforcementProfile.trim() }
          : {});
      }
      return legacy.token?.trim()
        ? {
            kind: 'token', token: legacy.token,
            ...(legacy.coaEnforcementProfile?.trim() ? { coaEnforcementProfile: legacy.coaEnforcementProfile.trim() } : {}),
          }
        : null;
    case 'aos8': {
      const username = (legacy.username ?? legacy.clientId)?.trim();
      const password = legacy.password ?? legacy.clientSecret;
      return username && password?.trim() ? { kind: 'username_password', username, password } : null;
    }
    case 'local':
      return legacy.username?.trim() && legacy.password?.trim()
        ? {
            kind: 'ssh', username: legacy.username.trim(), password: legacy.password,
            ...(legacy.privateKey?.trim() ? { privateKey: legacy.privateKey } : {}),
            ...(legacy.passphrase?.trim() ? { passphrase: legacy.passphrase } : {}),
            ...(/^\d+$/.test(legacy.port ?? '') ? { port: Number(legacy.port) } : {}),
          }
        : null;
    case 'sse':
      return legacy.token?.trim() ? { kind: 'token', token: legacy.token } : null;
    case 'edgeconnect':
      if (legacy.apiKey?.trim()) return { kind: 'api_key', apiKey: legacy.apiKey };
      return legacy.username?.trim() && legacy.password?.trim()
        ? { kind: 'username_password', username: legacy.username.trim(), password: legacy.password }
        : null;
    case 'opsramp':
      return legacy.tenantId?.trim() ? oauthAuth({ tenantId: legacy.tenantId.trim() }) : null;
  }
}

function legacyNumber(value: string | undefined, fallback: number | null, minimum: number): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Convert a complete flat settings record without discarding stored policy. */
export function migrateLegacyPlaneRecord(id: ConnectorId, legacy: Record<string, string>): ConnectorConfig | null {
  const entry = CATALOG_BY_ID.get(id);
  if (!entry) return null;
  const auth = legacyAuth(id, legacy);
  if (!auth) return null;
  const scopes = (legacy.scopes ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  return {
    id,
    enabled: legacy.enabled === undefined ? true : legacy.enabled !== 'false',
    endpoint: endpointUrl(legacyEndpoint(id, legacy, entry.endpoint.default)),
    auth,
    verifyTls: legacy.verifyTls === undefined ? true : legacy.verifyTls === 'true',
    pollIntervalSec: legacyNumber(legacy.pollIntervalSec, entry.defaultPollIntervalSec, 5) as number,
    callBudget: legacyNumber(legacy.callBudget, entry.defaultCallBudget, 1),
    datasets: [...entry.supportedDatasets],
    scopes,
    ...(legacy.approvedFirmware === undefined ? {} : { approvedFirmware: legacy.approvedFirmware }),
  } as ConnectorConfig;
}

export function connectorCatalogEntry(id: ConnectorId): ConnectorCatalogEntry {
  return CATALOG_BY_ID.get(id)!;
}
