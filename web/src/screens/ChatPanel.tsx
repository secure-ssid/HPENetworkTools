/**
 * web/src/screens/ChatPanel.tsx — the assistant chat drawer.
 *
 * Right-side Drawer (width="lg"), opened from the shell topbar ("Assistant ⌘J")
 * or the ⌘J shortcut; state lives in AppShell. On open it probes
 * GET /api/chat/status: unconfigured → honest EmptyState pointing at
 * Connected systems → Assistant. Messages POST to /api/chat; the reply's tool
 * transcript renders as hairline rows ([mono tool | args | preview | ok/fail
 * Badge]) between messages. When the server's chatWriteMode is on, a Switch
 * in the panel header opts the session into writes (sent as allowWrite per
 * request — the server also requires its own setting, so this alone is not
 * sufficient). User messages are right-aligned bg-raised bubbles; assistant
 * replies are plain prose with code-ish lines in mono.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Drawer, EmptyState, Input, Spinner, Switch, Text } from '../nightdesk';
import { getChatStatus, postChat } from '../api/client';
import type { ChatStatus, ChatTranscriptEntry } from '../api/client';

interface PanelMessage {
  role: 'user' | 'assistant';
  content: string;
  transcript?: ChatTranscriptEntry[];
}

/** Lines that render in mono: prompts, fences, indentation, key: value data. */
function codeish(line: string): boolean {
  const t = line.trim();
  if (/^[$>#]/.test(t)) return true;
  if (/^\s{2,}\S/.test(line)) return true;
  if (/^`[^`]*`$/.test(t)) return true;
  if (/^[-\w.]+\s*[=:]\s*\S/.test(t)) return true;
  return false;
}

function AssistantText({ content }: { content: string }) {
  let fence = false;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {content.split('\n').map((line, i) => {
        if (line.trim().startsWith('```')) {
          fence = !fence;
          return null;
        }
        if (line.trim() === '') return <div key={i} style={{ height: 6 }} />;
        const mono = fence || codeish(line);
        return (
          <Text
            key={i}
            size={mono ? 11 : 12}
            mono={mono}
            tone={mono ? 'secondary' : 'primary'}
            style={{ lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {line}
          </Text>
        );
      })}
    </div>
  );
}

function TranscriptRow({ entry }: { entry: ChatTranscriptEntry }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--nd-font-mono)',
          fontSize: 10.5,
          color: 'var(--nd-accent-text)',
          width: 110,
          flex: '0 0 110px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.tool}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: 'var(--nd-font-mono)',
          fontSize: 10,
          color: 'var(--nd-text-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.args}
      </span>
      <span
        title={entry.resultPreview}
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: 'var(--nd-font-mono)',
          fontSize: 10,
          color: 'var(--nd-text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.resultPreview}
      </span>
      <Badge tone={entry.ok ? 'success' : 'danger'}>{entry.ok ? 'ok' : 'fail'}</Badge>
    </div>
  );
}

export default function ChatPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ChatStatus | null | undefined>(undefined);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowWrite, setAllowWrite] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  // On open: probe status; the session write opt-in always resets to off.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setStatus(undefined);
    setAllowWrite(false);
    setError(null);
    void getChatStatus()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch((err: Error) => {
        if (!live) return;
        setStatus(null);
        setError(`Chat status could not be loaded: ${err.message}`);
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Auto-scroll the message region to the newest entry.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, status]);

  const configured = Boolean(status?.configured.mcp && status?.configured.llm);

  const send = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    setError(null);
    const next: PanelMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setDraft('');
    setPending(true);
    const res = await postChat(
      next.map((m) => ({ role: m.role, content: m.content })),
      allowWrite,
    );
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessages([...next, { role: 'assistant', content: res.reply, transcript: res.transcript }]);
  };

  const description =
    status?.writeMode != null
      ? `centralmcp · ${status.writeMode ? 'read + write tools' : 'read-only tools'}`
      : 'centralmcp';

  return (
    <Drawer open={open} onOpenChange={onOpenChange} width="lg" title="Assistant" description={description}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* panel header: live status + per-session write opt-in */}
        {status ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              paddingBottom: 12,
              borderBottom: '1px solid var(--nd-border-subtle)',
            }}
          >
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
            {status.writeMode ? (
              <span style={{ marginLeft: 'auto' }}>
                <Switch
                  size="sm"
                  checked={allowWrite}
                  onCheckedChange={setAllowWrite}
                  label="allow writes this session"
                />
              </span>
            ) : null}
          </div>
        ) : null}

        {/* message stream */}
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 0' }}>
          {status === undefined ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
              <Spinner size="md" />
            </div>
          ) : !configured ? (
            <EmptyState
              title="The assistant is not configured"
              description={
                status === null
                  ? 'The portal backend is offline — the assistant needs it to reach centralmcp.'
                  : 'Configure MCP + LLM in Connected systems → Assistant.'
              }
            >
              <div style={{ marginTop: 14 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    navigate('/systems');
                  }}
                >
                  Connected systems → Assistant ▸
                </Button>
              </div>
            </EmptyState>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {messages.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div
                      style={{
                        maxWidth: '85%',
                        background: 'var(--nd-bg-raised)',
                        borderRadius: 'var(--nd-radius-lg)',
                        padding: '8px 12px',
                        fontSize: 'var(--nd-text-12)',
                        lineHeight: 1.5,
                        color: 'var(--nd-text-primary)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {m.transcript?.map((t, j) => <TranscriptRow key={j} entry={t} />)}
                    <AssistantText content={m.content} />
                  </div>
                ),
              )}
              {pending ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Spinner size="sm" />
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10.5,
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    working…
                  </span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {error ? (
          <div style={{ paddingBottom: 10 }}>
            <Alert tone="danger" title="Chat failed" dismissible onDismiss={() => setError(null)}>
              <span style={{ fontSize: 13 }}>{error}</span>
            </Alert>
          </div>
        ) : null}

        {/* composer */}
        {configured ? (
          <div
            style={{
              display: 'flex',
              gap: 8,
              paddingTop: 12,
              borderTop: '1px solid var(--nd-border-subtle)',
            }}
          >
            <div ref={composerRef} style={{ flex: 1, minWidth: 0 }}>
              <Input
                mono
                value={draft}
                placeholder="Ask about the estate…"
                aria-label="Message the assistant"
                disabled={pending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
            </div>
            <Button
              variant="primary"
              size="md"
              disabled={pending || draft.trim().length === 0}
              onClick={() => void send()}
            >
              Send
            </Button>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
