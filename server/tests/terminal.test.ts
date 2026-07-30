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
  attachTerminalWs,
  isAllowedTerminalOrigin,
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

  it('parses every generation of the open line — recordings on disk predate the newer fields', () => {
    // The open line grew ' via=<jump>' and then ' note=<provenance>' AFTER the
    // first recordings were written. The `device= user= target=` prefix is the
    // contract; anything appended must stay parseable, and a recording written
    // by an older build must never drop out of the listing.
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-openline-'));
    const write = (file: string, at: string, text: string) =>
      writeFileSync(join(dir, file), JSON.stringify({ type: 'open', at, text }) + '\n');

    write('old-2026-01-01T09-00-00.jsonl', '2026-01-01T09:00:00.000Z', 'device=old user=r.okafor target=10.42.8.11');
    write(
      'jump-2026-01-01T09-01-00.jsonl',
      '2026-01-01T09:01:00.000Z',
      'device=jump user=r.okafor target=10.42.8.11 via=collector-01',
    );
    write(
      'noted-2026-01-01T09-02-00.jsonl',
      '2026-01-01T09:02:00.000Z',
      'device=noted user=r.okafor target=10.42.8.11 via=collector-01 note=CENTRAL reports no portal shell path for the devices it claims — this session is dialled through the local-plane credentials',
    );
    // Same device, same millisecond: the recorder takes the next free suffix
    // rather than refusing the second session, so the listing must hold both.
    write('noted-2026-01-01T09-02-00-2.jsonl', '2026-01-01T09:02:00.000Z', 'device=noted user=k.silva target=10.42.8.12 note=x');

    const mgr = new TerminalManager({ logDir: dir });
    const byFile = new Map(mgr.listSessions().map((s) => [s.file, s]));
    expect(byFile.size).toBe(4);
    for (const file of ['old-2026-01-01T09-00-00.jsonl', 'jump-2026-01-01T09-01-00.jsonl', 'noted-2026-01-01T09-02-00.jsonl']) {
      expect(byFile.get(file)).toMatchObject({ user: 'r.okafor', target: '10.42.8.11' });
    }
    expect(byFile.get('old-2026-01-01T09-00-00.jsonl')!.device).toBe('old');
    expect(byFile.get('noted-2026-01-01T09-02-00-2.jsonl')).toMatchObject({ device: 'noted', user: 'k.silva', target: '10.42.8.12' });
    // The suffixed name is still a readable transcript, not a rejected one.
    expect(mgr.readSession('noted-2026-01-01T09-02-00-2.jsonl')?.events).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
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

// -- identity migration / parser compatibility ---------------------------------

describe('listSessions — plane/serial/identityKey persistence and migration compatibility', () => {
  it('parses plane=/serial= off a new-generation open line into plane, serial and identityKey', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-identity-'));
    writeFileSync(
      join(dir, 'sw-core-a-2026-07-25T09-00-00.jsonl'),
      JSON.stringify({
        type: 'open',
        at: '2026-07-25T09:00:00.000Z',
        text: 'device=sw-core-a user=r.okafor target=10.42.8.11 plane=LOCAL serial=SERIAL-A identity=LOCAL/SERIAL-A via=collector-01 note=x',
      }) + '\n',
    );
    const mgr = new TerminalManager({ logDir: dir });
    const [session] = mgr.listSessions();
    expect(session).toMatchObject({
      device: 'sw-core-a',
      user: 'r.okafor',
      target: '10.42.8.11',
      plane: 'LOCAL',
      serial: 'SERIAL-A',
      identityKey: 'LOCAL/SERIAL-A',
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a legacy open line (no plane=/serial=) still parses cleanly, with identity fields undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-legacy-'));
    writeFileSync(
      join(dir, 'sw-core-a-2026-01-01T09-00-00.jsonl'),
      JSON.stringify({
        type: 'open',
        at: '2026-01-01T09:00:00.000Z',
        text: 'device=sw-core-a user=r.okafor target=10.42.8.11 via=collector-01 note=x',
      }) + '\n',
    );
    const mgr = new TerminalManager({ logDir: dir });
    const [session] = mgr.listSessions();
    expect(session).toMatchObject({ device: 'sw-core-a', user: 'r.okafor', target: '10.42.8.11' });
    expect(session.plane).toBeUndefined();
    expect(session.serial).toBeUndefined();
    expect(session.identityKey).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a session opened with a complete plane+serial identity persists it into the recording file', async () => {
    const dialled = { target: null as string | null };
    const mgr = new TerminalManager({
      logDir: tmpDir,
      demoMode: () => false,
      liveDevices: () => [{ name: 'identity-recorded', ip: '10.99.1.1', plane: 'LOCAL', serial: 'SERIAL-Z' }],
      creds: () => FAKE_CREDS,
      connect: async (target) => {
        dialled.target = target;
        return new FakeSshClient() as unknown as Client;
      },
    });
    openSession(mgr, 'identity-recorded', { plane: 'LOCAL', serial: 'SERIAL-Z' });
    await flush();
    const session = mgr.listSessions().find((s) => s.device === 'identity-recorded');
    expect(session).toMatchObject({ plane: 'LOCAL', serial: 'SERIAL-Z', identityKey: 'LOCAL/SERIAL-Z' });
  });

  it('a session opened with no identity (name-only) records no plane/serial — never fabricated', async () => {
    const mgr = new TerminalManager({
      logDir: tmpDir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      connect: async () => new FakeSshClient() as unknown as Client,
    });
    openSession(mgr, 'name-only-device', {});
    await flush();
    const session = mgr.listSessions().find((s) => s.device === 'name-only-device');
    expect(session?.plane).toBeUndefined();
    expect(session?.serial).toBeUndefined();
    expect(session?.identityKey).toBeUndefined();
  });
});

// -- duplicate-name isolation / exact filtering / legacy unique-or-ambiguous ---

describe('TerminalManager.listSessionsForDevice — never guesses across a shared display name', () => {
  const writeOpen = (dir: string, file: string, at: string, text: string): void => {
    writeFileSync(join(dir, file), JSON.stringify({ type: 'open', at, text }) + '\n');
  };

  it('an exact plane+serial query returns only that identity’s recordings — never the other device sharing the name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-dupname-'));
    writeOpen(dir, 'shared-a-2026-01-01T09-00-00.jsonl', '2026-01-01T09:00:00.000Z',
      'device=shared user=alice target=10.1.1.1 plane=LOCAL serial=SERIAL-A identity=LOCAL/SERIAL-A');
    writeOpen(dir, 'shared-b-2026-01-01T09-01-00.jsonl', '2026-01-01T09:01:00.000Z',
      'device=shared user=bob target=10.1.1.2 plane=CENTRAL serial=SERIAL-B identity=CENTRAL/SERIAL-B');

    const mgr = new TerminalManager({
      logDir: dir,
      demoMode: () => false,
      liveDevices: () => [
        { name: 'shared', ip: '10.1.1.1', plane: 'LOCAL', serial: 'SERIAL-A' },
        { name: 'shared', ip: '10.1.1.2', plane: 'CENTRAL', serial: 'SERIAL-B' },
      ],
    });

    const a = mgr.listSessionsForDevice('shared', { plane: 'LOCAL', serial: 'SERIAL-A' });
    expect(a.ambiguous).toBe(false);
    expect(a.sessions).toHaveLength(1);
    expect(a.sessions[0]).toMatchObject({ user: 'alice', serial: 'SERIAL-A' });

    const b = mgr.listSessionsForDevice('shared', { plane: 'CENTRAL', serial: 'SERIAL-B' });
    expect(b.ambiguous).toBe(false);
    expect(b.sessions).toHaveLength(1);
    expect(b.sessions[0]).toMatchObject({ user: 'bob', serial: 'SERIAL-B' });

    rmSync(dir, { recursive: true, force: true });
  });

  it('no identity supplied for a genuinely shared name reports ambiguous — never a first-match guess', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-dupname-bare-'));
    writeOpen(dir, 'shared-a-2026-01-01T09-00-00.jsonl', '2026-01-01T09:00:00.000Z',
      'device=shared user=alice target=10.1.1.1 plane=LOCAL serial=SERIAL-A identity=LOCAL/SERIAL-A');
    writeOpen(dir, 'shared-b-2026-01-01T09-01-00.jsonl', '2026-01-01T09:01:00.000Z',
      'device=shared user=bob target=10.1.1.2 plane=CENTRAL serial=SERIAL-B identity=CENTRAL/SERIAL-B');

    const mgr = new TerminalManager({
      logDir: dir,
      demoMode: () => false,
      liveDevices: () => [
        { name: 'shared', ip: '10.1.1.1', plane: 'LOCAL', serial: 'SERIAL-A' },
        { name: 'shared', ip: '10.1.1.2', plane: 'CENTRAL', serial: 'SERIAL-B' },
      ],
    });

    const result = mgr.listSessionsForDevice('shared');
    expect(result.ambiguous).toBe(true);
    expect(result.sessions).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('legacy recordings under a name that is provably unique (single identity, no live duplicate) are shown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-legacy-unique-'));
    writeOpen(dir, 'lonely-2026-01-01T09-00-00.jsonl', '2026-01-01T09:00:00.000Z',
      'device=lonely user=carol target=10.5.5.5'); // no identity — pre-migration recording

    const mgr = new TerminalManager({
      logDir: dir,
      demoMode: () => false,
      liveDevices: () => [{ name: 'lonely', ip: '10.5.5.5', plane: 'LOCAL', serial: 'SERIAL-LONELY' }],
    });

    const result = mgr.listSessionsForDevice('lonely', { plane: 'LOCAL', serial: 'SERIAL-LONELY' });
    expect(result.ambiguous).toBe(false);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ user: 'carol' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('legacy recordings under a name the live inventory now shares are omitted, never guessed onto either device', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-legacy-ambiguous-'));
    writeOpen(dir, 'shared-2026-01-01T09-00-00.jsonl', '2026-01-01T09:00:00.000Z',
      'device=shared user=carol target=10.5.5.5'); // pre-migration — no identity on file

    const mgr = new TerminalManager({
      logDir: dir,
      demoMode: () => false,
      // The name is now claimed by two physically distinct live devices —
      // the legacy recording cannot honestly be attributed to either.
      liveDevices: () => [
        { name: 'shared', ip: '10.5.5.5', plane: 'LOCAL', serial: 'SERIAL-A' },
        { name: 'shared', ip: '10.5.5.6', plane: 'CENTRAL', serial: 'SERIAL-B' },
      ],
    });

    const exact = mgr.listSessionsForDevice('shared', { plane: 'LOCAL', serial: 'SERIAL-A' });
    expect(exact.ambiguous).toBe(false);
    expect(exact.sessions).toEqual([]); // no recording carries this identity, and the legacy one is unsafe to attribute

    const bare = mgr.listSessionsForDevice('shared');
    expect(bare.ambiguous).toBe(true);
    expect(bare.sessions).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('two distinct identities ever recorded under one name make even a legacy-free request honest without a live row to confirm uniqueness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-distinct-history-'));
    writeOpen(dir, 'shared-a-2026-01-01T09-00-00.jsonl', '2026-01-01T09:00:00.000Z',
      'device=shared user=alice target=10.1.1.1 plane=LOCAL serial=SERIAL-A identity=LOCAL/SERIAL-A');
    writeOpen(dir, 'shared-b-2026-01-01T09-01-00.jsonl', '2026-01-01T09:01:00.000Z',
      'device=shared user=bob target=10.1.1.2 plane=CENTRAL serial=SERIAL-B identity=CENTRAL/SERIAL-B');
    // Neither device is live any more — the inventory alone cannot prove
    // uniqueness, but the recordings' own history already disproves it.
    const mgr = new TerminalManager({ logDir: dir, demoMode: () => false, liveDevices: () => [] });

    const result = mgr.listSessionsForDevice('shared');
    expect(result.ambiguous).toBe(true);
    expect(result.sessions).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a half identity pair (plane without serial, or serial without plane)', () => {
    const mgr = new TerminalManager({ logDir: tmpDir, demoMode: () => false, liveDevices: () => [] });
    expect(mgr.listSessionsForDevice('anything', { plane: 'LOCAL' }).invalid).toMatch(/together/);
    expect(mgr.listSessionsForDevice('anything', { serial: 'X' }).invalid).toMatch(/together/);
  });

  it('an unknown device name returns an honest empty list, not ambiguous', () => {
    const mgr = new TerminalManager({ logDir: tmpDir, demoMode: () => false, liveDevices: () => [] });
    const result = mgr.listSessionsForDevice('never-recorded');
    expect(result).toEqual({ sessions: [], ambiguous: false, invalid: null });
  });
});

