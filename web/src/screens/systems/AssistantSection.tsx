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
import { Badge, Button, FormField, Input, SectionHeader, Select, Switch, useToast } from '../../nightdesk';
import { useEffect, useState } from 'react';

const PROVIDERS: Record<AssistantProviderId, { title: string; defaultModel: string }> = {
  codex: { title: 'Codex', defaultModel: 'gpt-5.6-terra' },
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

  const refreshStatus = async () => {
    try {
      setStatus(await getChatStatus());
      setLoadError(null);
    } catch (error) {
      setLoadError(`Assistant status could not be loaded: ${(error as Error).message}`);
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

  const updateSelected = (patch: Record<string, unknown>) => {
    setSettings((current) => current ? {
      ...current,
      providers: { ...current.providers, [selected]: { ...current.providers[selected], ...patch } } as AssistantSettings['providers'],
    } : current);
    if ('apiKey' in patch) setProviderKey(String(patch.apiKey ?? ''));
    setTestResult(null);
  };

  const chooseProvider = (id: AssistantProviderId) => {
    setSelected(id);
    setProviderKey('');
    setTestResult(null);
  };

  const save = async () => {
    if (!settings || !selectedConfig) return;
    setSaving(true);
    const providerPatch = { ...selectedConfig } as Record<string, unknown>;
    if ('apiKey' in providerPatch) {
      if (providerKey.trim()) providerPatch.apiKey = providerKey.trim();
      else delete providerPatch.apiKey;
    }
    const mcp = { ...settings.mcp, authToken: mcpToken.trim() || settings.mcp.authToken };
    const response = await saveChatSettings({
      assistant: {
        activeProvider: selected,
        mcp,
        chatWriteMode: settings.chatWriteMode,
        providers: { [selected]: providerPatch } as AssistantSettings['providers'],
      },
    });
    setSaving(false);
    if (!response.ok) {
      toast(response.message, { tone: 'danger' });
      return;
    }
    setSettings((current) => current ? { ...current, activeProvider: selected } : current);
    setProviderKey('');
    setMcpToken('');
    toast('Assistant settings saved', { tone: 'success' });
    await refreshStatus();
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testChatProvider(selected);
      setTestResult(result);
    } catch (error) {
      setTestResult({ installed: false, authenticated: false, mcpReady: false, modelReady: false, selected: true, resolvedModel: null, latencyMs: null, message: (error as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader label="Assistant" meta="PROVIDER · TOOL ACCESS" />
      {loadError ? <span role="status" style={{ fontSize: 12, color: 'var(--nd-danger)' }}>{loadError}</span> : null}

      <div aria-label="Assistant providers" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {ASSISTANT_PROVIDER_IDS.map((id) => {
          const item = status?.providers?.find((provider) => provider.id === id);
          const active = selected === id;
          const ready = providerReady(item);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              aria-label={`${PROVIDERS[id].title}${active ? ', selected' : ''}`}
              disabled={offline}
              onClick={() => chooseProvider(id)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 7px', borderRadius: 4, border: active ? '1px solid var(--nd-accent)' : '1px solid var(--nd-border)', background: active ? 'var(--nd-surface-raised)' : 'transparent', color: 'var(--nd-text)', cursor: offline ? 'not-allowed' : 'pointer' }}
            >
              <span style={{ fontSize: 12 }}>{PROVIDERS[id].title}</span>
              <Badge tone={ready ? 'success' : 'neutral'}>{ready ? 'ready' : 'unavailable'}</Badge>
            </button>
          );
        })}
      </div>

      {selectedConfig ? <>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge tone={providerReady(selectedStatus) ? 'success' : 'neutral'} dot>{providerReady(selectedStatus) ? 'ready' : 'unavailable'}</Badge>
          <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 11, color: 'var(--nd-text-muted)' }}>
            {selectedStatus?.resolvedModel ?? ('model' in selectedConfig ? selectedConfig.model : PROVIDERS[selected].defaultModel)}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          {'baseUrl' in selectedConfig ? <FormField label="Provider endpoint"><Input mono aria-label="Provider endpoint" value={selectedConfig.baseUrl} disabled={offline} onChange={(event) => updateSelected({ baseUrl: event.target.value })} /></FormField> : null}
          <FormField label="Model"><Input mono aria-label="Model" value={selectedConfig.model} disabled={offline} onChange={(event) => updateSelected({ model: event.target.value })} /></FormField>
          {'reasoningEffort' in selectedConfig ? <FormField label="Reasoning"><Select aria-label="Reasoning" value={selectedConfig.reasoningEffort} disabled={offline} options={['low', 'medium', 'high'].map((value) => ({ value, label: value }))} onValueChange={(reasoningEffort) => updateSelected({ reasoningEffort })} /></FormField> : null}
          {'thinking' in selectedConfig ? <Switch checked={selectedConfig.thinking} disabled={offline} label="Thinking" onCheckedChange={(thinking) => updateSelected({ thinking })} /> : null}
          {'effort' in selectedConfig ? <FormField label="Mode"><Select aria-label="Mode" value={selectedConfig.model} disabled={offline} options={[{ value: 'auto', label: 'Auto · adaptive' }, { value: 'gpt-5.6-terra', label: 'Terra · alternate' }]} onValueChange={(model) => updateSelected({ model, effort: model === 'auto' ? 'adaptive' : 'low' })} /></FormField> : null}
          {'apiKey' in selectedConfig || selected === 'ollama' || selected === 'openrouter' ? <FormField label="API key"><Input mono aria-label="API key" type="password" placeholder="Enter replacement key" value={providerKey} disabled={offline} onChange={(event) => updateSelected({ apiKey: event.target.value })} /></FormField> : null}
        </div>

        <details>
          <summary>Advanced</summary>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--nd-text-muted)' }}>Fast default: {PROVIDERS[selected].defaultModel}</div>
        </details>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button size="sm" variant="primary" disabled={saving || offline} onClick={() => void save()}>{saving ? 'Saving…' : 'Save assistant'}</Button>
          <Button size="sm" variant="ghost" disabled={testing || offline} onClick={() => void runTest()}>{testing ? 'Testing…' : 'Test provider'}</Button>
          {testResult ? <span role="status" style={{ fontSize: 11, color: providerReady(testResult) ? 'var(--nd-success)' : 'var(--nd-danger)' }}>{providerReady(testResult) ? `${testResult.latencyMs ?? 0} ms · ${testResult.resolvedModel ?? 'model resolved'}` : testResult.message}</span> : null}
        </div>
      </> : null}

      <div style={{ borderTop: '1px solid var(--nd-border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionHeader label="Tool access" meta="CENTRALMCP" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <FormField label="Endpoint"><Input mono aria-label="centralmcp endpoint" value={settings?.mcp.endpoint ?? ''} disabled={offline} onChange={(event) => setSettings((current) => current ? { ...current, mcp: { ...current.mcp, endpoint: event.target.value } } : current)} /></FormField>
          <FormField label="Auth token"><Input mono aria-label="centralmcp auth token" type="password" placeholder="Enter replacement token" value={mcpToken} disabled={offline} onChange={(event) => setMcpToken(event.target.value)} /></FormField>
        </div>
        <Switch checked={settings?.chatWriteMode === 'enabled'} disabled={offline} label="Allow write tools" onCheckedChange={(enabled) => setSettings((current) => current ? { ...current, chatWriteMode: enabled ? 'enabled' : 'read-only' } : current)} />
      </div>
    </div>
  );
}
