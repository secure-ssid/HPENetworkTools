import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let createApp: typeof import('../src/index').createApp;
let visualReferences: typeof import('../src/services/visualReferences').visualReferences;

let tmpDir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  const testRoot = resolve(process.cwd(), '.agent-tmp');
  mkdirSync(testRoot, { recursive: true });
  tmpDir = mkdtempSync(join(testRoot, 'visual-refs-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ createApp } = await import('../src/index'));
  ({ visualReferences } = await import('../src/services/visualReferences'));
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) =>
    server.close((err) => (err ? reject(err) : resolveClose())),
  );
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

beforeEach(() => {
  for (const row of visualReferences.list()) {
    try {
      visualReferences.delete(row.id);
    } catch {
      /* already gone */
    }
  }
});

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('visual references API', () => {
  it('creates a url reference with owner attribution', async () => {
    const created = await postJson('/api/visual-references', {
      target: { kind: 'site', id: 'northgate', plane: 'mist' },
      kind: 'floorplan',
      source: 'url',
      title: 'Northgate layout',
      url: 'https://maps.example/northgate.png',
      attribution: 'facilities',
    });
    expect(created.status).toBe(201);
    expect(created.body.reference).toMatchObject({
      title: 'Northgate layout',
      owner: 'operator',
      source: 'url',
      attribution: 'facilities',
    });

    const listed = await get('/api/visual-references?kind=site&id=northgate&plane=mist');
    expect(listed.status).toBe(200);
    expect(listed.body.references).toHaveLength(1);
  });

  it('rejects non-https external urls', async () => {
    const created = await postJson('/api/visual-references', {
      target: { kind: 'device', id: 'sw-01' },
      kind: 'image',
      source: 'url',
      title: 'bad',
      url: 'http://example.com/x.png',
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toMatch(/https/i);
  });

  it('accepts a png upload and streams it back', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const res = await fetch(`${base}/api/visual-assets`, {
      method: 'POST',
      headers: {
        origin: base,
        'content-type': 'image/png',
        'x-visual-target-kind': 'device',
        'x-visual-target-id': 'sw-01',
        'x-visual-kind': 'port-map',
        'x-visual-title': 'SW-01 ports',
        'x-visual-attribution': 'noc',
      },
      body: png,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { reference: { assetId: string; title: string } };
    expect(body.reference.title).toBe('SW-01 ports');
    expect(body.reference.assetId).toBeTruthy();

    const asset = await fetch(`${base}/api/visual-assets/${body.reference.assetId}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/image\/png/);
    const bytes = Buffer.from(await asset.arrayBuffer());
    expect(bytes.equals(png)).toBe(true);
  });

  it('rejects path-traversal titles and unknown mime types', async () => {
    const badName = await fetch(`${base}/api/visual-assets`, {
      method: 'POST',
      headers: {
        origin: base,
        'content-type': 'text/plain',
        'x-visual-target-kind': 'device',
        'x-visual-target-id': 'sw-01',
        'x-visual-kind': 'document',
        'x-visual-title': '../secrets',
      },
      body: Buffer.from('hello'),
    });
    expect(badName.status).toBe(400);

    const badMime = await fetch(`${base}/api/visual-assets`, {
      method: 'POST',
      headers: {
        origin: base,
        'content-type': 'application/x-msdownload',
        'x-visual-target-kind': 'device',
        'x-visual-target-id': 'sw-01',
        'x-visual-kind': 'document',
        'x-visual-title': 'payload',
      },
      body: Buffer.from('MZ'),
    });
    expect(badMime.status).toBe(400);
  });

  it('deletes a reference', async () => {
    const created = await postJson('/api/visual-references', {
      target: { kind: 'client', id: 'aa:bb:cc:dd:ee:ff' },
      kind: 'native-link',
      source: 'native',
      title: 'ClearPass endpoint',
      url: 'https://cppm.example/endpoint/1',
    });
    const id = created.body.reference.id as string;
    const del = await fetch(`${base}/api/visual-references/${id}`, {
      method: 'DELETE',
      headers: { origin: base },
    });
    expect(del.status).toBe(200);
    const listed = await get('/api/visual-references?kind=client&id=aa:bb:cc:dd:ee:ff');
    expect(listed.body.references).toHaveLength(0);
  });

  it('returns empty list when nothing is stored', async () => {
    const listed = await get('/api/visual-references');
    expect(listed.status).toBe(200);
    expect(listed.body.references).toEqual([]);
  });
});
