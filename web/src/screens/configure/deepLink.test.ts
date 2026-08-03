import { describe, expect, it } from 'vitest';
import type { SsidObject } from '@hpe/shared';
import {
  buildSsidDeepLink,
  locateSsidDeepLink,
  normalizeSsidDeepLink,
  parseSsidDeepLink,
} from './deepLink';

const MIST_ROW: SsidObject = {
  kind: 'ssid',
  name: 'Clinical & Research',
  vlan: 'vlan 822',
  security: 'WPA2-PSK',
  targets: 'Campus-02 Research · enabled',
  plane: 'MIST',
  tone: 'info',
};

const CENTRAL_ROW: SsidObject = {
  ...MIST_ROW,
  plane: 'CENTRAL',
  targets: 'Northgate Clinic',
};

describe('SSID Configure deep links', () => {
  it('builds a URLSearchParams-safe exact identity and parses it back', () => {
    const link = buildSsidDeepLink(MIST_ROW);
    if (!link) throw new Error('fixture must build a WLAN link');

    expect(link).toBe(
      '/configure?edit=ssid&plane=MIST&name=Clinical+%26+Research&vlan=vlan+822&targets=Campus-02+Research+%C2%B7+enabled',
    );
    expect(parseSsidDeepLink(link.split('?')[1]!)).toEqual({
      plane: 'MIST',
      name: 'Clinical & Research',
      vlan: 'vlan 822',
      targets: 'Campus-02 Research · enabled',
    });
  });

  it('normalizes surrounding identity whitespace without accepting an unsupported plane', () => {
    expect(
      normalizeSsidDeepLink({
        plane: ' mist ',
        name: ' Clinical ',
        vlan: ' vlan 822 ',
        targets: ' Campus ',
      }),
    ).toEqual({ plane: 'MIST', name: 'Clinical', vlan: 'vlan 822', targets: 'Campus' });
    expect(normalizeSsidDeepLink({ plane: 'CENTRAL + MIST', name: 'Clinical', vlan: '822', targets: 'Campus' })).toBeNull();
  });

  it('rejects missing, duplicated, or malformed query identities', () => {
    expect(parseSsidDeepLink('edit=ssid&plane=MIST&name=Clinical&vlan=822')).toBeNull();
    expect(parseSsidDeepLink('edit=ssid&plane=MIST&plane=CENTRAL&name=Clinical&vlan=822&targets=Campus')).toBeNull();
    expect(parseSsidDeepLink('edit=vlan&plane=MIST&name=Clinical&vlan=822&targets=Campus')).toBeNull();
  });

  it('locates only one loaded row using every identity field', () => {
    const link = buildSsidDeepLink(MIST_ROW);
    if (!link) throw new Error('fixture must build a WLAN link');
    const identity = parseSsidDeepLink(link.split('?')[1]!);
    if (!identity) throw new Error('fixture link must parse');
    expect(locateSsidDeepLink([MIST_ROW, CENTRAL_ROW], identity)).toBe(MIST_ROW);
    expect(locateSsidDeepLink([MIST_ROW, { ...MIST_ROW }], identity)).toBeNull();
    expect(locateSsidDeepLink([MIST_ROW], { ...identity, targets: 'Other site' })).toBeNull();
  });

  it('uses the originating plane to resolve a multi-plane inventory row', () => {
    const sharedRow: SsidObject = { ...CENTRAL_ROW, plane: 'CENTRAL + MIST' };
    const link = buildSsidDeepLink(sharedRow, 'CENTRAL');
    if (!link) throw new Error('Central source row must build a link');
    const identity = parseSsidDeepLink(link.split('?')[1]!);
    if (!identity) throw new Error('fixture link must parse');

    expect(locateSsidDeepLink([sharedRow], identity)).toBe(sharedRow);
    expect(buildSsidDeepLink(sharedRow, 'MIST')).not.toBeNull();
    expect(buildSsidDeepLink(MIST_ROW, 'CENTRAL')).toBeNull();
  });
});
