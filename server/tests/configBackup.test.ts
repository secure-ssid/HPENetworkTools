/**
 * server/tests/configBackup.test.ts — versioned config backups, NO network.
 *
 * Service-level tests construct ConfigBackupService instances against per-test
 * tmp data dirs (inventory, clock and collector injected). Route-level tests
 * mount createConfigBackupsRouter with such a service on a bare Express app,
 * plus one createApp() boot to prove the singleton registration.
 *
 * HPE_SETTINGS_PATH and HPE_DATA_DIR point at a tmp dir before any app module
 * is imported (the settings/poller/writeBroker singletons resolve their paths
 * at import), so nothing here touches the real data/ — the same pattern as
 * writeBroker.test.ts.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_BACKUP_KEEP_VERSIONS,
  DEVICES,
  DEVICE_CONFIGS,
  CONFIG_DIFF_MAX_CELLS,
  collapsedDiffNote,
  configDiffHasChanges,
  diffConfigLines,
  diffConfigLinesWithFidelity,
  unifiedConfigDiffText,
} from '@hpe/shared';
import type {
  BackupInventoryRow,
  BackupTarget,
  ConfigBackupService as ConfigBackupServiceT,
} from '../src/services/configBackup';

let ConfigBackupService: typeof import('../src/services/configBackup').ConfigBackupService;
let ConfigBackupError: typeof import('../src/services/configBackup').ConfigBackupError;
let demoBaselineConfig: typeof import('../src/services/configBackup').demoBaselineConfig;
let applyDemoDrift: typeof import('../src/services/configBackup').applyDemoDrift;
let createConfigBackupsRouter: typeof import('../src/routes/configBackups').createConfigBackupsRouter;
let createApp: typeof import('../src/index').createApp;
let configBackupsSingleton: typeof import('../src/services/configBackup').configBackups;
let liveComplianceData: typeof import('../src/routes/screens/complianceModel').liveComplianceData;
let configDriftStat: typeof import('../src/routes/screens/complianceModel').configDriftStat;

let tmpDir: string;
let appServer: Server;
let appBase: string;

let dirCounter = 0;
function freshDataDir(): string {
  return join(tmpDir, `d${dirCounter++}`);
}

const NOW = Date.parse('2026-07-25T12:00:00Z');

function makeService(opts: {
  dataDir?: string;
  inventory?: BackupInventoryRow[];
  demoMode?: boolean;
  collector?: (target: BackupTarget) => Promise<string>;
  keepVersions?: number;
}): ConfigBackupServiceT {
  return new ConfigBackupService({
    dataDir: opts.dataDir ?? freshDataDir(),
    keepVersions: opts.keepVersions,
    demoMode: () => opts.demoMode ?? true,
    inventory: () => opts.inventory ?? [],
    ...(opts.collector ? { collector: opts.collector } : {}),
    nowMs: () => NOW,
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-cfgbak-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({
    ConfigBackupService,
    ConfigBackupError,
    demoBaselineConfig,
    applyDemoDrift,
    configBackups: configBackupsSingleton,
  } = await import('../src/services/configBackup'));
  ({ createConfigBackupsRouter } = await import('../src/routes/configBackups'));
  ({ liveComplianceData, configDriftStat } = await import('../src/routes/screens/complianceModel'));
  ({ createApp } = await import('../src/index'));
  appServer = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => appServer.once('listening', resolve));
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// The shared LCS line diff (pure)
// ---------------------------------------------------------------------------

describe('diffConfigLines', () => {
  it('marks every line same for identical configs', () => {
    const lines = diffConfigLines('a\nb\nc', 'a\nb\nc');
    expect(lines.every((l) => l.kind === 'same')).toBe(true);
    expect(configDiffHasChanges(lines)).toBe(false);
  });

  it('aligns an inserted stanza instead of marking the rest changed (LCS)', () => {
    const before = ['hostname sw', 'ntp server 10.0.0.1', 'vlan 8', '    name mgmt', 'aaa new-model'].join('\n');
    const after = ['hostname sw', 'ntp server 10.0.0.1', 'vlan 8', '    name mgmt', 'vlan 99', '    name quarantine', 'aaa new-model'].join('\n');
    const lines = diffConfigLines(before, after);
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['vlan 99', '    name quarantine']);
    expect(lines.filter((l) => l.kind === 'del')).toEqual([]);
    // The trailing context line survives as context, not as a delete+add pair.
    expect(lines.filter((l) => l.kind === 'same').map((l) => l.text)).toContain('aaa new-model');
  });

  it('marks removals and renders changed blocks as del-then-add', () => {
    const lines = diffConfigLines('a\nold\nb', 'a\nnew\nb');
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['same:a', 'del:old', 'add:new', 'same:b']);
  });

  it('handles empty sides', () => {
    expect(diffConfigLines('', 'x\ny').map((l) => l.kind)).toEqual(['add', 'add']);
    expect(diffConfigLines('x\ny', '').map((l) => l.kind)).toEqual(['del', 'del']);
    expect(diffConfigLines('', '')).toEqual([]);
  });

  it('renders unified text with +/-/space prefixes DiffCode colours', () => {
    const text = unifiedConfigDiffText(diffConfigLines('a\nold', 'a\nnew'));
    expect(text).toBe('  a\n- old\n+ new');
  });
});

// ---------------------------------------------------------------------------
// Telling an unalignable diff apart from a wholesale rewrite
// ---------------------------------------------------------------------------

/** Two configs whose changed middle is too big for the LCS matrix, but which
 *  differ in only two lines. Trimming cannot shrink it: the first and last
 *  lines differ, so the whole file is the changed middle. */
