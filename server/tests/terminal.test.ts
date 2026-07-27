/**
 * server/tests/terminal.test.ts — the recorded-SSH terminal's pure surface.
 *
 * No live SSH here: the matrix covers the read-only allow-list (allowCommand),
 * the WebSocket frame parser (parseClientFrame), the shell-scraping helpers
 * (stripAnsi / looksLikePrompt / ShellScraper) and session listing. The local-
 * plane credential round-trip is checked against a tmp settings file so the
 * real data/settings.json is never touched. Session-open behaviour (live-mode
 * target resolution, recorder failure) is driven through a fake WebSocket and
 * a fake SSH client via TerminalManager's injected demoMode / liveDevices /
 * creds / connect seams — still no network.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'ssh2';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCKED_LINE,
  MAX_TRANSCRIPT_EVENTS,
  ShellScraper,
  TerminalManager,
  allowCommand,
  looksLikePrompt,
  parseClientFrame,
  stripAnsi,
} from '../src/services/terminal';
import { SettingsStore } from '../src/config/settings';

// -- allowCommand ------------------------------------------------------------

describe('allowCommand — read-only lease', () => {
  const kinds = ['sw', 'aos'] as const;

  it.each(kinds)('allows read-only commands on %s', (kind) => {
    const allowed = [
      'show version',
      'show system',
      'show interface brief',
      'show vlan',
      'show lldp neighbor',
      'show running-config',
      'show ap database',
      'show switches',
      'show datapath tunnel',
      'display version',
      'display current-configuration',
      'ping 10.42.0.1',
      'ping 10.42.0.1 repetitions 2',
      'traceroute 10.48.0.10',
      'no page',
      'no paging',
      'terminal length 0',
      '?',
      'help',
      'exit',
      'logout',
      'quit',
    ];
    for (const cmd of allowed) {
      expect(allowCommand(kind, cmd), cmd).toEqual({ ok: true });
    }
  });

  it.each(kinds)('blocks writes and destructive commands on %s', (kind) => {
    const blocked = [
      'write memory',
      'write erase',
      'erase startup-config',
      'copy running-config tftp://10.0.0.5/cfg',
      'copy flash primary',
      'reload',
      'boot system',
      'vlan 812',
      'interface 1/1/14',
      'no vlan 812',
      'no shutdown',
      'hostname pwned',
      'ssh admin@10.0.0.2',
      'tftp get',
      'aaa authentication',
    ];
    for (const cmd of blocked) {
      const r = allowCommand(kind, cmd);
      expect(r.ok, cmd).toBe(false);
      expect(r.reason, cmd).toBeTruthy();
    }
  });

  it.each(kinds)('blocks config-mode entry with a specific reason on %s', (kind) => {
    for (const cmd of ['configure', 'configure terminal', 'config', 'config t', 'conf t']) {
      const r = allowCommand(kind, cmd);
      expect(r.ok, cmd).toBe(false);
      expect(r.reason, cmd).toMatch(/config-mode entry/);
    }
  });

  it.each(kinds)('blocks enable escalation with a specific reason on %s', (kind) => {
    for (const cmd of ['enable', 'enable s3cret-enable-pw']) {
      const r = allowCommand(kind, cmd);
      expect(r.ok, cmd).toBe(false);
      expect(r.reason, cmd).toMatch(/privilege escalation/);
    }
  });

  it.each(kinds)('rejects multi-line input on %s — embedded CR/LF must not bypass the lease', (kind) => {
    // The shell write path appends '\n' to the RAW string, so a payload like
    // 'show version\nconfigure terminal' would pass the /^show\b/ check and
    // then run line-by-line on the device.
    for (const cmd of ['show version\nconfigure terminal', 'show version\r\nhostname pwned', 'show vlan\rvlan 812']) {
      const r = allowCommand(kind, cmd);
      expect(r.ok, cmd).toBe(false);
      expect(r.reason, cmd).toBe('multi-line input is not permitted');
    }
  });

  it('is case-insensitive and whitespace-normalised', () => {
    expect(allowCommand('sw', 'SHOW VERSION').ok).toBe(true);
    expect(allowCommand('sw', '  show   interface   brief  ').ok).toBe(true);
    expect(allowCommand('aos', 'CONFIGURE TERMINAL').ok).toBe(false);
    expect(allowCommand('aos', 'Enable').ok).toBe(false);
    expect(allowCommand('sw', 'No Paging').ok).toBe(true);
  });

  it('rejects empty input', () => {
    expect(allowCommand('sw', '').ok).toBe(false);
    expect(allowCommand('sw', '   ').ok).toBe(false);
  });

  it('exposes the refusal line the pane renders', () => {
    expect(BLOCKED_LINE).toBe('% blocked by portal policy — read-only lease');
  });
});

// -- parseClientFrame ----------------------------------------------------------

describe('parseClientFrame', () => {
  it('parses the three protocol frames', () => {
    expect(parseClientFrame('{"type":"open"}')).toEqual({ type: 'open' });
    expect(parseClientFrame('{"type":"close"}')).toEqual({ type: 'close' });
    expect(parseClientFrame('{"type":"cmd","cmd":"show version"}')).toEqual({ type: 'cmd', cmd: 'show version' });
  });

  it('rejects malformed input', () => {
    expect(parseClientFrame('not json')).toBeNull();
    expect(parseClientFrame('{}')).toBeNull();
    expect(parseClientFrame('{"type":"cmd"}')).toBeNull();
    expect(parseClientFrame('{"type":"cmd","cmd":42}')).toBeNull();
    expect(parseClientFrame('{"type":"exec","cmd":"show version"}')).toBeNull();
    expect(parseClientFrame('[{"type":"open"}]')).toBeNull();
    expect(parseClientFrame('null')).toBeNull();
  });

  it('keeps empty and oversized commands parseable so the session can answer without closing', () => {
    expect(parseClientFrame('{"type":"cmd","cmd":""}')).toEqual({ type: 'cmd', cmd: '' });
    const oversized = 'x'.repeat(501);
    expect(parseClientFrame(JSON.stringify({ type: 'cmd', cmd: oversized }))).toEqual({ type: 'cmd', cmd: oversized });
  });

  it('rejects cmd frames carrying CR/LF — multi-line input is invalid upstream', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'cmd', cmd: 'show version\nconfigure terminal' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: 'cmd', cmd: 'show version\r\nhostname pwned' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: 'cmd', cmd: 'show vlan\rvlan 812' }))).toBeNull();
  });
});

// -- ANSI / prompt / scraper ---------------------------------------------------

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences, keeps text', () => {
    expect(stripAnsi('\x1b[1;32msw-core-a#\x1b[0m show version')).toBe('sw-core-a# show version');
    expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden');
    expect(stripAnsi('\x1b[2J\x1b[Hplain')).toBe('plain');
    expect(stripAnsi('no escapes')).toBe('no escapes');
  });
});

describe('looksLikePrompt', () => {
  it('matches the platform prompts', () => {
    expect(looksLikePrompt('sw-core-a#')).toBe(true);
    expect(looksLikePrompt('sw-acc-3f-2(config)#')).toBe(true);
    expect(looksLikePrompt('(mm-lake-1) [mynode] #')).toBe(true);
    expect(looksLikePrompt('(gw-edge-1) #')).toBe(true);
    expect(looksLikePrompt('[appadmin@cppm-01]#')).toBe(true);
    expect(looksLikePrompt('switch> ')).toBe(true);
  });

  it('rejects ordinary output', () => {
    expect(looksLikePrompt('')).toBe(false);
    expect(looksLikePrompt('ArubaOS-CX FL.10.13.1005')).toBe(false);
    expect(looksLikePrompt('  vlan 812 name clinical')).toBe(false);
    expect(looksLikePrompt('x'.repeat(80) + '#')).toBe(false);
  });
});

describe('ShellScraper', () => {
  it('splits complete lines and holds the partial tail', () => {
    const s = new ShellScraper();
    expect(s.feed('one\r\ntwo\r\n')).toEqual([
      { kind: 'line', text: 'one' },
      { kind: 'line', text: 'two' },
    ]);
    // partial tail, no newline yet — nothing emitted
    expect(s.feed('thr')).toEqual([]);
    expect(s.feed('ee\r\n')).toEqual([{ kind: 'line', text: 'three' }]);
  });

  it('detects a bare prompt at the tail', () => {
    const s = new ShellScraper();
    expect(s.feed('sw-core-a#')).toEqual([{ kind: 'prompt', text: 'sw-core-a#' }]);
  });

  it('runs a full command cycle: prompt → echo → output → prompt', () => {
    const s = new ShellScraper();
    expect(s.feed('sw-core-a#')).toEqual([{ kind: 'prompt', text: 'sw-core-a#' }]);
    s.clearTail(); // session drops the rendered prompt before writing
    const events = s.feed('show version\r\nArubaOS-CX FL.10.13.1005\r\nsw-core-a#');
    expect(events).toEqual([
      { kind: 'line', text: 'show version' }, // terminal echo
      { kind: 'line', text: 'ArubaOS-CX FL.10.13.1005' },
      { kind: 'prompt', text: 'sw-core-a#' },
    ]);
  });

  it('detects pager prompts and clears them', () => {
    const s = new ShellScraper();
    const events = s.feed('interface 1/1/1\r\n-- MORE -- ');
    expect(events).toEqual([{ kind: 'line', text: 'interface 1/1/1' }, { kind: 'page' }]);
    // tail cleared — the stream resumes cleanly after the auto-space
    expect(s.feed('next page line\r\n')).toEqual([{ kind: 'line', text: 'next page line' }]);
  });
});

// -- session recording / listing ----------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-terminal-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('TerminalManager.listSessions', () => {
  it('lists recorded sessions newest-first from the log dir', () => {
    const open = (device: string, at: string) =>
      JSON.stringify({ type: 'open', at, text: `device=${device} user=r.okafor target=10.42.8.11` });
    writeFileSync(join(tmpDir, 'sw-core-a-2026-07-25T09-00-00.jsonl'), open('sw-core-a', '2026-07-25T09:00:00.000Z') + '\n');
    writeFileSync(join(tmpDir, 'sw-core-b-2026-07-25T10-00-00.jsonl'), open('sw-core-b', '2026-07-25T10:00:00.000Z') + '\n');
    writeFileSync(join(tmpDir, 'corrupt.jsonl'), 'not json\n');

    const mgr = new TerminalManager({ logDir: tmpDir });
    const sessions = mgr.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].device).toBe('sw-core-b');
    expect(sessions[1]).toEqual({
      file: 'sw-core-a-2026-07-25T09-00-00.jsonl',
      device: 'sw-core-a',
      user: 'r.okafor',
      target: '10.42.8.11',
      openedAt: '2026-07-25T09:00:00.000Z',
    });
  });

  it('returns [] when the log dir does not exist', () => {
    const mgr = new TerminalManager({ logDir: join(tmpDir, 'nope') });
    expect(mgr.listSessions()).toEqual([]);
  });

  it('surfaces recording storage failures instead of presenting an empty list', () => {
    const blocked = join(tmpDir, 'not-a-directory');
    writeFileSync(blocked, 'blocked');
    const mgr = new TerminalManager({ logDir: blocked });
    expect(() => mgr.listSessions()).toThrow();
  });
});

describe('TerminalManager.readSession', () => {
  it('reads a transcript back as parsed events, skipping corrupt lines', () => {
    const file = 'sw-core-a-2026-07-25T09-00-00.jsonl';
    writeFileSync(
      join(tmpDir, file),
      [
        JSON.stringify({ type: 'open', at: '2026-07-25T09:00:00.000Z', text: 'device=sw-core-a user=r.okafor target=10.42.8.11' }),
        JSON.stringify({ type: 'in', at: '2026-07-25T09:00:04.000Z', text: 'show vlan brief' }),
        'corrupt line',
        JSON.stringify({ type: 'out', at: '2026-07-25T09:00:05.000Z', text: 'VLAN Name Status' }),
        JSON.stringify({ type: 'close', at: '2026-07-25T09:01:00.000Z', reason: 'client closed' }),
        '',
      ].join('\n'),
    );
    const mgr = new TerminalManager({ logDir: tmpDir });
    const t = mgr.readSession(file);
    expect(t).not.toBeNull();
    expect(t!.file).toBe(file);
    expect(t!.truncated).toBe(false);
    expect(t!.events.map((e) => e.type)).toEqual(['open', 'in', 'out', 'close']);
    expect(t!.events[1].text).toBe('show vlan brief');
    expect(t!.events[3].reason).toBe('client closed');
  });

  it('rejects traversal and non-recording names, and misses honestly', () => {
    const mgr = new TerminalManager({ logDir: tmpDir });
    expect(mgr.readSession('../settings.json')).toBeNull();
    expect(mgr.readSession('a/b.jsonl')).toBeNull();
    expect(mgr.readSession('notes.txt')).toBeNull();
    expect(mgr.readSession('not-there.jsonl')).toBeNull();
  });

  it('surfaces recording storage failures instead of presenting a false 404', () => {
    const blocked = join(tmpDir, 'not-a-transcript-directory');
    writeFileSync(blocked, 'blocked');
    const mgr = new TerminalManager({ logDir: blocked });
    expect(() => mgr.readSession('session.jsonl')).toThrow();
  });

  it('does not mark exactly 10,000 valid events truncated, but marks the next valid event', () => {
    const exact = 'exact-cap.jsonl';
    const over = 'over-cap.jsonl';
    const line = JSON.stringify({ type: 'out', at: '2026-07-25T09:00:00.000Z', text: 'line' });
    writeFileSync(join(tmpDir, exact), Array.from({ length: MAX_TRANSCRIPT_EVENTS }, () => line).join('\n') + '\n');
    writeFileSync(join(tmpDir, over), Array.from({ length: MAX_TRANSCRIPT_EVENTS + 1 }, () => line).join('\n') + '\n');

    const mgr = new TerminalManager({ logDir: tmpDir });
    expect(mgr.readSession(exact)).toMatchObject({ truncated: false });
    expect(mgr.readSession(exact)?.events).toHaveLength(MAX_TRANSCRIPT_EVENTS);
    expect(mgr.readSession(over)).toMatchObject({ truncated: true });
    expect(mgr.readSession(over)?.events).toHaveLength(MAX_TRANSCRIPT_EVENTS);
  });
});

// -- local-plane credentials round-trip -----------------------------------------

describe('local-plane credential handling (settings store)', () => {
  it('saves username/password/privateKey/passphrase and never exposes secrets', () => {
    const file = join(tmpDir, 'settings.json');
    const store = new SettingsStore(file);
    store.load();
    store.update({
      planes: {
        local: {
          username: 'netops',
          password: 'lab-switch-password',
          privateKey: '-----BEGIN OPENSSH PRIVATE KEY----- fake',
          passphrase: 'key-passphrase',
          host: '10.42.0.9',
          port: '22',
        },
      },
    });

    // Everything the terminal needs is there in the raw store…
    const raw = store.get().planes.local!;
    expect(raw.username).toBe('netops');
    expect(raw.password).toBe('lab-switch-password');
    expect(raw.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(raw.passphrase).toBe('key-passphrase');

    // …but the API view masks every secret (passphrase included).
    const view = JSON.stringify(store.maskedView().planes.local);
    expect(view).not.toContain('lab-switch-password');
    expect(view).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(view).not.toContain('key-passphrase');
    expect(store.maskedView().planes.local!.username).toBe('netops');

    // Settings file itself is 0600.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

// -- session open: target resolution + recorder failure (faked WS/SSH) ---------

/** Minimal WebSocket stand-in: captures outbound frames, records close(). */
class FakeWs extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  frames: Array<Record<string, unknown>> = [];
  closed = false;
  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  errorFrame(): string | null {
    const f = this.frames.find((x) => x.type === 'error');
    return f ? String(f.message) : null;
  }
}