describe('TerminalManager.readSessionForDevice — a transcript is gated by the same identity rule as the listing', () => {
  const writeSession = (dir: string, file: string, text: string): void => {
    writeFileSync(
      join(dir, file),
      [
        JSON.stringify({ type: 'open', at: '2026-01-01T09:00:00.000Z', text }),
        JSON.stringify({ type: 'out', at: '2026-01-01T09:00:01.000Z', text: 'OUTPUT-FOR-THIS-FILE' }),
      ].join('\n') + '\n',
    );
  };

  it('serves the transcript when the file belongs to the exact requested identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-read-exact-'));
    writeSession(dir, 'shared-a.jsonl', 'device=shared user=alice target=10.1.1.1 plane=LOCAL serial=SERIAL-A identity=LOCAL/SERIAL-A');
    writeSession(dir, 'shared-b.jsonl', 'device=shared user=bob target=10.1.1.2 plane=CENTRAL serial=SERIAL-B identity=CENTRAL/SERIAL-B');
    const mgr = new TerminalManager({
      logDir: dir,
      demoMode: () => false,
      liveDevices: () => [
        { name: 'shared', ip: '10.1.1.1', plane: 'LOCAL', serial: 'SERIAL-A' },
        { name: 'shared', ip: '10.1.1.2', plane: 'CENTRAL', serial: 'SERIAL-B' },
      ],
    });

    const result = mgr.readSessionForDevice('shared-a.jsonl', 'shared', { plane: 'LOCAL', serial: 'SERIAL-A' });
    expect(result.invalid).toBeNull();
    expect(result.ambiguous).toBe(false);
    expect(result.transcript?.events.some((e) => e.text === 'OUTPUT-FOR-THIS-FILE')).toBe(true);
  });

  it('refuses another identity’s file even when the caller already knows its exact name — never leaks content across a shared name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-read-cross-'));
    writeSession(dir, 'shared-a.jsonl', 'device=shared user=alice target=10.1.1.1 plane=LOCAL serial=SERIAL-A identity=LOCAL/SERIAL-A');
    writeSession(dir, 'shared-b.jsonl', 'device=shared user=bob target=10.1.1.2 plane=CENTRAL serial=SERIAL-B identity=CENTRAL/SERIAL-B');
    const mgr = new TerminalManager({
      logDir: dir,
      demoMode: () => false,
      liveDevices: () => [
        { name: 'shared', ip: '10.1.1.1', plane: 'LOCAL', serial: 'SERIAL-A' },
        { name: 'shared', ip: '10.1.1.2', plane: 'CENTRAL', serial: 'SERIAL-B' },
      ],
    });

    // Ask for B's file while presenting A's identity — must miss, not leak.
    const result = mgr.readSessionForDevice('shared-b.jsonl', 'shared', { plane: 'LOCAL', serial: 'SERIAL-A' });
    expect(result.transcript).toBeNull();
    expect(result.ambiguous).toBe(false);
    expect(result.invalid).toBeNull();
  });

  it('an ambiguous bare-name request reports ambiguous rather than serving any transcript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-read-ambiguous-'));
    writeSession(dir, 'shared-a.jsonl', 'device=shared user=alice target=10.1.1.1 plane=LOCAL serial=SERIAL-A identity=LOCAL/SERIAL-A');
    writeSession(dir, 'shared-b.jsonl', 'device=shared user=bob target=10.1.1.2 plane=CENTRAL serial=SERIAL-B identity=CENTRAL/SERIAL-B');
    const mgr = new TerminalManager({
      logDir: dir,
      demoMode: () => false,
      liveDevices: () => [
        { name: 'shared', ip: '10.1.1.1', plane: 'LOCAL', serial: 'SERIAL-A' },
        { name: 'shared', ip: '10.1.1.2', plane: 'CENTRAL', serial: 'SERIAL-B' },
      ],
    });

    const result = mgr.readSessionForDevice('shared-a.jsonl', 'shared');
    expect(result.ambiguous).toBe(true);
    expect(result.transcript).toBeNull();
  });

  it('rejects traversal file names even when routed through readSessionForDevice', () => {
    const mgr = new TerminalManager({ logDir: tmpDir, demoMode: () => false, liveDevices: () => [] });
    writeFileSync(join(tmpDir, 'legit-2026-01-01.jsonl'), JSON.stringify({ type: 'open', at: '2026-01-01T09:00:00.000Z', text: 'device=legit user=a target=b' }) + '\n');
    const result = mgr.readSessionForDevice('../settings.json', 'legit');
    expect(result.transcript).toBeNull();
    expect(result.ambiguous).toBe(false);
    expect(result.invalid).toBeNull();
  });
});


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
function openSession(
  mgr: TerminalManager,
  device = 'sw-core-a',
  identity: { plane?: string; serial?: string } = {},
): FakeWs {
  const ws = new FakeWs();
  mgr.handleConnection(ws as unknown as WebSocket, device, null, identity);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'open' })));
  return ws;
}

