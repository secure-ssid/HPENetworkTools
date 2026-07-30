/** Assistant settings: provider, model and connection test. */

import {
  getChatSettings,
  getChatStatus,
  saveChatSettings,
  type ChatStatus,
} from '../../api/client';
import {
  Badge,
  Button,
  FormField,
  Input,
  SectionHeader,
  Switch,
  useToast,
} from '../../nightdesk';
import {
  useEffect,
  useState,
} from 'react';

// -- assistant (chat) section ---------------------------------------------------

/**
 * The assistant's configuration surface: centralmcp endpoint + bearer and the
 * OpenAI-compatible LLM triple, saved through PUT /api/settings (deep-merged;
 * masked '••••••…' secrets written back unchanged are ignored, so prefilled
 * masked values preserve the stored secrets). Status comes from
 * GET /api/chat/status. The write-mode Switch saves chatWriteMode directly.
 */
export function AssistantSection() {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [mcpUrl, setMcpUrl] = useState('');
  const [bearer, setBearer] = useState('');
  const [llmBase, setLlmBase] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [writeMode, setWriteMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshStatus = async () => {
    try {
      setStatus(await getChatStatus());
      setLoadError(null);
    } catch (err) {
      setStatus(null);
      setLoadError(`Assistant status could not be loaded: ${(err as Error).message}`);
    }
  };

  useEffect(() => {
    let live = true;
    void Promise.all([getChatStatus(), getChatSettings()])
      .then(([st, cfg]) => {
        if (!live) return;
        setStatus(st);
        if (cfg) {
          setMcpUrl(cfg.mcp?.url ?? '');
          setBearer(cfg.mcp?.bearerToken ?? '');
          setLlmBase(cfg.llm?.baseUrl ?? '');
          setLlmKey(cfg.llm?.apiKey ?? '');
          setLlmModel(cfg.llm?.model ?? '');
          setWriteMode(cfg.chatWriteMode);
        }
      })
      .catch((err: Error) => {
        if (live) setLoadError(`Assistant settings could not be loaded: ${err.message}`);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const offline = loaded && status === null;

  const save = async () => {
    setSaving(true);
    const res = await saveChatSettings({
      mcp: mcpUrl.trim() ? { url: mcpUrl.trim(), bearerToken: bearer.trim() || null } : null,
      llm:
        llmBase.trim() && llmModel.trim()
          ? { baseUrl: llmBase.trim(), apiKey: llmKey, model: llmModel.trim() }
          : null,
      chatWriteMode: writeMode,
    });
    setSaving(false);
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast('Assistant settings saved', { tone: 'success' });
    await refreshStatus();
  };

  const toggleWriteMode = async (next: boolean) => {
    const prev = writeMode;
    setWriteMode(next);
    const res = await saveChatSettings({ chatWriteMode: next });
    if (!res.ok) {
      setWriteMode(prev);
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(next ? 'Write tools enabled' : 'Write tools disabled', {
      description: next
        ? 'invoke_tool is offered to the model — each chat session still opts in separately.'
        : 'the assistant is read-only again.',
      tone: next ? 'warning' : 'success',
    });
    await refreshStatus();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader label="Assistant" meta="CENTRALMCP · LLM" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {status ? (
          <>
            {status.configured.mcp ? (
              <Badge tone={status.mcpReachable ? 'success' : 'warning'} dot>
                {status.mcpReachable ? 'mcp reachable' : 'mcp unreachable'}
              </Badge>
            ) : (
              <Badge tone="neutral" dot>
                mcp not configured
              </Badge>
            )}
            <Badge tone={status.configured.llm ? 'success' : 'neutral'} dot>
              {status.configured.llm ? 'llm configured' : 'llm not configured'}
            </Badge>
            <Badge tone={status.writeMode ? 'warning' : 'neutral'}>
              {status.writeMode ? 'write mode on' : 'read-only'}
            </Badge>
            {status.mcpUrl ? (
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10.5,
                  color: 'var(--nd-text-muted)',
                }}
              >
                {status.mcpUrl}
              </span>
            ) : null}
          </>
        ) : (
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 10.5,
              color: 'var(--nd-text-muted)',
            }}
          >
            {loadError ?? (offline ? 'backend offline — assistant settings unavailable' : 'checking chat status…')}
          </span>
        )}
      </div>

      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
      >
        <FormField label="MCP server URL" help="centralmcp streamable HTTP endpoint.">
          <Input
            mono
            placeholder="http://127.0.0.1:8010/mcp"
            value={mcpUrl}
            disabled={offline}
            onChange={(e) => setMcpUrl(e.target.value)}
          />
        </FormField>
        <FormField label="MCP bearer token" help="Optional. A masked value is kept as stored.">
          <Input
            mono
            type="password"
            placeholder="••••••••••••"
            value={bearer}
            disabled={offline}
            onChange={(e) => setBearer(e.target.value)}
          />
        </FormField>
        <FormField label="LLM base URL" help="OpenAI-compatible; /chat/completions is appended.">
          <Input
            mono
            placeholder="http://127.0.0.1:11434/v1"
            value={llmBase}
            disabled={offline}
            onChange={(e) => setLlmBase(e.target.value)}
          />
        </FormField>
        <FormField label="LLM API key" help="A masked value is kept as stored.">
          <Input
            mono
            type="password"
            placeholder="••••••••••••"
            value={llmKey}
            disabled={offline}
            onChange={(e) => setLlmKey(e.target.value)}
          />
        </FormField>
        <FormField label="LLM model">
          <Input
            mono
            placeholder="qwen2.5:7b"
            value={llmModel}
            disabled={offline}
            onChange={(e) => setLlmModel(e.target.value)}
          />
        </FormField>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Switch
          checked={writeMode}
          onCheckedChange={(v) => void toggleWriteMode(v)}
          disabled={offline}
          label="Allow write tools (invoke_tool)"
        />
        <Button
          variant="primary"
          size="sm"
          disabled={saving || offline}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save assistant settings'}
        </Button>
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 10,
            color: 'var(--nd-text-muted)',
          }}
        >
          saved server-side · secrets never leave the portal unmasked
        </span>
      </div>
    </div>
  );
}