function unalignablePair(): { before: string; after: string; shared: string[] } {
  const shared = Array.from({ length: 2100 }, (_, i) => `interface GigabitEthernet1/0/${i}`);
  return {
    before: ['hostname sw-old', ...shared, 'end-old'].join('\n'),
    after: ['hostname sw-new', ...shared, 'end-new'].join('\n'),
    shared,
  };
}

describe('diffConfigLinesWithFidelity', () => {
  it('reports an exact alignment as exact', () => {
    const result = diffConfigLinesWithFidelity('a\nold\nb', 'a\nnew\nb');
    expect(result.collapsed).toBe(false);
    expect(result.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['same:a', 'del:old', 'add:new', 'same:b']);
  });

  it('admits when the changed region was too large to align', () => {
    const { before, after } = unalignablePair();
    expect(diffConfigLinesWithFidelity(before, after).collapsed).toBe(true);
  });

  it('still returns a correct superset — no real change goes missing', () => {
    const { before, after } = unalignablePair();
    const { lines } = diffConfigLinesWithFidelity(before, after);
    const removed = lines.filter((l) => l.kind === 'del').map((l) => l.text);
    const added = lines.filter((l) => l.kind === 'add').map((l) => l.text);
    expect(removed).toContain('hostname sw-old');
    expect(added).toContain('hostname sw-new');
    expect(removed).toContain('end-old');
    expect(added).toContain('end-new');
  });

  it('counts identical lines on both sides, which is why the counts need a caveat', () => {
    const { before, after, shared } = unalignablePair();
    const { lines } = diffConfigLinesWithFidelity(before, after);
    const added = lines.filter((l) => l.kind === 'add').length;
    const removed = lines.filter((l) => l.kind === 'del').length;
    // Only two lines really differ on each side. The collapsed diff reports
    // every shared line as removed AND added, so the numbers an operator sees
    // overstate the change by three orders of magnitude.
    expect(added).toBe(shared.length + 2);
    expect(removed).toBe(shared.length + 2);
    expect(lines.some((l) => l.kind === 'same')).toBe(false);
  });

  it('leaves diffConfigLines behaving exactly as before', () => {
    const { before, after } = unalignablePair();
    expect(diffConfigLines(before, after)).toEqual(diffConfigLinesWithFidelity(before, after).lines);
    expect(diffConfigLines('a\nb', 'a\nb').every((l) => l.kind === 'same')).toBe(true);
  });

  it('bounds the matrix where the shared constant says it does', () => {
    expect(CONFIG_DIFF_MAX_CELLS).toBe(4_000_000);
  });
});