/** Let the openSsh() continuation past `await connect(...)` run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('session open — live-mode target resolution', () => {
  const manager = (
    liveDevices: Array<{ name: string; ip?: string; plane?: 'CENTRAL' | 'LOCAL'; serial?: string }>,
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

  it('uses plane+serial to open the exact duplicate-name device', async () => {
    const dialled = { target: null as string | null };
    const mgr = manager([
      { name: 'sw-core-a', ip: '10.99.0.7', plane: 'LOCAL', serial: 'SERIAL-A' },
      { name: 'sw-core-a', ip: '10.99.0.8', plane: 'LOCAL', serial: 'SERIAL-B' },
    ], dialled);
    openSession(mgr, 'sw-core-a', { plane: 'LOCAL', serial: 'SERIAL-B' });
    await flush();
    expect(dialled.target).toBe('10.99.0.8');
  });

  it('rejects an ambiguous legacy terminal action without dialing either device', () => {
    const dialled = { target: null as string | null };
    const ws = openSession(manager([
      { name: 'sw-core-a', ip: '10.99.0.7', plane: 'LOCAL', serial: 'SERIAL-A' },
      { name: 'sw-core-a', ip: '10.99.0.8', plane: 'CENTRAL', serial: 'SERIAL-B' },
    ], dialled));
    expect(ws.errorFrame()).toContain("'sw-core-a' names 2 devices");
    expect(ws.errorFrame()).toContain('LOCAL/SERIAL-A');
    expect(ws.errorFrame()).toContain('CENTRAL/SERIAL-B');
    expect(dialled.target).toBeNull();
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
    // The same disclosure rides the 'ready' frame as a field, so the pane can
    // present it as a notice without string-matching a banner line — and the
    // two can never disagree, they are the one value.
    const note = ws.frames.find((f) => f.type === 'ready')?.note as string | null;
    expect(note).toContain('CENTRAL reports no portal shell path');
    expect(bannerLines(ws)).toContain(note);
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
    expect(ws.frames.find((f) => f.type === 'ready')).toMatchObject({ target: '10.48.0.10', via: 'collector-01', note: null });
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

/**
 * The SSH bridge is the highest-value target in the portal: a successful
 * upgrade is a live shell on a production switch. WebSocket handshakes ignore
 * the same-origin policy, so without this gate any page the operator visits
 * can open one. These tests pin the gate itself and the refusal path.
 */
