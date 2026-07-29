/**
 * web/src/lib/wsTerminal.ts — the live terminal transport: a TerminalTransport
 * backed by the recorded SSH bridge (server/src/services/terminal.ts) instead
 * of the canned responder.
 *
 * createWsTransport(name, identity) returns { transport, connect, close }:
 *   connect()  opens /api/terminal/:name with plane+serial when available,
 *              sends {type:'open'}
 *              and resolves true only once the server reports {type:'ready'}
 *              (SSH up, shell live, prompt seen) — false on any failure or
 *              timeout, in which case DeviceDetail falls back to the canned
 *              transport exactly as before.
 *   transport  implements TerminalTransport plus respondAsync(cmd), which the
 *              pane prefers when present (TerminalPane checks for it). Output
 *              lines arrive as {type:'out'} frames and resolve into
 *              TerminalLine[] when {type:'end'} marks the prompt's return;
 *              {type:'warn'} lines render amber, matching the canned look
 *              (out → text-secondary, warn → amber, echo → copper in the pane).
 *   close()    hangs the session up (device switch / unmount).
 *
 * The 'ready' frame also names the session the bridge recorded (SSH user,
 * resolved target, jump host, shell-path provenance note); onSession reports it
 * so the owner attributes the pane from the socket itself instead of matching a
 * recorded-sessions poll by timestamp.
 *
 * Commands are serialised through a one-deep queue so the server never sees a
 * second command while one is in flight. `clear` is handled locally as the
 * null sentinel (pane resets to the banner), exactly like the canned path.
 */

import type { TerminalLine } from '../../../shared';
import type { TerminalTransport } from './TerminalPane';
import type { DeviceDetailIdentity } from '../api/client';

/** A transport that answers asynchronously — the pane prefers this when set. */
export interface AsyncTerminalTransport extends TerminalTransport {
  respondAsync(cmd: string): Promise<TerminalLine[] | null>;
}

/**
 * Who the server says this session actually is, taken from the 'ready' frame —
 * the same identity the recording on disk carries. The owner uses it instead of
 * guessing from the recorded-sessions list (which lags the socket by a poll),
 * so the titlebar never attributes a session to the wrong operator.
 *
 *   user    the SSH username the bridge authenticated with (never a secret)
 *   target  the address actually dialled — a live management IP, not a fixture
 *   via     the jump host the session was tunnelled through, or null for direct
 *   note    the shell-path provenance line ('<PLANE> reports no portal shell
 *           path …') when the claiming plane disclaims the path, else null.
 *           It is also the banner's third line; as a field it can be styled as
 *           a notice rather than string-matched out of the banner.
 */
export interface TerminalSessionIdentity {
  user: string;
  target: string;
  via: string | null;
  note: string | null;
}

export interface WsTerminalOptions {
  /** Full ws(s):// URL override (tests / non-standard mounts). */
  url?: string;
  /** How long connect() waits for the server 'ready' frame. Default 12000ms. */
  readyTimeoutMs?: number;
  /** Safety net for one command if no 'end' frame ever arrives. Default 30s. */
  commandTimeoutMs?: number;
  /** Reports the real prompt whenever the server observes it. */
  onPrompt?(prompt: string): void;
  /** Reports the recorded session's identity once, from the 'ready' frame.
   *  Not called when the server names neither user nor target — an older
   *  bridge that only sends `prompt` leaves the owner with nothing to claim
   *  rather than a fabricated operator. */
  onSession?(session: TerminalSessionIdentity): void;
  /** Reports a post-ready disconnect once so owners can offer reconnect. */
  onDisconnect?(reason: string): void;
}

type ServerFrame =
  | { type: 'banner'; lines: string[] }
  // user/target/via/note are additive: a bridge that predates them sends the
  // prompt alone, and the transport reports no session rather than inventing
  // one (see onSession).
  | { type: 'ready'; prompt: string; user?: string; target?: string; via?: string | null; note?: string | null }
  | { type: 'out'; text: string }
  | { type: 'warn'; text: string }
  | { type: 'end'; prompt?: string }
  | { type: 'closed'; reason?: string }
  | { type: 'error'; message?: string };

const CONNECTING_LINES: TerminalLine[] = [
  { text: 'opening recorded SSH session via the portal collector …', tone: 'muted' },
  { text: '', tone: 'muted' },
];

type WsTerminalSession = {
  transport: AsyncTerminalTransport;
  connect(): Promise<boolean>;
  close(): void;
};