/** Minimal ssh2 Client stand-in: refuses the shell channel so any session that
 *  gets that far tears itself down through the normal fail path. */
class FakeSshClient extends EventEmitter {
  ended = false;
  shellCalls = 0;
  end(): void {
    this.ended = true;
  }
  shell(_opts: unknown, cb: (err: Error | undefined, channel: unknown) => void): void {
    this.shellCalls += 1;
    cb(new Error('test fake: no shell channel'), undefined);
  }
}

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  writes: string[] = [];
  closed = false;
  write(data: string): void {
    this.writes.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

class DeferredShellClient extends EventEmitter {
  ended = false;
  shellCallback: ((err: Error | undefined, channel: FakeChannel) => void) | null = null;
  end(): void {
    this.ended = true;
  }
  shell(_opts: unknown, cb: (err: Error | undefined, channel: FakeChannel) => void): void {
    this.shellCallback = cb;
  }
}

class LiveShellClient extends EventEmitter {
  ended = false;
  readonly channel = new FakeChannel();
  end(): void {
    this.ended = true;
  }
  shell(_opts: unknown, cb: (err: Error | undefined, channel: FakeChannel) => void): void {
    cb(undefined, this.channel);
  }
}

const FAKE_CREDS = { username: 'netops', password: 'lab-password', jumpHost: null, jumpPort: 22, allowHostOverride: false };

/** Drive a connection straight to {type:'open'}; returns the fake socket. */
function openSession(mgr: TerminalManager, device = 'sw-core-a'): FakeWs {
  const ws = new FakeWs();
  mgr.handleConnection(ws as unknown as WebSocket, device, null);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'open' })));
  return ws;
}

