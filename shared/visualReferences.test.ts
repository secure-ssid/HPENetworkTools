import { describe, expect, it } from 'vitest';
import {
  CONFIG_ACTION_CAPABILITIES,
  configCapabilitiesFor,
  isSafeExternalUrl,
  parseVisualReferenceDraft,
} from './visualReferences';

describe('parseVisualReferenceDraft', () => {
  it('accepts a floorplan upload draft', () => {
    expect(
      parseVisualReferenceDraft({
        target: { kind: 'site', id: 'northgate', plane: 'mist' },
        kind: 'floorplan',
        source: 'upload',
        title: 'Northgate layout',
      }),
    ).toMatchObject({ target: { kind: 'site', plane: 'mist' }, kind: 'floorplan' });
  });

  it('rejects non-https external urls', () => {
    expect(() =>
      parseVisualReferenceDraft({
        target: { kind: 'client', id: 'aa:bb' },
        kind: 'image',
        source: 'url',
        url: 'http://example.com/x.png',
        title: 'x',
      }),
    ).toThrow(/https/);
  });

  it('allows loopback http urls for the lab', () => {
    expect(
      parseVisualReferenceDraft({
        target: { kind: 'device', id: 'sw-01' },
        kind: 'document',
        source: 'url',
        url: 'http://127.0.0.1:8080/notes.md',
        title: 'lab notes',
      }).url,
    ).toBe('http://127.0.0.1:8080/notes.md');
  });

  it('rejects unknown fields', () => {
    expect(() =>
      parseVisualReferenceDraft({
        target: { kind: 'site', id: 'a' },
        kind: 'map',
        source: 'native',
        url: 'https://console.example/site',
        title: 'console',
        diskPath: '/tmp/x',
      }),
    ).toThrow(/unknown field/);
  });
});

describe('isSafeExternalUrl', () => {
  it('accepts https and loopback only', () => {
    expect(isSafeExternalUrl('https://maps.example/x')).toBe(true);
    expect(isSafeExternalUrl('http://localhost/x')).toBe(true);
    expect(isSafeExternalUrl('http://evil.example/x')).toBe(false);
    expect(isSafeExternalUrl('ftp://files/x')).toBe(false);
  });
});

describe('config action capabilities', () => {
  it('lists only real product actions and keeps OpsRamp read-only', () => {
    expect(CONFIG_ACTION_CAPABILITIES.some((c) => c.id === 'central-ssid-edit')).toBe(true);
    const ops = configCapabilitiesFor({ plane: 'OPSRAMP' });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.readOnlyReason).toMatch(/does not push/i);
  });

  it('filters by plane and target kind', () => {
    const mistSsids = configCapabilitiesFor({ plane: 'MIST', targetKind: 'ssid' });
    expect(mistSsids.map((c) => c.id)).toEqual(['mist-ssid-edit']);
  });
});
