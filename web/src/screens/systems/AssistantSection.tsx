/** Compact assistant provider selection and tool-access settings. */

import {
  ASSISTANT_PROVIDER_IDS,
  getChatSettings,
  getChatStatus,
  saveChatSettings,
  testChatProvider,
  type AssistantProviderId,
  type AssistantProviderStatus,
  type AssistantSettings,
  type ChatStatus,
} from '../../api/client';
import { CODEX_MODEL_OPTIONS } from '@hpe/shared';
import { Badge, Button, FormField, Input, SectionHeader, Select, Switch, useToast } from '../../nightdesk';
import { useEffect, useState } from 'react';
import { buildSystemsSectionUrl, systemsSectionDomId } from './share';

const PROVIDERS: Record<AssistantProviderId, { title: string; defaultModel: string }> = {
  codex: { title: 'Codex', defaultModel: 'gpt-5.3-spark' },
  claude: { title: 'Claude', defaultModel: 'sonnet' },
  kimi: { title: 'Kimi', defaultModel: 'kimi-code/kimi-for-coding-highspeed' },
  copilot: { title: 'GitHub Copilot', defaultModel: 'auto' },
  ollama: { title: 'Ollama', defaultModel: 'qwen2.5-coder:7b' },
  openrouter: { title: 'OpenRouter', defaultModel: 'openai/gpt-4.1-mini' },
};

function providerReady(status: AssistantProviderStatus | undefined): boolean {
  return Boolean(status?.installed && status.authenticated && status.mcpReady && status.modelReady);
}

