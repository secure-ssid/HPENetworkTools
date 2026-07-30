/**
 * web/src/lib/TerminalPane.tsx — the "Local terminal" panel from
 * design/NtDeviceDetail.dc.html: a canned shell on --nd-bg-inset with a
 * titlebar (status dot, mono session line, mono right note), a 352px
 * auto-scrolling transcript, a live prompt input, quick-command chips and a
 * `clear` affordance. Enter submits; the prompt line echoes in copper;
 * responses append; `clear` resets the buffer to the session banner.
 *
 * The pane never talks to the response logic directly — it goes through a
 * TerminalTransport ({ banner, respond }), so a recorded WebSocket/SSH
 * backend can replace the canned demo transport later without touching the
 * pane. respond() returns null as the clear sentinel (reset to banner()).
 *
 * Cloud-claimed devices (readOnlyNote set) get no input and no chips: the
 * transcript is static and an info Alert explains the remote-shell request.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '../nightdesk';
import { terminalBanner, terminalRespond } from '@hpe/shared';
import type { DeviceProfile, TerminalLine } from '@hpe/shared';

/** The seam between the pane and whatever serves the shell session. */
export interface TerminalTransport {
  /** Session banner lines — also what `clear` resets the buffer to. */
  banner(): TerminalLine[];
  /** Lines to append for one submitted command; null = clear sentinel. */
  respond(cmd: string): TerminalLine[] | null;
  /**
   * Optional async path (the recorded-SSH WebSocket transport). When present
   * the pane awaits it instead of calling respond(); same null clear
   * sentinel. The sync path above is untouched for the canned transport.
   */
  respondAsync?(cmd: string): Promise<TerminalLine[] | null>;
}

/**
 * The demo transport: the prototype's canned responder from shared/logic.ts
 * (covers '?' help, prefix ambiguity, platform parse errors, clear→null).
 */
export function createCannedTransport(profile: Pick<DeviceProfile, 'kind'>): TerminalTransport {
  return {
    banner: () => terminalBanner(profile.kind),
    respond: (cmd) => terminalRespond(profile, cmd),
  };
}

const LINE_COLORS: Record<TerminalLine['tone'], string> = {
  in: 'var(--nd-accent-text)',
  body: 'var(--nd-text-secondary)',
  muted: 'var(--nd-text-muted)',
  warn: 'var(--nd-warning)',
};

