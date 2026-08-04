import { describe, expect, it } from 'vitest';
import {
  paletteActionCue,
  parsePaletteAction,
  stripActionParam,
} from './actionDeepLink';

describe('parsePaletteAction', () => {
  it('accepts known action ids case-insensitively', () => {
    expect(parsePaletteAction('ticket')).toBe('ticket');
    expect(parsePaletteAction(' Silence ')).toBe('silence');
    expect(parsePaletteAction('DIAGNOSTICS')).toBe('diagnostics');
  });

  it('rejects unknown or empty values', () => {
    expect(parsePaletteAction(null)).toBeNull();
    expect(parsePaletteAction('')).toBeNull();
    expect(parsePaletteAction('export')).toBeNull();
  });
});

describe('paletteActionCue', () => {
  it('returns distinct operator copy per action', () => {
    expect(paletteActionCue('ticket').title).toMatch(/ticket/i);
    expect(paletteActionCue('silence').body).toMatch(/reason/i);
    expect(paletteActionCue('diagnostics').body).toMatch(/live inventory/i);
  });
});

describe('stripActionParam', () => {
  it('removes action and preserves other params', () => {
    const next = stripActionParam(new URLSearchParams('tab=queue&action=ticket&q=p1'));
    expect(next?.get('action')).toBeNull();
    expect(next?.get('tab')).toBe('queue');
    expect(next?.get('q')).toBe('p1');
  });

  it('returns null when action is absent', () => {
    expect(stripActionParam(new URLSearchParams('tab=silences'))).toBeNull();
  });
});