function redactedSecret(value: string | null | undefined): string {
  // A settings response may contain a mask to signal that a secret is saved.
  // Never render it: a blank input means "enter a replacement" only.
  return value?.includes('•') ? '' : value ?? '';
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function providerConfigurationIsValid(id: AssistantProviderId, config: AssistantSettings['providers'][AssistantProviderId], mcpEndpoint: string): boolean {
  if (!config.model.trim() || !validHttpUrl(mcpEndpoint)) return false;
  if ('baseUrl' in config && !validHttpUrl(config.baseUrl)) return false;
  return id !== 'copilot' || !('effort' in config) || (config.model === 'auto' && config.effort === 'adaptive') || (config.model === 'gpt-5.6-terra' && config.effort === 'low');
}

export function AssistantSection() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [selected, setSelected] = useState<AssistantProviderId>('codex');
  const [mcpToken, setMcpToken] = useState('');
  const [providerKey, setProviderKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AssistantProviderStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftProviders, setDraftProviders] = useState<ReadonlySet<AssistantProviderId>>(new Set());
  const [sharedStatusDraft, setSharedStatusDraft] = useState(false);

  const refreshStatus = async (): Promise<boolean> => {
    try {
      const next = await getChatStatus();
      setStatus(next);
      setLoadError(null);
      return next !== null;
    } catch (error) {
      setLoadError(`Assistant status could not be loaded: ${(error as Error).message}`);
      return false;
    }
  };

  useEffect(() => {
    let live = true;
    void Promise.all([getChatSettings(), getChatStatus()])
      .then(([loaded, currentStatus]) => {
        if (!live) return;
        if (loaded) {
          setSettings(loaded.assistant);
          setSelected(loaded.assistant.activeProvider);
          setMcpToken(redactedSecret(loaded.assistant.mcp.authToken));
        }
        setStatus(currentStatus);
      })
      .catch((error: Error) => live && setLoadError(`Assistant settings could not be loaded: ${error.message}`));
    return () => { live = false; };
  }, []);

  const selectedConfig = settings?.providers[selected];
  const selectedStatus = status?.providers?.find((item) => item.id === selected);
  const offline = settings === null;
  const busy = saving || testing;
  const statusIsDraft = (id: AssistantProviderId) => sharedStatusDraft || draftProviders.has(id);

  const updateSelected = (patch: Record<string, unknown>) => {
    setSettings((current) => current ? {
      ...current,
      providers: { ...current.providers, [selected]: { ...current.providers[selected], ...patch } } as AssistantSettings['providers'],
    } : current);
    if ('apiKey' in patch) setProviderKey(String(patch.apiKey ?? ''));
    setDraftProviders((current) => new Set(current).add(selected));
    setTestResult(null);
  };

  const updateSharedSettings = (update: (current: AssistantSettings) => AssistantSettings) => {
    setSettings((current) => current ? update(current) : current);
    setSharedStatusDraft(true);
    setTestResult(null);
  };

  const chooseProvider = (id: AssistantProviderId) => {
    setSelected(id);
    if (id !== settings?.activeProvider) {
      setDraftProviders((current) => new Set(current).add(id));
    }
    setProviderKey('');
    setTestResult(null);
  };

  const persistSelectedProvider = async (announce: boolean): Promise<boolean> => {
    if (!settings || !selectedConfig) return false;
    if (!providerConfigurationIsValid(selected, selectedConfig, settings.mcp.endpoint)) {
      toast('Enter a valid endpoint and provider settings', { tone: 'danger' });
      return false;
    }
    setSaving(true);
    try {
      const providerPatch = { ...selectedConfig } as Record<string, unknown>;
      if ('apiKey' in providerPatch) {
        if (providerKey.trim()) providerPatch.apiKey = providerKey.trim();
        else delete providerPatch.apiKey;
      }
      const mcp = { ...settings.mcp, enabled: true, authToken: mcpToken.trim() || settings.mcp.authToken };
      providerPatch.enabled = true;
      const response = await saveChatSettings({
        assistant: {
          activeProvider: selected,
          mcp,
          chatWriteMode: settings.chatWriteMode,
          providers: { [selected]: providerPatch } as AssistantSettings['providers'],
        },
      });
      if (!response.ok) {
        setSelected(settings.activeProvider);
        toast(response.message, { tone: 'danger' });
        return false;
      }
      setSettings((current) => current ? { ...current, activeProvider: selected } : current);
      setProviderKey('');
      setMcpToken('');
      if (announce) toast('Assistant settings saved', { tone: 'success' });
      const refreshed = await refreshStatus();
      if (refreshed) {
        setDraftProviders((current) => {
          const next = new Set(current);
          next.delete(selected);
          return next;
        });
        setSharedStatusDraft(false);
      }
      return true;
    } catch (error) {
      setSelected(settings.activeProvider);
      toast(`Assistant settings could not be saved: ${(error as Error).message}`, { tone: 'danger' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => { await persistSelectedProvider(true); };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const saved = await persistSelectedProvider(false);
      if (!saved) return;
      const result = await testChatProvider(selected);
      setTestResult(result);
    } catch (error) {
      setTestResult({ installed: false, authenticated: false, mcpReady: false, modelReady: false, selected: true, resolvedModel: null, latencyMs: null, message: (error as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const copySectionLink = () => {
    const url = buildSystemsSectionUrl('assistant');
    void navigator.clipboard.writeText(url).then(
      () =>
        toast('Assistant section link copied', {
          description: 'section=assistant',
          tone: 'success',
        }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  return (
    <div id={systemsSectionDomId('assistant')} className="nt-stack nt-gap-10 nt-assistant-section nt-section-panel">
      <div className="nt-filter-bar nt-gap-8">
        <SectionHeader label="Assistant" meta="PROVIDER · MODEL · TOOLS" />
        <Button variant="ghost" size="sm" className="nt-ml-auto" onClick={copySectionLink}>
          Copy section link
        </Button>
      </div>
      <div className="nt-status-ribbon nt-assistant-cfg-ribbon" role="status" aria-label="Assistant config status ribbon">
        <span className="nt-status-ribbon__item">providers · MCP</span>
        <span className="nt-status-ribbon__item">lab write gated</span>
        <span className="nt-status-ribbon__item">tools path</span>
      </div>
      {loadError ? <span role="status" className="nt-danger-12">{loadError}</span> : null}

      <div aria-label="Assistant providers" className="nt-wrap-6">
        {ASSISTANT_PROVIDER_IDS.map((id) => {
          const item = status?.providers?.find((provider) => provider.id === id);
          const active = settings?.activeProvider === id;
          const editing = selected === id;
          const draft = statusIsDraft(id);
          const ready = !draft && providerReady(item);
          const model = draft ? settings?.providers[id].model : item?.resolvedModel;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={editing}
              aria-label={`${PROVIDERS[id].title}${active ? ', selected' : editing ? ', editing' : ''}`}
              disabled={offline || busy}
              onClick={() => chooseProvider(id)}
              className={`nt-assistant-chip nt-toggle-chip${editing ? " nt-assistant-chip--editing" : ""}`}
            >
              <span className="nt-fs-12">{PROVIDERS[id].title}</span>
              {active ? <Badge tone="neutral">active</Badge> : null}
              <Badge tone={ready ? 'success' : 'neutral'}>{draft ? 'draft' : ready ? 'ready' : 'unavailable'}</Badge>
              <span className="nt-hint-muted">{model ?? '—'}</span>
            </button>
          );
        })}
      </div>

      {selectedConfig ? <>
        <div className="nt-row-center nt-gap-8">
          <Badge tone={!statusIsDraft(selected) && providerReady(selectedStatus) ? 'success' : 'neutral'} dot>{statusIsDraft(selected) ? 'draft' : providerReady(selectedStatus) ? 'ready' : 'unavailable'}</Badge>
          <span className="nt-hint-muted">
            {statusIsDraft(selected) ? selectedConfig.model : selectedStatus?.resolvedModel ?? selectedConfig.model ?? PROVIDERS[selected].defaultModel}
          </span>
        </div>

        <div className="nt-grid-2-10">
          {'baseUrl' in selectedConfig ? <FormField label="Provider endpoint"><Input mono aria-label="Provider endpoint" value={selectedConfig.baseUrl} disabled={offline || busy} onChange={(event) => updateSelected({ baseUrl: event.target.value })} /></FormField> : null}
          {selected === 'codex' ? <FormField label="Model"><Select aria-label="Model" value={selectedConfig.model} disabled={offline || busy} options={CODEX_MODEL_OPTIONS.map(({ id, label }) => ({ value: id, label }))} onValueChange={(model) => updateSelected({ model })} /></FormField> : selected === 'copilot' ? <FormField label="Mode"><Select aria-label="Mode" value={selectedConfig.model} disabled={offline || busy} options={[{ value: 'auto', label: 'Auto · adaptive' }, { value: 'gpt-5.6-terra', label: 'Terra · alternate' }]} onValueChange={(model) => updateSelected({ model, effort: model === 'auto' ? 'adaptive' : 'low' })} /></FormField> : <FormField label="Model"><Input mono aria-label="Model" value={selectedConfig.model} disabled={offline || busy} onChange={(event) => updateSelected({ model: event.target.value })} /></FormField>}
          {'reasoningEffort' in selectedConfig ? <FormField label="Reasoning"><Select aria-label="Reasoning" value={selectedConfig.reasoningEffort} disabled={offline || busy} options={selected === 'codex' ? [{ value: 'auto', label: 'Auto · normal' }, { value: 'low', label: 'low · fast' }, { value: 'medium', label: 'medium · balanced' }, { value: 'high', label: 'high · thorough' }] : [{ value: 'low', label: 'low · fast' }]} onValueChange={(reasoningEffort) => updateSelected({ reasoningEffort })} /></FormField> : null}
          {'thinking' in selectedConfig ? <Switch checked={selectedConfig.thinking} disabled={offline || busy} label="Thinking" onCheckedChange={(thinking) => updateSelected({ thinking })} /> : null}
          {'apiKey' in selectedConfig || selected === 'ollama' || selected === 'openrouter' ? <FormField label="API key"><Input mono aria-label="API key" type="password" placeholder="Enter replacement key" value={providerKey} disabled={offline || busy} onChange={(event) => updateSelected({ apiKey: event.target.value })} /></FormField> : null}
        </div>

        <div className="nt-filter-bar nt-gap-8">
          <Button size="sm" variant="primary" disabled={busy || offline} onClick={() => void save()}>{saving ? 'Saving…' : 'Save assistant'}</Button>
          <Button size="sm" variant="ghost" disabled={busy || offline} onClick={() => void runTest()}>{testing ? 'Testing…' : 'Test provider'}</Button>
          {testResult ? <span role="status" className={`nt-fs-11-muted ${providerReady(testResult) ? 'nt-tone-success' : 'nt-tone-danger'}`}>{providerReady(testResult) ? `${testResult.latencyMs ?? 0} ms · ${testResult.resolvedModel ?? 'model resolved'}` : testResult.message}</span> : null}
        </div>
      </> : null}

      <div className="nt-assistant-footer">
        <SectionHeader label="Tool access" meta="CENTRALMCP · LAB" />
        <div className="nt-grid-2-10">
          <FormField label="Endpoint"><Input mono aria-label="centralmcp endpoint" value={settings?.mcp.endpoint ?? ''} disabled={offline || busy} onChange={(event) => updateSharedSettings((current) => ({ ...current, mcp: { ...current.mcp, endpoint: event.target.value } }))} /></FormField>
          <FormField label="Auth token"><Input mono aria-label="centralmcp auth token" type="password" placeholder="Enter replacement token" value={mcpToken} disabled={offline || busy} onChange={(event) => { setMcpToken(event.target.value); setSharedStatusDraft(true); setTestResult(null); }} /></FormField>
        </div>
        <div className="nt-filter-bar nt-gap-8">
          <Switch checked={settings?.chatWriteMode === 'enabled'} disabled={offline || busy} label="Lab assistant access" onCheckedChange={(enabled) => updateSharedSettings((current) => ({ ...current, chatWriteMode: enabled ? 'enabled' : 'read-only' }))} />
          <Badge tone={settings?.chatWriteMode === 'enabled' ? 'success' : 'neutral'}>{settings?.chatWriteMode === 'enabled' ? 'READ / WRITE' : 'READ ONLY'}</Badge>
        </div>
      </div>
    </div>
  );
}