export function TerminalPane({
  transport,
  prompt,
  forName,
  sectionTitle,
  sectionMeta,
  titlebar,
  titlebarRight,
  online,
  quickCommands,
  readOnlyNote,
}: {
  transport: TerminalTransport;
  prompt: string; // shell prompt, e.g. 'sw-core-a#' ('' when there is no shell)
  forName: string; // device name — the buffer resets whenever it changes
  sectionTitle: string; // 'Local terminal' | 'Read-only telemetry'
  sectionMeta: string; // 'SESSION RECORDED' | 'CLOUD-CLAIMED DEVICE'
  titlebar: string; // 'ssh r.okafor@10.42.8.11 — via collector' | 'no shell — MIST owns this device'
  titlebarRight: string; // 'AES-256 · idle 14:52' | 'request remote shell ↗'
  online: boolean; // titlebar dot: live session vs. grey (no shell)
  quickCommands: string[]; // chips; pass [] when the device has no shell
  readOnlyNote?: string; // set → info Alert replaces input + chips
}) {
  const canShell = !readOnlyNote;
  const [lines, setLines] = useState<TerminalLine[] | null>(null);
  const [cmd, setCmd] = useState('');
  // Track forName: switching device resets the buffer to the new banner.
  const [prevFor, setPrevFor] = useState(forName);
  if (prevFor !== forName) {
    setPrevFor(forName);
    setLines(null);
    setCmd('');
  }

  const banner = useMemo(() => transport.banner(), [transport]);
  const buffer = lines ?? banner;

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buffer]);

  const submit = (text: string) => {
    if (text.trim() === '') {
      setCmd('');
      return;
    }
    // Async transports (recorded SSH over WebSocket): echo immediately in
    // copper, append the streamed output when it resolves; null still resets.
    const respondAsync = transport.respondAsync;
    if (respondAsync) {
      setLines([...buffer, { text: prompt + ' ' + text, tone: 'in' }]);
      setCmd('');
      void respondAsync
        .call(transport, text)
        .then((resp) => {
          if (resp === null) {
            setLines(transport.banner());
            return;
          }
          setLines((prev) => [...(prev ?? transport.banner()), ...resp, { text: '', tone: 'muted' as const }]);
        })
        .catch(() => {
          // The ws transport resolves warn lines instead of rejecting; this is
          // the safety net so a rejection can never escape unhandled.
          setLines((prev) => [
            ...(prev ?? transport.banner()),
            { text: '% transport error — session out of sync; close and reopen the session', tone: 'warn' as const },
          ]);
        });
      return;
    }
    const resp = transport.respond(text);
    if (resp === null) {
      setLines(transport.banner());
      setCmd('');
      return;
    }
    setLines([...buffer, { text: prompt + ' ' + text, tone: 'in' }, ...resp, { text: '', tone: 'muted' }]);
    setCmd('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          paddingBottom: 8,
          borderBottom: '1px solid var(--nd-border-default)',
        }}
      >
        <span className="nd-micro-label">{sectionTitle}</span>
        <span
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            color: 'var(--nd-text-muted)',
          }}
        >
          {sectionMeta}
        </span>
      </div>

      <div
        style={{
          background: 'var(--nd-bg-inset)',
          border: '1px solid var(--nd-border-default)',
          borderRadius: 'var(--nd-radius-md)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--nd-border-subtle)',
            background: 'var(--nd-bg-surface)',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 99,
              background: online ? 'var(--nd-success)' : 'var(--nd-border-strong)',
              flex: '0 0 7px',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 10.5,
              color: 'var(--nd-text-secondary)',
            }}
          >
            {titlebar}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              color: 'var(--nd-text-muted)',
            }}
          >
            {titlebarRight}
          </span>
        </div>

        <div
          ref={scrollRef}
          style={{
            height: 352,
            overflow: 'auto',
            padding: '12px 14px',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 11.5,
            lineHeight: 1.65,
          }}
        >
          {buffer.map((l, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap', color: LINE_COLORS[l.tone] }}>
              {l.text}
            </div>
          ))}
          {canShell ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 2 }}>
              <span style={{ color: 'var(--nd-accent-text)' }}>{prompt}</span>
              <input
                type="text"
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit(cmd);
                }}
                placeholder="type a command — try: show version"
                aria-label="Terminal input"
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--nd-text-primary)',
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 11.5,
                }}
              />
            </div>
          ) : null}
        </div>

        {canShell ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderTop: '1px solid var(--nd-border-subtle)',
              background: 'var(--nd-bg-surface)',
              flexWrap: 'wrap',
            }}
          >
            {quickCommands.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => submit(c)}
                style={{
                  background: 'var(--nd-bg-raised)',
                  border: '1px solid var(--nd-border-subtle)',
                  borderRadius: 'var(--nd-radius-sm)',
                  padding: '3px 8px',
                  cursor: 'pointer',
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 10.5,
                  color: 'var(--nd-text-secondary)',
                }}
              >
                {c}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setLines(transport.banner());
                setCmd('');
              }}
              style={{
                marginLeft: 'auto',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 10.5,
                color: 'var(--nd-text-muted)',
              }}
            >
              clear
            </button>
          </div>
        ) : null}
      </div>

      {readOnlyNote ? (
        <Alert tone="info" title="No local shell on this device">
          <span style={{ fontSize: 13 }}>{readOnlyNote}</span>
        </Alert>
      ) : null}
    </div>
  );
}