export function createWsTransport(name: string, opts?: WsTerminalOptions): WsTerminalSession;
export function createWsTransport(
  name: string,
  identity: DeviceDetailIdentity,
  opts?: WsTerminalOptions,
): WsTerminalSession;
export function createWsTransport(
  name: string,
  identityOrOpts: DeviceDetailIdentity | WsTerminalOptions = {},
  explicitOpts?: WsTerminalOptions,
): WsTerminalSession {
  const oldStyle = explicitOpts === undefined && (
    'url' in identityOrOpts ||
    'readyTimeoutMs' in identityOrOpts ||
    'commandTimeoutMs' in identityOrOpts ||
    'onPrompt' in identityOrOpts ||
    'onSession' in identityOrOpts ||
    'onDisconnect' in identityOrOpts
  );
  const identity = oldStyle ? {} : identityOrOpts as DeviceDetailIdentity;
  const opts = oldStyle ? identityOrOpts as WsTerminalOptions : explicitOpts ?? {};
  const params = new URLSearchParams();
  if (identity.plane && identity.serial) {
    params.set('plane', identity.plane);
    params.set('serial', identity.serial);
  }
  const query = params.toString();
  const url =
    opts.url ??
    `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/terminal/${encodeURIComponent(name)}${query ? `?${query}` : ''}`;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 12_000;
  const commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;

  let ws: WebSocket | null = null;
  let bannerLines: TerminalLine[] = CONNECTING_LINES;
  let ready = false;
  let everReady = false;
  let dead = false;
  let deadReason: string | null = null;
  let disconnectNotified = false;
  let sessionNotified = false;

  interface Pending {
    lines: TerminalLine[];
    resolve(lines: TerminalLine[]): void;
    timer: ReturnType<typeof setTimeout>;
  }
  let pending: Pending | null = null;
  // One command at a time — the server refuses concurrent commands, and a
  // serial queue keeps the transcript in submission order.
  let queue: Promise<unknown> = Promise.resolve();

  const finishPending = (): void => {
    const p = pending;
    pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.resolve(p.lines);
    }
  };

  const markDead = (reason: string): void => {
    if (dead) return;
    dead = true;
    ready = false;
    deadReason = reason;
    if (pending) {
      pending.lines.push({ text: `% ${reason}`, tone: 'warn' });
      finishPending();
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    if (everReady && !disconnectNotified) {
      disconnectNotified = true;
      opts.onDisconnect?.(reason);
    }
  };

  const sendCommand = (cmd: string): Promise<TerminalLine[]> => {
    const sock = ws;
    if (!sock || dead || !ready) {
      return Promise.resolve([{ text: `% session not connected${deadReason ? ` — ${deadReason}` : ''}`, tone: 'warn' }]);
    }
    return new Promise<TerminalLine[]>((resolve) => {
      // No 'end' within the window means the server still thinks the command
      // is running — the session is out of sync from here on, so mark the
      // transport dead rather than let the next command be swallowed by the
      // stale 'end' frame. The pane offers a fresh session on reconnect.
      const timer = setTimeout(() => {
        markDead('no prompt seen — session out of sync; close and reopen the session');
      }, commandTimeoutMs);
      pending = { lines: [], resolve, timer };
      try {
        sock.send(JSON.stringify({ type: 'cmd', cmd }));
      } catch {
        // Mid-close socket: never let a send throw escape the executor.
        markDead('send failed — session out of sync; close and reopen the session');
      }
    });
  };

  const transport: AsyncTerminalTransport = {
    banner: () => bannerLines,
    // Sync path is never used: the pane prefers respondAsync when present.
    respond: () => [],
    respondAsync: (cmd: string) => {
      if (cmd.trim() === 'clear') return Promise.resolve(null); // clear sentinel, like the canned path
      if (cmd.trim() === '') return Promise.resolve([]);
      const result = queue.then(() => sendCommand(cmd));
      queue = result.catch(() => undefined);
      return result;
    },
  };

  function onMessage(ev: MessageEvent<string>): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(ev.data) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'banner':
        bannerLines = frame.lines.map((text) => ({ text, tone: 'muted' as const }));
        break;
      case 'ready': {
        ready = true;
        everReady = true;
        opts.onPrompt?.(frame.prompt);
        // Attribution, once, and only when the server actually named the
        // session: honesty rule — an unnamed session gets no operator, not a
        // placeholder one.
        if (typeof frame.user === 'string' && typeof frame.target === 'string' && !sessionNotified) {
          sessionNotified = true;
          opts.onSession?.({
            user: frame.user,
            target: frame.target,
            via: typeof frame.via === 'string' ? frame.via : null,
            note: typeof frame.note === 'string' ? frame.note : null,
          });
        }
        break;
      }
      case 'out':
        pending?.lines.push({ text: frame.text, tone: 'body' });
        break;
      case 'warn':
        pending?.lines.push({ text: frame.text, tone: 'warn' });
        break;
      case 'end':
        if (frame.prompt) opts.onPrompt?.(frame.prompt);
        finishPending();
        break;
      case 'error':
        markDead(frame.message ?? 'session error');
        break;
      case 'closed':
        markDead(frame.reason ?? 'session closed');
        break;
    }
  }

  function connect(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        }
      };
      const timer = setTimeout(() => {
        markDead('connection timed out');
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        done(false);
      }, readyTimeoutMs);

      try {
        ws = new WebSocket(url);
      } catch {
        done(false);
        return;
      }
      ws.onopen = () => {
        try {
          ws?.send(JSON.stringify({ type: 'open' }));
        } catch {
          markDead('connection open failed');
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
          done(false);
        }
      };
      ws.onmessage = (ev: MessageEvent<string>) => {
        onMessage(ev);
        if (ready) done(true);
        if (dead) done(false);
      };
      ws.onerror = () => {
        markDead('connection error');
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        done(false);
      };
      ws.onclose = () => {
        markDead('connection closed');
        done(false);
      };
    });
  }

  function close(): void {
    const sock = ws;
    try {
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'close' }));
      }
    } catch {
      /* ignore */
    }
    markDead('session closed');
    try {
      sock?.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  return { transport, connect, close };
}
