/**
 * web/src/lib/wsTerminal.test.ts — unit tests for the live terminal transport.
 * A FakeWebSocket captures send() calls and lets each test push server frames
 * through the onmessage handler the transport registers.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createWsTransport } from './wsTerminal';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  readyState = 0;
  closed = false;
  throwOnSend = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.throwOnSend) throw new Error('socket is mid-close');
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  // Test drivers -------------------------------------------------------------
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }

  disconnect(): void {
    this.readyState = 3;
    this.closed = true;
    this.onclose?.();
  }

  sentFrames(): unknown[] {
    return this.sent.map((d) => JSON.parse(d));
  }
}

function lastSocket(): FakeWebSocket {
  const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!sock) throw new Error('no FakeWebSocket was constructed');
  return sock;
}

function setup(): void {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

/** Drives connect() to a ready session: open handshake + ready frame. */
async function connectReady(url = 'ws://test/terminal/sw1'): Promise<ReturnType<typeof createWsTransport>> {
  const session = createWsTransport('sw1', { url });
  const p = session.connect();
  const sock = lastSocket();
  sock.open();
  expect(sock.sentFrames()).toEqual([{ type: 'open' }]);
  sock.emit({ type: 'ready', prompt: 'sw1#' });
  await expect(p).resolves.toBe(true);
  return session;
}

describe('createWsTransport — happy path', () => {
  it('open → banner/ready → cmd echoes out frames → end resolves with collected output', async () => {
    setup();
    const session = createWsTransport('sw1', { url: 'ws://test/terminal/sw1' });
    const p = session.connect();
    const sock = lastSocket();
    sock.open();
    sock.emit({ type: 'banner', lines: ['Recorded session for sw1', 'All commands are logged'] });
    sock.emit({ type: 'ready', prompt: 'sw1#' });
    await expect(p).resolves.toBe(true);

    expect(session.transport.banner()).toEqual([
      { text: 'Recorded session for sw1', tone: 'muted' },
      { text: 'All commands are logged', tone: 'muted' },
    ]);

    const cmd = session.transport.respondAsync('show version');
    // respondAsync serialises through the one-deep queue — flush the microtask
    // so sendCommand has actually run (and the frame left the socket).
    await Promise.resolve();
    expect(sock.sentFrames()).toEqual([
      { type: 'open' },
      { type: 'cmd', cmd: 'show version' },
    ]);
    sock.emit({ type: 'out', text: 'ArubaOS-CX GL.10.10.0001' });
    sock.emit({ type: 'out', text: 'uptime: 42 days' });
    sock.emit({ type: 'warn', text: 'fan 2 degraded' });
    sock.emit({ type: 'end' });

    await expect(cmd).resolves.toEqual([
      { text: 'ArubaOS-CX GL.10.10.0001', tone: 'body' },
      { text: 'uptime: 42 days', tone: 'body' },
      { text: 'fan 2 degraded', tone: 'warn' },
    ]);
  });

  it("treats 'clear' as the local null sentinel without touching the socket", async () => {
    setup();
    const session = await connectReady();
    const sentBefore = lastSocket().sent.length;
    await expect(session.transport.respondAsync('clear')).resolves.toBeNull();
    expect(lastSocket().sent.length).toBe(sentBefore);
  });

  it('ignores empty input locally without touching the socket', async () => {
    setup();
    const session = await connectReady();
    const sentBefore = lastSocket().sent.length;
    await expect(session.transport.respondAsync('   ')).resolves.toEqual([]);
    expect(lastSocket().sent.length).toBe(sentBefore);
  });
});

describe('createWsTransport — opening lifecycle', () => {
  it('allows a valid ready frame at 10 seconds and times out at the bounded 12-second default', async () => {
    setup();
    vi.useFakeTimers();

    const valid = createWsTransport('sw1', { url: 'ws://test/terminal/sw1' });
    const validConnect = valid.connect();
    const validSocket = lastSocket();
    validSocket.open();
    await vi.advanceTimersByTimeAsync(10_000);
    validSocket.emit({ type: 'ready', prompt: 'real-sw1#' });
    await expect(validConnect).resolves.toBe(true);

    const late = createWsTransport('sw2', { url: 'ws://test/terminal/sw2' });
    const lateConnect = late.connect();
    const lateSocket = lastSocket();
    lateSocket.open();
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(lateConnect).resolves.toBe(false);
    expect(lateSocket.closed).toBe(true);
  });

  it('exposes ready and subsequent prompts', async () => {
    setup();
    const prompts: string[] = [];
    const session = createWsTransport('sw1', {
      url: 'ws://test/terminal/sw1',
      onPrompt: (prompt) => prompts.push(prompt),
    });
    const connected = session.connect();
    const sock = lastSocket();
    sock.open();
    sock.emit({ type: 'ready', prompt: 'real-sw1#' });
    await expect(connected).resolves.toBe(true);

    const cmd = session.transport.respondAsync('show version');
    await Promise.resolve();
    sock.emit({ type: 'end', prompt: 'real-sw1>' });
    await expect(cmd).resolves.toEqual([]);
    expect(prompts).toEqual(['real-sw1#', 'real-sw1>']);
  });
});