/** Let the openSsh() continuation past `await connect(...)` run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('session open — live-mode target resolution', () => {
  const manager = (liveDevices: Array<{ name: string; ip?: string }>, dialled: { target: string | null }) =>
    new TerminalManager({
      logDir: tmpDir,
      demoMode: () => false,
      liveDevices: () => liveDevices,
      creds: () => FAKE_CREDS,
      connect: async (target) => {
        dialled.target = target;
        return new FakeSshClient() as unknown as Client;
      },
    });

  it('fails honestly when the device is not in the live inventory — never dials', () => {
    const dialled = { target: null as string | null };
    const ws = openSession(manager([], dialled));
    expect(ws.errorFrame()).toContain("device 'sw-core-a' is not in the live inventory");
    expect(ws.errorFrame()).toContain('refusing to dial a fixture address');
    expect(dialled.target).toBeNull(); // SSH was never attempted
  });

  it('fails honestly when the live inventory cannot name a management IP', () => {
    for (const row of [{ name: 'sw-core-a' }, { name: 'sw-core-a', ip: 'pending' }]) {
      const dialled = { target: null as string | null };
      const ws = openSession(manager([row], dialled));
      expect(ws.errorFrame(), JSON.stringify(row)).toContain("no management IP for 'sw-core-a'");
      expect(dialled.target).toBeNull();
    }
  });

  it('dials the live-inventory IP and records that target — not the fixture IP', async () => {
    const dialled = { target: null as string | null };
    const ws = openSession(manager([{ name: 'sw-core-a', ip: '10.99.0.7' }], dialled));
    await flush(); // connect resolves, the fake refuses the shell, session fails closed
    expect(dialled.target).toBe('10.99.0.7');
    expect(ws.errorFrame()).toContain('shell channel refused');
    // The recording's open line claims the target actually dialled.
    const rec = readdirSync(tmpDir)
      .filter((f) => f.startsWith('sw-core-a-') && f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(tmpDir, f), 'utf8').split('\n', 1)[0])
      .find((line) => line.includes('10.99.0.7'));
    expect(rec).toBeTruthy();
    expect(rec).toContain('device=sw-core-a');
    expect(rec).toContain('target=10.99.0.7');
  });

  it('demo mode keeps the fixture profile IP (unchanged behaviour)', async () => {
    const dialled = { target: null as string | null };
    const mgr = new TerminalManager({
      logDir: tmpDir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      connect: async (target) => {
        dialled.target = target;
        return new FakeSshClient() as unknown as Client;
      },
    });
    openSession(mgr);
    await flush();
    expect(dialled.target).toBe('10.42.8.11'); // deviceProfile('sw-core-a').ip
  });
});

describe('session open — recorder failure', () => {
  it('sends an error frame and tears the SSH connection down (no leak, no unhandled rejection)', async () => {
    const blocker = join(tmpDir, 'logdir-blocker');
    writeFileSync(blocker, 'not a dir'); // mkdirSync on a file path throws
    const ssh = new FakeSshClient();
    const mgr = new TerminalManager({
      logDir: blocker,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      connect: async () => ssh as unknown as Client,
    });
    const ws = openSession(mgr);
    await flush();
    expect(ws.errorFrame()).toContain('session recording unavailable');
    expect(ssh.ended).toBe(true); // the connection is never leaked
    expect(ws.closed).toBe(true); // socket closed after the error frame
  });
});

describe('session lifecycle while SSH opens', () => {
  it('ends an SSH client that arrives after the WebSocket has already closed', async () => {
    let resolveConnect!: (client: Client) => void;
    const pendingConnect = new Promise<Client>((resolve) => {
      resolveConnect = resolve;
    });
    const ssh = new FakeSshClient();
    const mgr = new TerminalManager({
      logDir: tmpDir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      connect: () => pendingConnect,
    });
    const ws = openSession(mgr);
    ws.emit('close');
    resolveConnect(ssh as unknown as Client);
    await flush();

    expect(ssh.ended).toBe(true);
    expect(ssh.shellCalls).toBe(0);
  });

  it('closes a shell channel that arrives after teardown', async () => {
    const ssh = new DeferredShellClient();
    const mgr = new TerminalManager({
      logDir: tmpDir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      connect: async () => ssh as unknown as Client,
    });
    const ws = openSession(mgr);
    await flush();
    expect(ssh.shellCallback).not.toBeNull();

    ws.emit('close');
    const lateChannel = new FakeChannel();
    ssh.shellCallback?.(undefined, lateChannel);

    expect(lateChannel.closed).toBe(true);
    expect(ssh.ended).toBe(true);
  });
});

describe('live command framing and recording', () => {
  it('keeps the session alive for blank and oversized commands', async () => {
    const ssh = new LiveShellClient();
    const mgr = new TerminalManager({
      logDir: tmpDir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      connect: async () => ssh as unknown as Client,
    });
    const ws = openSession(mgr);
    await flush();
    ssh.channel.emit('data', Buffer.from('sw-core-a#'));

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'cmd', cmd: '' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'cmd', cmd: 'x'.repeat(501) })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'cmd', cmd: 'show version' })));

    expect(ws.closed).toBe(false);
    expect(ws.frames.filter((f) => f.type === 'end')).toHaveLength(2);
    expect(ws.frames.some((f) => f.type === 'warn' && String(f.text).includes('maximum input is 500'))).toBe(true);
    expect(ssh.channel.writes).toEqual(['show version\n']);
    ws.emit('close');
  });

  it('records input and meaningful output without command echoes or prompt artifacts', async () => {
    const before = new Set(readdirSync(tmpDir));
    const ssh = new LiveShellClient();
    const mgr = new TerminalManager({
      logDir: tmpDir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      connect: async () => ssh as unknown as Client,
    });
    const ws = openSession(mgr);
    await flush();
    ssh.channel.emit('data', Buffer.from('sw-core-a#'));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'cmd', cmd: 'show version' })));
    ssh.channel.emit('data', Buffer.from('\r\nshow version\r\nArubaOS-CX FL.10.13.1005\r\nsw-core-a#'));
    ws.emit('close');

    const file = readdirSync(tmpDir).find((name) => !before.has(name) && name.endsWith('.jsonl'));
    expect(file).toBeTruthy();
    const events = readFileSync(join(tmpDir, file!), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; text?: string });
    expect(events.some((e) => e.type === 'in' && e.text === 'show version')).toBe(true);
    expect(events.some((e) => e.type === 'out' && e.text === 'ArubaOS-CX FL.10.13.1005')).toBe(true);
    expect(events.some((e) => e.type === 'out' && e.text === 'show version')).toBe(false);
    expect(events.some((e) => e.type === 'out' && e.text === 'sw-core-a#')).toBe(false);
  });
});

// -- shell class + session identity in live mode -------------------------------

describe('shell class comes from the live inventory row, not the demo name prefix', () => {
  const manager = (
    liveDevices: Array<{ name: string; ip?: string; type?: 'ap' | 'switch' | 'gateway' | 'controller' | 'sensor' }>,
    dialled: { target: string | null },
  ) =>
    new TerminalManager({
      logDir: tmpDir,
      demoMode: () => false,
      liveDevices: () => liveDevices,
      creds: () => FAKE_CREDS,
      connect: async (target) => {
        dialled.target = target;
        return new FakeSshClient() as unknown as Client;
      },
    });

  it("refuses a real AP whose name does not match the demo 'ap-' prefix", () => {
    const dialled = { target: null as string | null };
    const ws = openSession(manager([{ name: 'AP-Floor3', ip: '10.9.9.9', type: 'ap' }], dialled), 'AP-Floor3');
    expect(ws.errorFrame()).toContain("device 'AP-Floor3' is cloud-claimed — no local shell");
    expect(dialled.target).toBeNull(); // never dialled a radio
  });

  it("dials a real switch whose name happens to start with 'ap-'", async () => {
    const dialled = { target: null as string | null };
    const ws = openSession(manager([{ name: 'ap-closet-sw', ip: '10.9.9.10', type: 'switch' }], dialled), 'ap-closet-sw');
    await flush();
    expect(dialled.target).toBe('10.9.9.10');
    expect(ws.errorFrame()).toContain('shell channel refused'); // got past the capability gate
  });

  it('still refuses an unknown device by inventory, not by name class', () => {
    const dialled = { target: null as string | null };
    const ws = openSession(manager([], dialled), 'AP-Floor3');
    expect(ws.errorFrame()).toContain("device 'AP-Floor3' is not in the live inventory");
    expect(dialled.target).toBeNull();
  });

  it('demo mode keeps the fixture prefix rules', () => {
    const mgr = new TerminalManager({
      logDir: tmpDir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      connect: async () => new FakeSshClient() as unknown as Client,
    });
    const ws = openSession(mgr, 'ap-3f-12');
    expect(ws.errorFrame()).toContain("device 'ap-3f-12' is cloud-claimed — no local shell");
  });
});

describe('session recording — a second pane on the same device in the same millisecond', () => {
  it('gets its own transcript instead of failing the session', async () => {
    const before = new Set(readdirSync(tmpDir));
    const mgr = (ssh: LiveShellClient) =>
      new TerminalManager({
        logDir: tmpDir,
        demoMode: () => true,
        creds: () => FAKE_CREDS,
        connect: async () => ssh as unknown as Client,
      });
    const first = new LiveShellClient();
    const second = new LiveShellClient();
    const wsA = openSession(mgr(first), 'sw-twin');
    const wsB = openSession(mgr(second), 'sw-twin');
    await flush();
    first.channel.emit('data', Buffer.from('sw-twin#'));
    second.channel.emit('data', Buffer.from('sw-twin#'));

    // Recording is mandatory, so an EEXIST on the timestamped name would
    // refuse a legitimate concurrent session.
    expect(wsA.errorFrame()).toBeNull();
    expect(wsB.errorFrame()).toBeNull();
    expect(wsA.frames.some((f) => f.type === 'ready')).toBe(true);
    expect(wsB.frames.some((f) => f.type === 'ready')).toBe(true);
    const files = readdirSync(tmpDir).filter((f) => !before.has(f) && f.startsWith('sw-twin-'));
    expect(new Set(files).size).toBe(2); // two transcripts, neither clobbered
    wsA.emit('close');
    wsB.emit('close');
  });
});

describe('canShell — the reachability rule the route layer needs for a live row', () => {
  const mgr = (creds: typeof FAKE_CREDS | null = FAKE_CREDS) =>
    new TerminalManager({ logDir: tmpDir, demoMode: () => false, creds: () => creds });

  it('needs a CLI-bearing type, a dialable management IP and local credentials', () => {
    const m = mgr();
    expect(m.canShell({ name: 'sw-core-a', ip: '10.99.0.7', type: 'switch' })).toBe(true);
    expect(m.canShell({ name: 'mm-lake-1', ip: '10.48.0.10', type: 'controller' })).toBe(true);
    // an AP/sensor has no shell the portal proxies, however it is named
    expect(m.canShell({ name: 'sw-looking-name', ip: '10.99.0.8', type: 'ap' })).toBe(false);
    expect(m.canShell({ name: 'uxi-cam01-2', ip: '10.99.0.9', type: 'sensor' })).toBe(false);
    // no dialable address → the button must not offer a session that cannot open
    expect(m.canShell({ name: 'sw-core-a', type: 'switch' })).toBe(false);
    expect(m.canShell({ name: 'sw-core-a', ip: 'pending', type: 'switch' })).toBe(false);
  });

  it('is false while no local-plane credentials are saved — the record IS the shell path', () => {
    expect(mgr(null).canShell({ name: 'sw-core-a', ip: '10.99.0.7', type: 'switch' })).toBe(false);
  });
});

describe('the session discloses which plane provides the shell path', () => {
  const manager = (
    row: { name: string; ip?: string; type?: 'switch' | 'controller'; plane?: 'CENTRAL' | 'AOS-8' },
    localShell: boolean | undefined,
    ssh: LiveShellClient,
    creds: { username: string; password?: string; jumpHost: string | null; jumpPort: number; allowHostOverride: boolean } = FAKE_CREDS,
  ) =>
    new TerminalManager({
      logDir: tmpDir,
      demoMode: () => false,
      liveDevices: () => [row],
      creds: () => creds,
      planeCapabilities: () => (localShell === undefined ? undefined : { localShell }),
      connect: async () => ssh as unknown as Client,
    });

  const bannerLines = (ws: FakeWs): string[] =>
    (ws.frames.find((f) => f.type === 'banner')?.lines as string[] | undefined) ?? [];

  const openLine = (device: string, before: Set<string>): string => {
    const file = readdirSync(tmpDir).find((name) => !before.has(name) && name.startsWith(`${device}-`));
    expect(file, 'recording written').toBeTruthy();
    return readFileSync(join(tmpDir, file!), 'utf8').split('\n', 1)[0];
  };

  it('names the collector when the claiming plane reports no portal shell path — and still opens', async () => {
    const before = new Set(readdirSync(tmpDir));
    const ssh = new LiveShellClient();
    const mgr = manager({ name: 'sw-cloud-claimed', ip: '10.99.0.7', type: 'switch', plane: 'CENTRAL' }, false, ssh);
    const ws = openSession(mgr, 'sw-cloud-claimed');
    await flush();
    ssh.channel.emit('data', Buffer.from('sw-cloud-claimed#'));

    // A cloud plane's localShell:false describes the cloud plane, not the
    // collector: the session opens, and says whose path it is riding.
    expect(ws.frames.some((f) => f.type === 'ready')).toBe(true);
    expect(bannerLines(ws).some((l) => l.includes('CENTRAL reports no portal shell path'))).toBe(true);
    expect(openLine('sw-cloud-claimed', before)).toContain('note=CENTRAL reports no portal shell path');
    ws.emit('close');
  });

  it('says nothing extra when the plane claims the path itself, and dials the AOS-8 controller via the jump host', async () => {
    const before = new Set(readdirSync(tmpDir));
    const ssh = new LiveShellClient();
    const mgr = manager({ name: 'mm-lake-1', ip: '10.48.0.10', type: 'controller', plane: 'AOS-8' }, true, ssh, {
      ...FAKE_CREDS,
      jumpHost: 'collector-01',
    });
    const ws = openSession(mgr, 'mm-lake-1');
    await flush();
    ssh.channel.emit('data', Buffer.from('(mm-lake-1) [mynode] #'));

    expect(bannerLines(ws).some((l) => l.includes('no portal shell path'))).toBe(false);
    expect(ws.frames.find((f) => f.type === 'ready')).toMatchObject({ target: '10.48.0.10', via: 'collector-01' });
    const line = openLine('mm-lake-1', before);
    expect(line).toContain('target=10.48.0.10');
    expect(line).toContain('via=collector-01');
    expect(line).not.toContain('note=');
    // AOS-8 controllers take the 'aos' lease, not the CX one.
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'cmd', cmd: 'show ap database' })));
    expect(ssh.channel.writes).toEqual(['show ap database\n']);
    ws.emit('close');
  });

  it('discloses nothing when the plane never stated a capability', async () => {
    const ssh = new LiveShellClient();
    const mgr = manager({ name: 'sw-unstated', ip: '10.99.0.7', type: 'switch', plane: 'CENTRAL' }, undefined, ssh);
    const ws = openSession(mgr, 'sw-unstated');
    await flush();
    ssh.channel.emit('data', Buffer.from('sw-unstated#'));
    expect(bannerLines(ws).some((l) => l.includes('no portal shell path'))).toBe(false);
    ws.emit('close');
  });
});

describe("the 'ready' frame attributes the session that is actually recorded", () => {
  it('carries the real SSH user, the resolved target and the jump host', async () => {
    const ssh = new LiveShellClient();
    const mgr = new TerminalManager({
      logDir: tmpDir,
      demoMode: () => false,
      liveDevices: () => [{ name: 'sw-core-a', ip: '10.99.0.7', type: 'switch' }],
      creds: () => ({ ...FAKE_CREDS, username: 'r.okafor-real', jumpHost: 'collector-1' }),
      connect: async () => ssh as unknown as Client,
    });
    const ws = openSession(mgr);
    await flush();
    ssh.channel.emit('data', Buffer.from('sw-core-a#'));
    const ready = ws.frames.find((f) => f.type === 'ready');
    expect(ready).toMatchObject({
      prompt: 'sw-core-a#',
      user: 'r.okafor-real',
      target: '10.99.0.7',
      via: 'collector-1',
    });
    // The frame is an attribution, never a credential channel.
    expect(JSON.stringify(ready)).not.toContain('lab-password');
    ws.emit('close');
  });
});
