/**
 * web/src/screens/ChatPanel.tsx — the assistant chat drawer.
 *
 * Right-side Drawer (width="lg"), opened from the shell topbar ("Assistant ⌘J")
 * or the ⌘J shortcut; state lives in AppShell. On open it probes
 * GET /api/chat/status: unconfigured → honest EmptyState pointing at
 * Connected systems → Assistant. Messages POST to /api/chat; the reply's tool
 * transcript renders as hairline rows ([mono tool | args | preview | ok/fail
 * Badge]) between messages. When the server's chatWriteMode is on, a Switch
 * in the panel header shows the persisted lab read/write state. User messages
 * are right-aligned bg-raised bubbles; assistant
 * replies are plain prose with code-ish lines in mono.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Drawer, EmptyState, Input, Skeleton, Text } from '../nightdesk';
import { getChatStatus, postChat } from '../api/client';
import type { ChatStatus, ChatTranscriptEntry } from '../api/client';

interface PanelMessage {
  role: 'user' | 'assistant';
  content: string;
  transcript?: ChatTranscriptEntry[];
  /**
   * A user turn the assistant never answered. The turn stays in the stream —
   * hiding what was asked would be its own kind of lie — but it is labelled,
   * because the error banner is cleared by the next send and what remains
   * otherwise reads as a question the assistant simply ignored.
   */
  failed?: true;
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
  /* Fenced blocks render in mono. The fence is walking state over the lines,
     so the rows are built in a plain loop — reassigning a captured variable
     inside a .map callback trips the compiler's immutability rule. */
  const rows: ReactNode[] = [];
  let fence = false;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith('```')) {
      fence = !fence;
      continue;
    }
    if (line.trim() === '') {
      rows.push(<div key={i} className="nt-bar-track nt-bar-h-6" />);
      continue;
    }
    const mono = fence || codeish(line);
    rows.push(
      <Text
        key={i}
        size={mono ? 11 : 12}
        mono={mono}
        tone={mono ? 'secondary' : 'primary'}
        className="nt-chat-body"
      >
        {line}
      </Text>,
    );
  }
  return (
    <div className="nt-chat-bubble nt-chat-bubble--assistant nt-stack nt-gap-2" data-role="assistant">
      {rows}
    </div>
  );
}

function TranscriptRow({ entry }: { entry: ChatTranscriptEntry }) {
  return (
    <div className="nt-chat-tool-row" data-ok={entry.ok ? 'true' : 'false'}>
      <span className="nt-chat-tool-row__tool">{entry.tool}</span>
      <span className="nt-chat-tool-row__args">{entry.args}</span>
      <span title={entry.resultPreview} className="nt-chat-tool-row__result">
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  // On open, discard the prior status/error before the fresh probe returns.
  // The reset runs during render so an already-open panel never commits one
  // frame of the previous session's state; the probe stays an effect — it is
  // the external read.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setStatus(undefined);
      setError(null);
    }
  }
  useEffect(() => {
    if (!open) return;
    let live = true;
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
    /* Turns that were never answered are not conversation. Replaying one puts
     * two user turns back to back with nothing between them, which is not what
     * the operator asked and not a shape the model should be handed. */
    const history = messages.filter((m) => !m.failed);
    const next: PanelMessage[] = [...history, { role: 'user', content: text }];
    setMessages(next);
    setDraft('');
    setPending(true);
    const res = await postChat(next.map((m) => ({ role: m.role, content: m.content })));
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      setMessages([...history, { role: 'user', content: text, failed: true }]);
      /* Give the question back so it can be sent again. Retrying a failed
       * request should not mean retyping it off the screen. Safe to overwrite
       * unconditionally: the composer is disabled for the whole request, so
       * there is nothing else in it to lose. */
      setDraft(text);
      return;
    }
    setMessages([...next, { role: 'assistant', content: res.reply, transcript: res.transcript }]);
  };

  const description =
    status?.writeMode != null
      ? `centralmcp · ${status.writeMode === 'enabled' ? 'lab read/write' : 'read-only'}`
      : 'centralmcp';

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title="Assistant"
      description={description}
      className={
        status?.writeMode === 'enabled'
          ? 'nd-drawer--write-ritual nt-write-ritual nt-chat-drawer nt-drawer-cinema'
          : 'nt-chat-drawer nt-drawer-cinema'
      }
      dataPhase={status?.writeMode === 'enabled' ? 'review' : undefined}
    >
      <div className="nt-chat-col nt-chat-shell nt-section-panel">
        <div className="nt-plane-theater" role="note">HPE Network Tools · brokered assistant · tools · write-aware</div>
        <div className="nt-status-ribbon nt-chat-ribbon" role="status" aria-label="Assistant status ribbon">
          <span className="nt-status-ribbon__item">assistant · tools</span>
          <span className="nt-status-ribbon__item">write-aware · gated</span>
          <span className="nt-status-ribbon__item">MCP path</span>
        </div>
        <div className="nt-shift-meta nt-mono nt-fs-11" role="note">
          HPE Network Tools · assistant lane · {status?.writeMode === 'enabled' ? 'lab write armed' : 'read-only by default'}
        </div>
        {/* panel header: live provider/MCP status plus saved lab access. */}
        {status ? (
          <div
            className="nt-filter-bar nt-gap-8 nt-chat-head-rule"
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
            {status.activeProvider ? <Badge tone="neutral">{status.activeProvider}</Badge> : null}
            <span className="nt-ml-auto">
              <Badge tone={status.writeMode === 'enabled' ? 'success' : 'neutral'}>
                {status.writeMode === 'enabled' ? 'LAB R/W' : 'READ ONLY'}
              </Badge>
            </span>
          </div>
        ) : null}

        {/* message stream */}
        <div ref={scrollRef} className="nt-chat-scroll">
          {status === undefined ? (
            <div className="nt-center-pad-64" role="status" aria-label="Loading assistant">
              <div className="nt-stack nt-gap-8">
                <Skeleton height={14} width="42%" />
                <Skeleton height={48} />
                <Skeleton height={48} />
              </div>
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
              <div className="nt-mt-14">
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
            <div className="nt-stack nt-gap-14">
              {messages.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="nt-end">
                    <div className="nt-chat-bubble nt-chat-bubble--user" data-role="user">
                      {m.content}
                      {m.failed ? (
                        <div
                          className="nt-hint-muted nt-danger-text nt-mt-4"
                        >
                          NOT ANSWERED — SEND AGAIN TO ASK IT
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="nt-stack nt-gap-6">
                    {m.transcript?.map((t, j) => <TranscriptRow key={j} entry={t} />)}
                    <AssistantText content={m.content} />
                  </div>
                ),
              )}
              {pending ? (
                <div className="nt-chat-pending" aria-live="polite" aria-busy="true">
                  <span className="nt-chat-pending__pulse" aria-hidden />
                  <div className="nt-chat-pending__stack">
                    <Skeleton height={10} width="42%" />
                    <Skeleton height={10} width="68%" />
                    <Skeleton height={10} width="54%" />
                  </div>
                  <span className="nt-hint-muted nt-chat-pending__label">HPE Network Tools · working…</span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {error ? (
          <div className="nt-pb-10">
            <Alert tone="danger" title="Chat failed" dismissible onDismiss={() => setError(null)}>
              <span className="nt-fs-13">{error}</span>
            </Alert>
          </div>
        ) : null}

        {/* composer */}
        {configured ? (
          <div
            className="nt-chat-composer"
          >
            <div ref={composerRef} className="nt-flex-1">
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