describe('ConfigBackupService.diffVersions — fidelity reaches the operator', () => {
  it('says so in the copied text when the diff could not be aligned', () => {
    const svc = makeService({ inventory: [{ name: 'sw-a', type: 'switch' }] });
    const { before, after } = unalignablePair();
    svc.recordSnapshot('sw-a', before, 'test');
    svc.recordSnapshot('sw-a', after, 'test');
    const diff = svc.diffVersions('sw-a', 1, 2);
    expect(diff.collapsed).toBe(true);
    for (const line of collapsedDiffNote()) expect(diff.text).toContain(line);
    // The note leads, so it is read before the wall of +/- lines, and it is
    // context rather than an added or removed config line.
    expect(diff.text.startsWith('! ')).toBe(true);
    expect(diff.text).toContain('upper bound');
  });

  it('stays silent on a diff that aligned — an always-on caveat says nothing', () => {
    const svc = makeService({ inventory: [{ name: 'sw-a', type: 'switch' }] });
    svc.recordSnapshot('sw-a', 'hostname sw-a\nntp server 10.0.0.1', 'test');
    svc.recordSnapshot('sw-a', 'hostname sw-a\nntp server 10.0.0.2', 'test');
    const diff = svc.diffVersions('sw-a', 1, 2);
    expect(diff.collapsed).toBe(false);
    expect(diff.text).not.toContain('!');
    expect(diff.text).toBe('  hostname sw-a\n- ntp server 10.0.0.1\n+ ntp server 10.0.0.2');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Snapshot storage + version cap
// ---------------------------------------------------------------------------

describe('ConfigBackupService.recordSnapshot', () => {
  it('stores v1 without drift, then an identical re-collection stores nothing', () => {
    const dir = freshDataDir();
    const svc = makeService({ dataDir: dir, inventory: [{ name: 'sw-a', type: 'switch' }] });
    const first = svc.recordSnapshot('sw-a', 'hostname sw-a\nntp server 10.0.0.1', 'test');
    expect(first.stored).toBe(true);
    expect(first.meta.version).toBe(1);
    expect(first.meta.driftFromPrevious).toBe(false);
    expect(first.meta.lines).toBe(2);
    expect(first.meta.takenAt).toBe(new Date(NOW).toISOString());

    const again = svc.recordSnapshot('sw-a', 'hostname sw-a\nntp server 10.0.0.1', 'test');
    expect(again.stored).toBe(false);
    expect(svc.listVersions('sw-a')).toHaveLength(1);
  });

  it('stores a changed config as drift from its predecessor', () => {
    const svc = makeService({ inventory: [{ name: 'sw-a', type: 'switch' }] });
    svc.recordSnapshot('sw-a', 'hostname sw-a\nntp server 10.0.0.1', 'test');
    const second = svc.recordSnapshot('sw-a', 'hostname sw-a\nntp server 10.0.0.2', 'test');
    expect(second.stored).toBe(true);
    expect(second.meta.version).toBe(2);
    expect(second.meta.driftFromPrevious).toBe(true);
  });

  it('normalizes CRLF so line-ending noise is not drift', () => {
    const svc = makeService({ inventory: [{ name: 'sw-a', type: 'switch' }] });
    svc.recordSnapshot('sw-a', 'a\nb', 'test');
    expect(svc.recordSnapshot('sw-a', 'a\r\nb\r\n', 'test').stored).toBe(false);
  });

  it('refuses an empty config body', () => {
    const svc = makeService({});
    expect(() => svc.recordSnapshot('sw-a', '   \n  ', 'test')).toThrowError(ConfigBackupError);
  });

  it('keeps only the last N versions, files included', () => {
    const dir = freshDataDir();
    const svc = makeService({ dataDir: dir, keepVersions: 3, inventory: [{ name: 'sw-a', type: 'switch' }] });
    for (let i = 1; i <= 5; i += 1) {
      svc.recordSnapshot('sw-a', `hostname sw-a\n! generation ${i}`, 'test');
    }
    const versions = svc.listVersions('sw-a');
    expect(versions.map((v) => v.version)).toEqual([5, 4, 3]);
    const deviceDir = join(dir, 'config-backups', 'sw-a');
    expect(readdirSync(deviceDir).sort()).toEqual(['index.json', 'v3.cfg', 'v4.cfg', 'v5.cfg']);
    expect(existsSync(join(deviceDir, 'v1.cfg'))).toBe(false);
    // The pruned bodies are unreadable; the kept ones are intact.
    expect(svc.readVersionContent('sw-a', 1)).toBeNull();
    expect(svc.readVersionContent('sw-a', 5)).toBe('hostname sw-a\n! generation 5');
  });

  it('honours the shared default cap', () => {
    expect(CONFIG_BACKUP_KEEP_VERSIONS).toBe(10);
    const svc = makeService({ inventory: [{ name: 'sw-a', type: 'switch' }] });
    for (let i = 1; i <= 12; i += 1) {
      svc.recordSnapshot('sw-a', `! generation ${i}`, 'test');
    }
    expect(svc.listVersions('sw-a')).toHaveLength(10);
  });

  it('appends one audit-log line per stored snapshot, never the config body', () => {
    const dir = freshDataDir();
    const svc = makeService({ dataDir: dir, inventory: [{ name: 'sw-a', type: 'switch', plane: 'LOCAL' }] });
    svc.recordSnapshot('sw-a', 'hostname sw-a', 'test');
    svc.recordSnapshot('sw-a', 'hostname sw-a\nntp server 10.0.0.1', 'test');
    const log = readFileSync(join(dir, 'change-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ event: 'config-backup', device: 'sw-a', result: 'snapshot', plane: 'LOCAL' });
    expect(log[1]).toMatchObject({ event: 'config-backup', device: 'sw-a', result: 'snapshot+drift' });
    expect(JSON.stringify(log)).not.toContain('hostname sw-a');
  });
});

// ---------------------------------------------------------------------------
// Diff between stored versions
// ---------------------------------------------------------------------------

describe('ConfigBackupService.diffVersions', () => {
  it('diffs two stored versions with counts and unified text', () => {
    const svc = makeService({ inventory: [{ name: 'sw-a', type: 'switch' }] });
    svc.recordSnapshot('sw-a', 'hostname sw-a\nntp server 10.0.0.1\nlogging 10.0.0.5', 'test');
    svc.recordSnapshot('sw-a', 'hostname sw-a\nntp server 10.0.0.2\nlogging 10.0.0.5\nvlan 99', 'test');
    const diff = svc.diffVersions('sw-a', 1, 2);
    expect(diff.added).toBe(2); // ntp replacement line + vlan 99
    expect(diff.removed).toBe(1);
    expect(diff.fromTakenAt).toBe(new Date(NOW).toISOString());
    expect(diff.text).toContain('- ntp server 10.0.0.1');
    expect(diff.text).toContain('+ ntp server 10.0.0.2');
    expect(diff.text).toContain('+ vlan 99');
  });

  it('rejects inverted or non-numeric ranges with a 400-class error', () => {
    const svc = makeService({ inventory: [{ name: 'sw-a', type: 'switch' }] });
    svc.recordSnapshot('sw-a', 'a', 'test');
    svc.recordSnapshot('sw-a', 'b', 'test');
    for (const [from, to] of [[2, 1], [1, 1], ['x', 2], [0, 1]] as const) {
      try {
        svc.diffVersions('sw-a', from, to);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigBackupError);
        expect((err as InstanceType<typeof ConfigBackupError>).status).toBe(400);
      }
    }
  });

  it('404s an unknown version', () => {
    const svc = makeService({ inventory: [{ name: 'sw-a', type: 'switch' }] });
    svc.recordSnapshot('sw-a', 'a', 'test');
    try {
      svc.diffVersions('sw-a', 1, 9);
      expect.unreachable();
    } catch (err) {
      expect((err as InstanceType<typeof ConfigBackupError>).status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Demo sweep — deterministic synthesis with drift already on file
// ---------------------------------------------------------------------------

describe('ConfigBackupService demo sweep', () => {
  const INVENTORY: BackupInventoryRow[] = [
    { name: 'sw-b', type: 'switch' },
    { name: 'sw-a', type: 'switch' },
    { name: 'mm-1', type: 'controller' },
    { name: 'ap-1', type: 'ap' },
  ];

  it('seeds every shell-capable device and opens with one drifted device per shell class', async () => {
    const svc = makeService({ inventory: INVENTORY });
    const result = await svc.sweep();
    // 3 eligible (2 sw + 1 aos); the ap has no config channel.
    expect(result.swept).toBe(3);
    // sw-a drift: baseline + drifted = 2 stored; mm-1 drift: 2; sw-b: 1.
    expect(result.stored).toBe(5);

    const rows = svc.listDeviceRows();
    const byName = new Map(rows.map((r) => [r.device, r]));
    expect(byName.get('ap-1')?.status).toBe('no-source');
    expect(byName.get('ap-1')?.note).toMatch(/no read-only config channel/);
    expect(byName.get('sw-a')?.drift).toBe(true);
    expect(byName.get('sw-a')?.versions).toBe(2);
    expect(byName.get('mm-1')?.drift).toBe(true);
    expect(byName.get('sw-b')?.drift).toBe(false);
    expect(byName.get('sw-b')?.versions).toBe(1);

    const summary = svc.summary();
    expect(summary).toEqual({ total: 4, eligible: 3, backedUp: 3, drift: 2, failed: 0 });

    // The seeded baseline is backdated ahead of the drifted snapshot, and the
    // provenance says demo on both.
    const versions = svc.listVersions('sw-a');
    expect(versions).toHaveLength(2);
    expect(versions[0]!.source).toBe('demo synthesis');
    expect(Date.parse(versions[0]!.takenAt)).toBeGreaterThan(Date.parse(versions[1]!.takenAt));
  });

  it('is deterministic — a second sweep stores nothing new', async () => {
    const svc = makeService({ inventory: INVENTORY });
    await svc.sweep();
    const second = await svc.sweep();
    expect(second.stored).toBe(0);
    expect(svc.summary().drift).toBe(2);
  });

  it('drift content is plausible per shell class', () => {
    const cx = demoBaselineConfig({ name: 'sw-a' }, 'sw');
    const cxDrifted = applyDemoDrift(cx, 'sw');
    expect(cxDrifted).toContain('ntp server 10.42.0.21 iburst');
    expect(cxDrifted).toContain('vlan 99');
    const aos = demoBaselineConfig({ name: 'mm-1' }, 'aos');
    expect(applyDemoDrift(aos, 'aos')).toContain('    mtu 1500');
  });
});

// ---------------------------------------------------------------------------
// Live sweep — injected collector (no network)
// ---------------------------------------------------------------------------

describe('ConfigBackupService live sweep', () => {
  it('collects through the injected channel and detects drift across sweeps', async () => {
    let config = 'hostname sw-live\nntp server 10.0.0.1';
    const svc = makeService({
      demoMode: false,
      inventory: [{ name: 'sw-live', type: 'switch', ip: '10.48.0.10' }],
      collector: async () => config,
    });
    const first = await svc.sweep();
    expect(first).toEqual({ swept: 1, stored: 1, failed: 0 });
    expect((await svc.sweep()).stored).toBe(0); // unchanged config — no new version
    config = 'hostname sw-live\nntp server 10.0.0.2';
    const third = await svc.sweep();
    expect(third.stored).toBe(1);
    expect(svc.summary().drift).toBe(1);
    expect(svc.listDeviceRows()[0]?.latest?.source).toBe('ssh show running-config');
  });

  it('records per-device failures honestly and clears them on recovery', async () => {
    let fail = true;
    const svc = makeService({
      demoMode: false,
      inventory: [{ name: 'sw-live', type: 'switch', ip: '10.48.0.10' }],
      collector: async () => {
        if (fail) throw new Error('ssh to 10.48.0.10 failed: timed out');
        return 'hostname sw-live';
      },
    });
    const result = await svc.sweep();
    expect(result.failed).toBe(1);
    const row = svc.listDeviceRows()[0]!;
    expect(row.status).toBe('failed');
    expect(row.note).toContain('timed out');
    expect(svc.summary().failed).toBe(1);

    fail = false;
    await svc.sweep();
    expect(svc.listDeviceRows()[0]?.status).toBe('ok');
    expect(svc.listDeviceRows()[0]?.note).toBeUndefined();
  });

  it('never stacks a second sweep on one still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const svc = makeService({
      demoMode: false,
      inventory: [{ name: 'sw-live', type: 'switch', ip: '10.48.0.10' }],
      collector: async () => {
        calls += 1;
        await gate;
        return 'hostname sw-live';
      },
    });
    const first = svc.sweep();
    const second = await svc.sweep();
    expect(second.skipped).toBe(true);
    release();
    await first;
    expect(calls).toBe(1);
  });

  it('classifies shell class by device TYPE in live mode, not the demo name prefixes', async () => {
    // A real tenant names a switch 'AP-Floor3' — the demo prefix rule would
    // call it cloud-claimed; the inventory type says otherwise.
    const svc = makeService({
      demoMode: false,
      inventory: [{ name: 'AP-Floor3', type: 'switch', ip: '10.48.0.11' }],
      collector: async () => 'hostname AP-Floor3',
    });
    const result = await svc.sweep();
    expect(result.swept).toBe(1);
    expect(svc.listDeviceRows()[0]?.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Route shapes
// ---------------------------------------------------------------------------

describe('config backup routes', () => {
  let routeServer: Server;
  let routeBase: string;

  beforeAll(async () => {
    const svc = makeService({
      inventory: [
        { name: 'sw-a', type: 'switch', plane: 'LOCAL' },
        { name: 'ap-1', type: 'ap' },
      ],
    });
    await svc.sweep();
    const app = express();
    app.use('/api', createConfigBackupsRouter(svc));
    routeServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => routeServer.once('listening', resolve));
    routeBase = `http://127.0.0.1:${(routeServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => routeServer.close(() => resolve()));
  });

  it('GET /api/config-backups lists devices with summary and demo provenance', async () => {
    const { status, body } = await getJson(routeBase, '/api/config-backups');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(typeof body.note).toBe('string');
    expect(body.summary).toEqual({ total: 2, eligible: 1, backedUp: 1, drift: 1, failed: 0 });
    const byName = new Map(body.devices.map((d: any) => [d.device, d]));
    expect(byName.get('sw-a')).toMatchObject({ status: 'ok', drift: true, versions: 2 });
    expect(byName.get('ap-1')).toMatchObject({ status: 'no-source', versions: 0, latest: null });
  });

  it('GET /api/config-backups/export returns roster CSV without config bodies (Loop 96)', async () => {
    const r = await fetch(`${routeBase}/api/config-backups/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('device');
    expect(header).toContain('drift');
    expect(header).toContain('latestSource');
    expect(text).toMatch(/sw-a/);
    expect(text).toMatch(/ap-1/);
    // Never ship running-config bodies or secret-shaped cells.
    expect(text).not.toMatch(/hostname |password|secret|BEGIN CERTIFICATE/i);

    const drifted = await fetch(`${routeBase}/api/config-backups/export?drift=1`);
    expect(drifted.status).toBe(200);
    const driftedText = await drifted.text();
    expect(driftedText).toMatch(/sw-a/);
    expect(driftedText).not.toMatch(/ap-1/);
  });

  it('list + export honour q/plane/status filters (Loop 105)', async () => {
    const q = await fetch(`${routeBase}/api/config-backups/export?q=sw-a`);
    expect(q.status).toBe(200);
    const qText = await q.text();
    expect(qText).toMatch(/sw-a/);
    expect(qText).not.toMatch(/ap-1/);

    const status = await fetch(`${routeBase}/api/config-backups/export?status=no-source`);
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(statusText).toMatch(/ap-1/);
    expect(statusText).not.toMatch(/sw-a,/);

    const list = await getJson(routeBase, '/api/config-backups?status=no-source');
    expect(list.status).toBe(200);
    const devices = list.body.devices as Array<{ device: string; status: string }>;
    expect(devices.length).toBeGreaterThan(0);
    expect(devices.every((d) => d.status === 'no-source')).toBe(true);
    // Summary remains the unfiltered estate rollup.
    expect(list.body.summary.total).toBeGreaterThan(devices.length);

    const unknown = await fetch(`${routeBase}/api/config-backups/export?status=bogus&drift=maybe`);
    expect(unknown.status).toBe(200);
    const unknownText = await unknown.text();
    // Unknown enum/flag → honest no-op (full roster).
    expect(unknownText).toMatch(/sw-a/);
    expect(unknownText).toMatch(/ap-1/);
  });

  it('GET /api/config-backups/:device/versions returns metadata newest-first', async () => {
    const { status, body } = await getJson(routeBase, '/api/config-backups/sw-a/versions');
    expect(status).toBe(200);
    expect(body.device).toBe('sw-a');
    expect(body.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(body.versions[0]).toMatchObject({ driftFromPrevious: true, source: 'demo synthesis' });
    expect(typeof body.versions[0].sha256).toBe('string');
  });

  it('GET /api/config-backups/:device/versions 404s an unknown device', async () => {
    const { status, body } = await getJson(routeBase, '/api/config-backups/nope/versions');
    expect(status).toBe(404);
    expect(body.error).toContain('nope');
  });

  it('GET /api/config-backups/:device/diff returns the unified diff between two versions', async () => {
    const { status, body } = await getJson(routeBase, '/api/config-backups/sw-a/diff?from=1&to=2');
    expect(status).toBe(200);
    expect(body).toMatchObject({ device: 'sw-a', fromVersion: 1, toVersion: 2 });
    expect(body.added).toBeGreaterThan(0);
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.text).toContain('ntp server 10.42.0.21');
    expect(body.lines.some((l: any) => l.kind === 'add' && l.text === 'vlan 99')).toBe(true);
  });

  it('GET /api/config-backups/:device/diff validates its parameters', async () => {
    expect((await getJson(routeBase, '/api/config-backups/sw-a/diff')).status).toBe(400);
    expect((await getJson(routeBase, '/api/config-backups/sw-a/diff?from=2&to=1')).status).toBe(400);
    expect((await getJson(routeBase, '/api/config-backups/sw-a/diff?from=1&to=9')).status).toBe(404);
  });

  it('is registered on the real app: GET /api/config-backups answers the demo roster', async () => {
    const { status, body } = await getJson(appBase, '/api/config-backups');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    // No sweep has run for the singleton: shell-capable fixtures are pending,
    // APs are no-source, nothing claims a backup yet.
    expect(body.summary.backedUp).toBe(0);
    expect(body.devices.length).toBeGreaterThan(0);
    const swCore = body.devices.find((d: any) => d.device === 'sw-core-a');
    expect(swCore.status).toBe('pending');

    // Sweep the singleton (demo synthesis into the tmp data dir) and the same
    // route then reports the seeded drift — the full loop through createApp.
    await configBackupsSingleton.sweep();
    const after = await getJson(appBase, '/api/config-backups');
    expect(after.body.summary.backedUp).toBeGreaterThan(0);
    expect(after.body.summary.drift).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The Compliance 'Config drift' card (complianceModel.ts)
// ---------------------------------------------------------------------------

describe('Compliance Config drift card', () => {
  it('keeps the honest dead state when the caller does not track backups', () => {
    expect(configDriftStat(undefined)).toEqual({
      label: 'Config drift',
      value: '—',
      delta: 'no running-config baseline source',
      tone: 'neutral',
    });
    expect(configDriftStat(null)).toMatchObject({ value: '—' });
  });

  it('says "not collected yet" rather than "no drift" before the first snapshot', () => {
    const stat = configDriftStat({ total: 4, eligible: 3, backedUp: 0, drift: 0, failed: 0 });
    expect(stat.value).toBe('—');
    expect(stat.delta).toBe('no config snapshots collected yet');
    expect(stat.tone).toBe('neutral');
  });

  it('reports drift as a negative count over the backed-up devices', () => {
    const stat = configDriftStat({ total: 4, eligible: 3, backedUp: 3, drift: 2, failed: 0 });
    expect(stat).toEqual({
      label: 'Config drift',
      value: '2',
      delta: 'of 3 devices with config snapshots',
      tone: 'negative',
    });
  });

  it('a clean backup estate earns the positive tone', () => {
    expect(configDriftStat({ total: 4, eligible: 3, backedUp: 3, drift: 0, failed: 0 }).tone).toBe('positive');
  });

  it('liveComplianceData lights the card and the evidence line from the summary', () => {
    const summary = { total: 2, eligible: 2, backedUp: 2, drift: 1, failed: 0 };
    const data = liveComplianceData(DEVICES.slice(0, 2), [], summary);
    expect(data.stats[4]).toMatchObject({ label: 'Config drift', value: '1', tone: 'negative' });
    expect(data.diff).toContain('1 of 2 devices with config snapshots differ from their previous snapshot');
    expect(data.diff).not.toContain('cannot be evaluated');
  });

  it('liveComplianceData without a summary keeps the original dead card', () => {
    const data = liveComplianceData(DEVICES.slice(0, 2), []);
    expect(data.stats[4]).toMatchObject({ label: 'Config drift', value: '—' });
    expect(data.diff).toContain('Running configuration drift cannot be evaluated');
  });
});

// ---------------------------------------------------------------------------
// The /api/devices/:name config join (routes/screens.ts snapshotDeviceConfig)
// ---------------------------------------------------------------------------

describe('the /api/devices/:name config-backup join', () => {
  // Runs after the 'config backup routes' describe, whose last test swept the
  // singleton in demo mode: every shell-class demo fixture has one snapshot on
  // file by then (the two drift devices have two), and AP-class fixtures have
  // none — exactly the present/absent split the join has to honour.
  it('keeps the authored fixture config for a device with no snapshots', async () => {
    const { status, body } = await getJson(appBase, '/api/devices/ap-3f-12');
    expect(status).toBe(200);
    expect(body.config.running).toBe(DEVICE_CONFIGS.none.running);
    expect(body.config.history).toEqual(DEVICE_CONFIGS.none.history);
    expect(body.config.provenance).toBeUndefined();
  });

  it('joins the snapshot: running body, empty single-version diff, real history', async () => {
    const { status, body } = await getJson(appBase, '/api/devices/sw-core-a');
    expect(status).toBe(200);
    expect(body.config.meta).toBe('SNAPSHOT v1 · 1 VERSION ON FILE');
    expect(body.config.running).toContain('hostname sw-core-a');
    // One version is a fact, not a comparison — never a fabricated diff.
    expect(body.config.diff).toBe('');
    expect(body.config.history).toHaveLength(1);
    expect(body.config.history[0]).toMatchObject({
      what: expect.stringContaining('Snapshot v1'),
      who: 'demo synthesis',
      tag: 'snapshot',
      tone: 'neutral',
    });
    // The row carries the collection instant as data (ISO) for the browser to
    // stamp, never a server-clock rendering.
    expect(body.config.history[0].when).toBe(new Date(body.config.history[0].when).toISOString());
    expect(body.config.provenance).toMatchObject({
      version: 1,
      versions: 1,
      source: 'demo synthesis',
    });
    expect(body.config.provenance.takenAt).toBe(new Date(body.config.provenance.takenAt).toISOString());
  });

  it('diffs the two newest versions and leads the history with the drifted one', async () => {
    const baseline = configBackupsSingleton.readVersionContent('sw-core-a', 1);
    expect(baseline).not.toBeNull();
    const drifted = `${baseline}\nvlan 99\n    name quarantine`;
    configBackupsSingleton.recordSnapshot('sw-core-a', drifted, 'test drift', '2026-07-25T18:04:00Z');

    const { body } = await getJson(appBase, '/api/devices/sw-core-a');
    expect(body.config.meta).toBe('SNAPSHOT v2 · 2 VERSIONS ON FILE');
    expect(body.config.running).toBe(drifted);
    expect(body.config.diff).toContain('+ vlan 99');
    expect(body.config.diff).toContain('+     name quarantine');
    expect(body.config.history.map((h: any) => h.what)).toEqual([
      expect.stringContaining('Snapshot v2'),
      expect.stringContaining('Snapshot v1'),
    ]);
    expect(body.config.history[0]).toMatchObject({ tag: 'drift', tone: 'warning', who: 'test drift' });
    expect(body.config.history[1]).toMatchObject({ tag: 'snapshot', tone: 'neutral' });
    expect(body.config.provenance).toMatchObject({ version: 2, versions: 2, source: 'test drift' });
  });

  it('serves CRLF-collected bodies normalized, never with the carriage returns', async () => {
    configBackupsSingleton.recordSnapshot('sw-core-a', 'hostname sw-core-a\r\nvlan 8\r\n    name mgmt\r\n', 'crlf test');
    const { body } = await getJson(appBase, '/api/devices/sw-core-a');
    expect(body.config.running).toBe('hostname sw-core-a\nvlan 8\n    name mgmt');
    expect(body.config.running).not.toContain('\r');
  });

  it('keeps pruning gaps: the history is the versions on disk, numbers included', async () => {
    // Fourteen versions total (v2..v14 follow the three above) — the rolling
    // window keeps ten, so v1..v4 are pruned and the list must show the gap.
    for (let v = 4; v <= 14; v += 1) {
      configBackupsSingleton.recordSnapshot('sw-core-a', `hostname sw-core-a\n! revision ${v}`, 'churn test');
    }
    const { body } = await getJson(appBase, '/api/devices/sw-core-a');
    expect(body.config.history).toHaveLength(CONFIG_BACKUP_KEEP_VERSIONS);
    expect(body.config.history[0].what).toContain('Snapshot v14');
    expect(body.config.history[CONFIG_BACKUP_KEEP_VERSIONS - 1].what).toContain('Snapshot v5');
    expect(body.config.provenance).toMatchObject({ version: 14, versions: CONFIG_BACKUP_KEEP_VERSIONS });
  });
});