describe('createWsTransport — command timeout', () => {
  it('marks the transport dead, resolves honestly, and ignores the stale end frame', async () => {
    setup();
    vi.useFakeTimers();
    const session = createWsTransport('sw1', { url: 'ws://test/terminal/sw1', commandTimeoutMs: 1000 });
    const p = session.connect();
    const sock = lastSocket();
    sock.open();
    sock.emit({ type: 'ready', prompt: 'sw1#' });
    await expect(p).resolves.toBe(true);

    const cmd = session.transport.respondAsync('show run');
    // Flush the queue microtask so sendCommand has set `pending` before we
    // push frames / advance the clock.
    await Promise.resolve();
    sock.emit({ type: 'out', text: 'partial output before the hang' });
    // No 'end' frame within commandTimeoutMs → session is out of sync.
    await vi.advanceTimersByTimeAsync(1000);

    await expect(cmd).resolves.toEqual([
      { text: 'partial output before the hang', tone: 'body' },
      {
        text: '% no prompt seen — session out of sync; close and reopen the session',
        tone: 'warn',
      },
    ]);

    // The stale 'end' frame arriving later must NOT resolve anything new —
    // there is no pending command for it to swallow.
    const next = session.transport.respondAsync('show version');
    sock.emit({ type: 'end' });
    await expect(next).resolves.toEqual([
      {
        text: '% session not connected — no prompt seen — session out of sync; close and reopen the session',
        tone: 'warn',
      },
    ]);
  });
});

describe('createWsTransport — send throws mid-close', () => {
  it('is caught and resolves with a warn line — no rejection escapes', async () => {
    setup();
    const session = await connectReady();
    const sock = lastSocket();
    sock.throwOnSend = true;

    const cmd = session.transport.respondAsync('show run');
    await expect(cmd).resolves.toEqual([
      {
        text: '% send failed — session out of sync; close and reopen the session',
        tone: 'warn',
      },
    ]);

    // The transport is dead from here on; the next command fails honestly.
    await expect(session.transport.respondAsync('show version')).resolves.toEqual([
      {
        text: '% session not connected — send failed — session out of sync; close and reopen the session',
        tone: 'warn',
      },
    ]);
  });
});

describe('createWsTransport — closing lifecycle', () => {
  it('resolves a pending command and reports one post-ready disconnect', async () => {
    setup();
    const disconnects: string[] = [];
    const session = createWsTransport('sw1', {
      url: 'ws://test/terminal/sw1',
      onDisconnect: (reason) => disconnects.push(reason),
    });
    const connected = session.connect();
    const sock = lastSocket();
    sock.open();
    sock.emit({ type: 'ready', prompt: 'sw1#' });
    await expect(connected).resolves.toBe(true);

    const cmd = session.transport.respondAsync('show run');
    await Promise.resolve();
    sock.emit({ type: 'out', text: 'partial output' });
    session.close();

    await expect(cmd).resolves.toEqual([
      { text: 'partial output', tone: 'body' },
      { text: '% session closed', tone: 'warn' },
    ]);
    expect(disconnects).toEqual(['session closed']);
    expect(sock.closed).toBe(true);
  });

  it('reports a remote post-ready close once and leaves later commands honest', async () => {
    setup();
    const disconnects: string[] = [];
    const session = createWsTransport('sw1', {
      url: 'ws://test/terminal/sw1',
      onDisconnect: (reason) => disconnects.push(reason),
    });
    const connected = session.connect();
    const sock = lastSocket();
    sock.open();
    sock.emit({ type: 'ready', prompt: 'sw1#' });
    await expect(connected).resolves.toBe(true);

    sock.disconnect();
    sock.onclose?.();

    expect(disconnects).toEqual(['connection closed']);
    await expect(session.transport.respondAsync('show version')).resolves.toEqual([
      { text: '% session not connected — connection closed', tone: 'warn' },
    ]);
  });
});