describe('terminal WebSocket origin gate', () => {
  it('refuses a cross-site origin', () => {
    expect(isAllowedTerminalOrigin('https://evil.example', 'localhost:5173', '')).toBe(false);
    // A lookalike must not pass on prefix/suffix similarity alone.
    expect(isAllowedTerminalOrigin('https://localhost.evil.example', 'localhost:5173', '')).toBe(false);
    expect(isAllowedTerminalOrigin('https://evil.example/localhost', 'localhost:5173', '')).toBe(false);
  });

  it('allows the page the portal itself served', () => {
    expect(isAllowedTerminalOrigin('http://localhost:5173', 'localhost:5173', '')).toBe(true);
    // Same host, reached by its address rather than its name.
    expect(isAllowedTerminalOrigin('http://10.0.0.5:5173', '10.0.0.5:5173', '')).toBe(true);
  });

  // web/vite.config.ts serves an optional hot-reload UI on 5174 that proxies
  // to this server, so a loopback origin on ANOTHER port is legitimate. It is
  // also not a privilege gain: serving a page from this machine already
  // implies local code execution.
  it('allows a loopback origin on a different port so local dev keeps working', () => {
    expect(isAllowedTerminalOrigin('http://localhost:5174', 'localhost:5173', '')).toBe(true);
    expect(isAllowedTerminalOrigin('http://127.0.0.1:5174', 'localhost:5173', '')).toBe(true);
  });

  // Only browsers must send Origin. Rejecting its absence would break native
  // tooling while adding nothing: an attacker who can omit it can also forge
  // it. Non-browser callers are bounded by authentication, not by this gate.
  it('allows a request with no origin, because that is not a browser', () => {
    expect(isAllowedTerminalOrigin(undefined, 'localhost:5173', '')).toBe(true);
    expect(isAllowedTerminalOrigin('', 'localhost:5173', '')).toBe(true);
  });

  it('honours a configured allow-list for deliberate remote exposure', () => {
    const list = 'https://portal.example, https://ops.example';
    expect(isAllowedTerminalOrigin('https://portal.example', 'localhost:5173', list)).toBe(true);
    expect(isAllowedTerminalOrigin('https://ops.example', 'localhost:5173', list)).toBe(true);
    expect(isAllowedTerminalOrigin('https://other.example', 'localhost:5173', list)).toBe(false);
  });

  it('refuses an unparseable origin rather than falling through', () => {
    expect(isAllowedTerminalOrigin('not-a-url', 'localhost:5173', '')).toBe(false);
  });

  // End-to-end: the refusal must happen before handleUpgrade, so a rejected
  // page never reaches the SSH bridge at all.
  it('answers a disallowed upgrade with 403 and never opens a session', async () => {
    const { createServer } = await import('node:http');
    const { WebSocket } = await import('ws');
    const server = createServer();
    let opened = 0;
    const manager = { handleConnection: () => { opened += 1; } } as unknown as TerminalManager;
    attachTerminalWs(server, manager);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    const failure = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/sw-core-a`, {
        origin: 'https://evil.example',
      });
      ws.on('error', (err: Error) => resolve(err.message));
      ws.on('open', () => resolve('OPENED'));
    });

    expect(failure).toContain('403');
    expect(opened).toBe(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('still opens a session for an allowed origin', async () => {
    const { createServer } = await import('node:http');
    const { WebSocket } = await import('ws');
    const server = createServer();
    let opened = 0;
    const manager = { handleConnection: () => { opened += 1; } } as unknown as TerminalManager;
    attachTerminalWs(server, manager);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    const result = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/sw-core-a`, {
        origin: `http://127.0.0.1:${port}`,
      });
      ws.on('error', (err: Error) => resolve(err.message));
      ws.on('open', () => {
        ws.close();
        resolve('OPENED');
      });
    });

    expect(result).toBe('OPENED');
    expect(opened).toBe(1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

/**
 * The origin check stops a browser on another site. It does nothing about a
 * direct socket, which anything can open. When the portal has an identity
 * provider, the SSH bridge has to demand the same session the API does —
 * otherwise closing the API and leaving this open is security theatre.
 */
describe('terminal upgrade session gate', () => {
  async function bridge(authenticate?: Parameters<typeof attachTerminalWs>[2]) {
    const { createServer } = await import('node:http');
    const server = createServer();
    let opened = 0;
    const manager = { handleConnection: () => { opened += 1; } } as unknown as TerminalManager;
    attachTerminalWs(server, manager, authenticate);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return {
      port,
      opened: () => opened,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  async function connect(port: number, headers: Record<string, string> = {}) {
    const { WebSocket } = await import('ws');
    return new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/sw-core-a`, {
        origin: `http://127.0.0.1:${port}`,
        headers,
      });
      ws.on('error', (err: Error) => resolve(err.message));
      ws.on('open', () => {
        ws.close();
        resolve('OPENED');
      });
    });
  }

  it('answers 401 and opens no session when the cookie is missing', async () => {
    const b = await bridge((req) =>
      /valid=yes/.test(req.headers.cookie ?? '') ? { ok: true, who: 'alice' } : { ok: false },
    );
    expect(await connect(b.port)).toContain('401');
    expect(b.opened()).toBe(0);
    await b.close();
  });

  it('answers 401 for a forged cookie', async () => {
    const b = await bridge((req) =>
      /valid=yes/.test(req.headers.cookie ?? '') ? { ok: true, who: 'alice' } : { ok: false },
    );
    expect(await connect(b.port, { cookie: 'hpe_sid=forged' })).toContain('401');
    expect(b.opened()).toBe(0);
    await b.close();
  });

  it('opens the session when the cookie is valid', async () => {
    const b = await bridge((req) =>
      /valid=yes/.test(req.headers.cookie ?? '') ? { ok: true, who: 'alice' } : { ok: false },
    );
    expect(await connect(b.port, { cookie: 'valid=yes' })).toBe('OPENED');
    expect(b.opened()).toBe(1);
    await b.close();
  });

  it('stays open when no authenticator is supplied, matching the API', async () => {
    // No identity provider configured: the origin check is the only gate, and
    // the bridge must not start refusing everyone.
    const b = await bridge(undefined);
    expect(await connect(b.port)).toBe('OPENED');
    expect(b.opened()).toBe(1);
    await b.close();
  });

  it('checks the origin before the session, so a hostile page cannot probe it', async () => {
    const { WebSocket } = await import('ws');
    let authCalls = 0;
    const b = await bridge(() => {
      authCalls += 1;
      return { ok: false };
    });
    const failure = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}/api/terminal/sw-core-a`, {
        origin: 'https://evil.example',
      });
      ws.on('error', (err: Error) => resolve(err.message));
      ws.on('open', () => resolve('OPENED'));
    });
    expect(failure).toContain('403');
    expect(authCalls).toBe(0);
    await b.close();
  });
});

describe('session bounds — nothing may run without an end in sight', () => {
  const boundedManager = (opts: Partial<ConstructorParameters<typeof TerminalManager>[0]> = {}) =>
    new TerminalManager({
      logDir: tmpDir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      ...opts,
    });

  it('refuses a session past the cap, saying why, without allocating anything', () => {
    // Switches cap concurrent VTY sessions themselves; an unbounded portal can
    // exhaust a device's session table and lock out the operators who would
    // fix it.
    let dials = 0;
    const mgr = boundedManager({
      maxSessions: 2,
      connect: async () => {
        dials += 1;
        return new LiveShellClient() as unknown as Client;
      },
    });

    const a = openSession(mgr, 'sw-core-a');
    const b = openSession(mgr, 'sw-core-a');
    const c = openSession(mgr, 'sw-core-a');

    expect(c.errorFrame()).toContain('too many shell sessions open (2 of 2)');
    expect(c.closed).toBe(true);
    expect(a.errorFrame()).toBeNull();
    expect(b.errorFrame()).toBeNull();
    expect(mgr.openSessionCount()).toBe(2);
    expect(dials).toBeLessThanOrEqual(2); // the refused one never dialled
  });

  it('frees a slot when a session ends, so the cap is a ceiling and not a lifetime quota', async () => {
    const mgr = boundedManager({
      maxSessions: 1,
      connect: async () => new LiveShellClient() as unknown as Client,
    });
    const first = openSession(mgr, 'sw-core-a');
    await flush();
    expect(mgr.openSessionCount()).toBe(1);

    first.emit('message', Buffer.from(JSON.stringify({ type: 'close' })));
    expect(mgr.openSessionCount()).toBe(0);

    const second = openSession(mgr, 'sw-core-a');
    expect(second.errorFrame()).toBeNull();
    expect(mgr.openSessionCount()).toBe(1);
  });

  it('frees a slot when the socket drops without a close frame', () => {
    const mgr = boundedManager({
      maxSessions: 1,
      connect: async () => new LiveShellClient() as unknown as Client,
    });
    const ws = openSession(mgr, 'sw-core-a');
    expect(mgr.openSessionCount()).toBe(1);
    ws.emit('close');
    expect(mgr.openSessionCount()).toBe(0);
  });

  it('gives up on a dial that never lands, instead of a pane that never resolves', async () => {
    const mgr = boundedManager({
      connectMs: 20,
      connect: () => new Promise<Client>(() => {}), // never settles
    });
    const ws = openSession(mgr, 'sw-core-a');
    await new Promise((r) => setTimeout(r, 60));
    expect(ws.errorFrame()).toContain('no response after');
    expect(mgr.openSessionCount()).toBe(0);
  });

  it('closes a connection that lands after the portal stopped waiting', async () => {
    // Otherwise it is a live SSH session to a production switch, holding one of
    // that switch's VTY slots, belonging to nobody, for the life of the process.
    let late: LiveShellClient | null = null;
    let release: (c: Client) => void = () => {};
    const mgr = boundedManager({
      connectMs: 20,
      connect: () => new Promise<Client>((r) => (release = r)),
    });
    const ws = openSession(mgr, 'sw-core-a');
    await new Promise((r) => setTimeout(r, 60));
    expect(ws.errorFrame()).toContain('no response after');

    late = new LiveShellClient();
    release(late as unknown as Client);
    await flush();
    expect(late.ended).toBe(true);
  });

  it('gives up when the device accepts the connection but never opens a shell', async () => {
    // A switch at its VTY limit can accept the transport and leave shell()
    // pending forever. The idle timer does not cover this — it only starts once
    // the session is interactive.
    const deferred = new DeferredShellClient();
    const mgr = boundedManager({
      shellOpenMs: 20,
      connect: async () => deferred as unknown as Client,
    });
    const ws = openSession(mgr, 'sw-core-a');
    await flush();
    expect(deferred.shellCallback).not.toBeNull(); // it really was asked
    await new Promise((r) => setTimeout(r, 60));
    expect(ws.errorFrame()).toContain('did not open a shell within');
    expect(mgr.openSessionCount()).toBe(0);
  });

  it('does not fire the shell timeout for a session that opened normally', async () => {
    const mgr = boundedManager({
      shellOpenMs: 20,
      connect: async () => new LiveShellClient() as unknown as Client,
    });
    const ws = openSession(mgr, 'sw-core-a');
    await flush();
    await new Promise((r) => setTimeout(r, 60));
    expect(ws.errorFrame()).toBeNull();
  });
});

describe('transcript size cap — a shell must never run unrecorded', () => {
  it('ends the session when the transcript hits its cap, and says so in the transcript', async () => {
    // Rotating a transcript is not an option: one-file-per-session is what
    // listSessions/readSession are built on. So the recording stops at the cap
    // and the session goes with it, rather than the shell continuing while
    // nothing records it.
    const dir = mkdtempSync(join(tmpdir(), 'hpe-cap-'));
    const live = new LiveShellClient();
    const mgr = new TerminalManager({
      logDir: dir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      maxTranscriptBytes: 400,
      connect: async () => live as unknown as Client,
    });
    const ws = openSession(mgr, 'sw-core-a');
    await flush();

    for (let i = 0; i < 40 && !ws.closed; i += 1) {
      live.channel.emit('data', Buffer.from(`${'x'.repeat(60)}\n`));
    }

    expect(ws.frames.some((f) => f.type === 'closed' && String(f.reason).includes('transcript size limit'))).toBe(true);
    expect(mgr.openSessionCount()).toBe(0);

    const file = mgr.listSessions()[0];
    expect(file).toBeDefined();
    const events = mgr.readSession(file.file)!.events;
    const last = events[events.length - 1];
    expect(last.type).toBe('close');
    expect(String(last.reason)).toContain('transcript size limit reached');
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves an ordinary session well under the cap completely alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-cap-'));
    const live = new LiveShellClient();
    const mgr = new TerminalManager({
      logDir: dir,
      demoMode: () => true,
      creds: () => FAKE_CREDS,
      maxTranscriptBytes: 1024 * 1024,
      connect: async () => live as unknown as Client,
    });
    const ws = openSession(mgr, 'sw-core-a');
    await flush();
    live.channel.emit('data', Buffer.from('sw-core-a# \n'));
    expect(ws.frames.some((f) => f.type === 'closed')).toBe(false);
    expect(mgr.openSessionCount()).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * A transcript records exactly what was typed at a production switch. Until
 * these, it recorded nothing about who typed it: `user` is the SSH account on
 * the device, which is shared, and the portal operator appeared nowhere.
 */
describe('listSessions — the portal operator who opened the shell', () => {
  it('parses by= off an attributed open line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-by-'));
    writeFileSync(
      join(dir, 'sw-core-a-2026-07-25T09-00-00.jsonl'),
      JSON.stringify({
        type: 'open',
        at: '2026-07-25T09:00:00.000Z',
        text: 'device=sw-core-a user=r.okafor target=10.42.8.11 by=alice@example.com plane=LOCAL serial=SERIAL-A identity=LOCAL/SERIAL-A via=collector-01 note=x',
      }) + '\n',
    );
    const mgr = new TerminalManager({ logDir: dir });
    const [session] = mgr.listSessions();
    // `user` is the device account, `by` is the person. Conflating them would
    // attribute every session to whichever credential the plane holds.
    expect(session.by).toBe('alice@example.com');
    expect(session.user).toBe('r.okafor');
    // Adding by= must not disturb the fields parsed either side of it.
    expect(session).toMatchObject({
      device: 'sw-core-a',
      target: '10.42.8.11',
      plane: 'LOCAL',
      serial: 'SERIAL-A',
      identityKey: 'LOCAL/SERIAL-A',
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves by undefined on a recording made before shells were attributed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-terminal-by-legacy-'));
    writeFileSync(
      join(dir, 'sw-core-a-2026-01-01T09-00-00.jsonl'),
      JSON.stringify({
        type: 'open',
        at: '2026-01-01T09:00:00.000Z',
        text: 'device=sw-core-a user=r.okafor target=10.42.8.11 via=collector-01 note=x',
      }) + '\n',
    );
    const mgr = new TerminalManager({ logDir: dir });
    const [session] = mgr.listSessions();
    // Not defaulted to 'operator': "we do not know who opened this" and "the
    // portal was running unauthenticated" are different claims.
    expect(session.by).toBeUndefined();
    expect(session.user).toBe('r.okafor');
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The reason handleConnection takes `who` explicitly instead of reading the
 * ambient actor.
 *
 * This is a property of AsyncLocalStorage, not of this codebase, and it is
 * easy to "simplify" back into a bug that nothing else would catch: the audit
 * lines would keep being written, they would just quietly name nobody.
 */
describe('why the shell actor is passed explicitly', () => {
  it('confirms an actor scope does NOT survive into a socket event', async () => {
    const { withActor, currentActor, ANONYMOUS_OPERATOR } = await import('../src/services/auth');
    const socket = new EventEmitter(); // stands in for the upgraded ws
    const seen: string[] = [];

    // Exactly the shape the upgrade handler had: register inside the scope,
    // emit later from the socket's own context.
    withActor('alice@example.com', () => {
      socket.on('message', () => seen.push(currentActor()));
    });
    await new Promise((r) => setImmediate(r));
    socket.emit('message');

    expect(seen).toEqual([ANONYMOUS_OPERATOR]);

    // Re-entering the scope inside the listener is what actually works, and is
    // what handleConnection now does for every frame.
    const fixed: string[] = [];
    socket.on('frame', () => withActor('alice@example.com', () => fixed.push(currentActor())));
    socket.emit('frame');
    expect(fixed).toEqual(['alice@example.com']);
  });
});
