import {
  assistantSettingsSchema,
  type AssistantProviderConfig,
  type AssistantProviderId,
  type AssistantSettings,
} from '../../config/settings';
import type {
  AssistantProviderAdapter,
  AssistantProviderDescriptor,
  ProbeInvocation,
  ProviderStatus,
  ReadOnlyProbeContext,
} from './types';

const PROVIDER_DEFAULTS: readonly AssistantProviderDescriptor[] = [
  { id: 'codex', title: 'Codex', executionKind: 'cli', requiredFields: ['model', 'reasoningEffort'], defaultConfig: { enabled: false, model: 'gpt-5.6-terra', reasoningEffort: 'low' } },
  { id: 'claude', title: 'Claude', executionKind: 'cli', requiredFields: ['model', 'reasoningEffort'], defaultConfig: { enabled: false, model: 'sonnet', reasoningEffort: 'low' } },
  { id: 'kimi', title: 'Kimi', executionKind: 'cli', requiredFields: ['model', 'thinking'], defaultConfig: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false } },
  { id: 'copilot', title: 'GitHub Copilot', executionKind: 'cli', requiredFields: ['model', 'effort'], defaultConfig: { enabled: false, model: 'auto', effort: 'adaptive' } },
  { id: 'ollama', title: 'Ollama', executionKind: 'openai-compatible', requiredFields: ['baseUrl', 'model'], defaultConfig: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' } },
  { id: 'openrouter', title: 'OpenRouter', executionKind: 'openai-compatible', requiredFields: ['baseUrl', 'model'], defaultConfig: { enabled: false, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' } },
];
const READY_PROOF_CACHE_MS = 60_000;

export function getAssistantDefaults(): readonly AssistantProviderDescriptor[] {
  return PROVIDER_DEFAULTS.map((descriptor) => ({
    ...descriptor,
    requiredFields: [...descriptor.requiredFields],
    defaultConfig: { ...descriptor.defaultConfig },
  }));
}

export interface AssistantProviderRegistryDependencies {
  now?: () => number;
}

export interface AssistantProviderStatusOptions {
  /** Provider-test requests bypass the recent proof cache and perform a fresh safe read. */
  forceProbe?: boolean;
}

interface CachedProviderStatus {
  input: unknown;
  expiresAt: number;
  status: ProviderStatus;
}

function unavailable(selected: boolean, message: string): ProviderStatus {
  return {
    installed: false,
    authenticated: false,
    mcpReady: false,
    modelReady: false,
    selected,
    resolvedModel: null,
    latencyMs: null,
    message,
  };
}

function isCentralMcpReadOnlyProof(invocations: readonly ProbeInvocation[]): boolean {
  return invocations.length === 1
    && invocations[0].boundary === 'mcp'
    && invocations[0].server === 'centralmcp'
    && invocations[0].access === 'read-only'
    && invocations[0].tool.trim().length > 0;
}

/** Coordinates adapter discovery and proof-based readiness without surfacing adapter output. */
export class AssistantProviderRegistry {
  private readonly adapters: Map<AssistantProviderId, AssistantProviderAdapter>;
  private readonly now: () => number;
  private readonly readyCache = new Map<AssistantProviderId, CachedProviderStatus>();

  constructor(adapters: readonly AssistantProviderAdapter[] = [], dependencies: AssistantProviderRegistryDependencies = {}) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.now = dependencies.now ?? Date.now;
  }

  get(id: AssistantProviderId): AssistantProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  async status(
    input: AssistantSettings | unknown,
    id: AssistantProviderId,
    options: AssistantProviderStatusOptions = {},
  ): Promise<ProviderStatus> {
    const cached = this.readyCache.get(id);
    if (!options.forceProbe && cached && cached.input === input && cached.expiresAt > this.now()) {
      return cached.status;
    }
    const parsed = assistantSettingsSchema.safeParse(input);
    if (!parsed.success) {
      this.readyCache.delete(id);
      return unavailable(false, 'Provider configuration is invalid.');
    }
    const settings = parsed.data;
    const selected = settings.activeProvider === id;
    const config = settings.providers[id] as AssistantProviderConfig;
    if (!config.enabled) {
      this.readyCache.delete(id);
      return unavailable(selected, 'Provider is disabled.');
    }
    if (!settings.mcp.enabled) {
      this.readyCache.delete(id);
      return unavailable(selected, 'centralmcp is disabled.');
    }
    const adapter = this.adapters.get(id);
    if (!adapter) {
      this.readyCache.delete(id);
      return unavailable(selected, 'Provider is unavailable.');
    }
    if (adapter.canChat?.() === false) {
      this.readyCache.delete(id);
      return unavailable(selected, 'Provider is unavailable.');
    }

    try {
      const discovery = await adapter.discover(config);
      if (!discovery.installed) {
        this.readyCache.delete(id);
        return unavailable(selected, 'Provider is unavailable.');
      }
      if (!discovery.authenticated || !discovery.modelReady) {
        this.readyCache.delete(id);
        return {
          installed: true,
          authenticated: discovery.authenticated,
          mcpReady: false,
          modelReady: discovery.modelReady,
          selected,
          resolvedModel: discovery.resolvedModel ?? null,
          latencyMs: null,
          message: 'Provider is unavailable.',
        };
      }
      const startedAt = this.now();
      const invocations: ProbeInvocation[] = [];
      const context: ReadOnlyProbeContext = {
        mcp: { endpoint: settings.mcp.endpoint, authToken: settings.mcp.authToken },
        recordInvocation(invocation) {
          invocations.push({ ...invocation });
        },
      };
      const probe = await adapter.probeReadOnly(config, context);
      const latencyMs = Math.max(0, this.now() - startedAt);
      const mcpReady = isCentralMcpReadOnlyProof(invocations);
      const ready = probe.authenticated && probe.modelReady && mcpReady;
      const status = {
        installed: true,
        authenticated: probe.authenticated,
        mcpReady,
        modelReady: probe.modelReady,
        selected,
        resolvedModel: probe.resolvedModel ?? discovery.resolvedModel ?? null,
        latencyMs,
        message: ready ? 'Provider is ready.' : 'Provider is unavailable.',
      };
      if (ready) {
        this.readyCache.set(id, { input, status, expiresAt: this.now() + READY_PROOF_CACHE_MS });
      } else {
        this.readyCache.delete(id);
      }
      return status;
    } catch {
      this.readyCache.delete(id);
      return unavailable(selected, 'Provider is unavailable.');
    }
  }
}
