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
    <div className="nt-term">
      <div className="nt-term__section-head">
        <span className="nd-micro-label nt-micro-label">{sectionTitle}</span>
        <span className="nt-term__section-meta">{sectionMeta}</span>
      </div>

      <div className="nt-term__frame">
        <div className="nt-term__titlebar">
          <span
            className="nt-term__dot"
            data-online={online ? 'true' : 'false'}
            aria-hidden
          />
          <span className="nt-term__title">{titlebar}</span>
          <span className="nt-term__title-right">{titlebarRight}</span>
        </div>

        <div ref={scrollRef} className="nt-term__scroll">
          {buffer.map((l, i) => (
            <div key={i} className="nt-term__line" data-tone={l.tone}>
              {l.text}
            </div>
          ))}
          {canShell ? (
            <div className="nt-term__prompt-row">
              <span className="nt-term__prompt">{prompt}</span>
              <input
                type="text"
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit(cmd);
                }}
                placeholder="type a command — try: show version"
                aria-label="Terminal input"
                className="nt-term__input"
              />
            </div>
          ) : null}
        </div>

        {canShell ? (
          <div className="nt-term__chips">
            {quickCommands.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => submit(c)}
                className="nt-term__chip"
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
              className="nt-term__clear"
            >
              clear
            </button>
          </div>
        ) : null}
      </div>

      {readOnlyNote ? (
        <Alert tone="info" title="No local shell on this device">
          <span className="nt-fs-13">{readOnlyNote}</span>
        </Alert>
      ) : null}
    </div>
  );
}
