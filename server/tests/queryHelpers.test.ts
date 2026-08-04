/**
 * Loop 105 / 108 / 111 — shared queryString / queryFlag / queryOneOf / queryInt / queryTokens.
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { queryFlag, queryInt, queryOneOf, queryString, queryTokens } from '../src/lib/query';

function req(query: Record<string, unknown> = {}): Pick<Request, 'query'> {
  return { query } as Pick<Request, 'query'>;
}

describe('queryString', () => {
  it('trims string values and ignores non-strings', () => {
    expect(queryString(req({ q: '  Branch HQ  ' }), 'q')).toBe('Branch HQ');
    expect(queryString(req({}), 'q')).toBe('');
    expect(queryString(req({ q: ['a', 'b'] }), 'q')).toBe('');
    expect(queryString(req({ q: 12 }), 'q')).toBe('');
  });
});

describe('queryFlag', () => {
  it('parses truthy / falsy tokens and leaves unknowns null', () => {
    expect(queryFlag(req({ drift: '1' }), 'drift')).toBe(true);
    expect(queryFlag(req({ drift: 'TRUE' }), 'drift')).toBe(true);
    expect(queryFlag(req({ drift: 'yes' }), 'drift')).toBe(true);
    expect(queryFlag(req({ drift: 'on' }), 'drift')).toBe(true);
    expect(queryFlag(req({ drift: '0' }), 'drift')).toBe(false);
    expect(queryFlag(req({ drift: 'false' }), 'drift')).toBe(false);
    expect(queryFlag(req({ drift: 'OFF' }), 'drift')).toBe(false);
    expect(queryFlag(req({ drift: 'no' }), 'drift')).toBe(false);
    expect(queryFlag(req({}), 'drift')).toBeNull();
    expect(queryFlag(req({ drift: '' }), 'drift')).toBeNull();
    expect(queryFlag(req({ drift: 'maybe' }), 'drift')).toBeNull();
  });
});

describe('queryOneOf', () => {
  const statuses = ['ok', 'pending', 'no-source', 'failed'] as const;

  it('matches case-insensitively and ignores unknowns', () => {
    expect(queryOneOf(req({ status: 'OK' }), 'status', statuses)).toBe('ok');
    expect(queryOneOf(req({ status: 'No-Source' }), 'status', statuses)).toBe('no-source');
    expect(queryOneOf(req({ status: 'bogus' }), 'status', statuses)).toBeNull();
    expect(queryOneOf(req({}), 'status', statuses)).toBeNull();
  });
});

describe('queryInt (Loop 108)', () => {
  it('parses positive integers and leaves garbage null', () => {
    expect(queryInt(req({ limit: '25' }), 'limit')).toBe(25);
    expect(queryInt(req({ limit: ' 40 ' }), 'limit')).toBe(40);
    expect(queryInt(req({ limit: '1' }), 'limit', { max: 500 })).toBe(1);
    expect(queryInt(req({ limit: '999' }), 'limit', { max: 500 })).toBe(500);
    expect(queryInt(req({}), 'limit')).toBeNull();
    expect(queryInt(req({ limit: '' }), 'limit')).toBeNull();
    expect(queryInt(req({ limit: '0' }), 'limit')).toBeNull();
    expect(queryInt(req({ limit: '-3' }), 'limit')).toBeNull();
    expect(queryInt(req({ limit: '1.5' }), 'limit')).toBeNull();
    expect(queryInt(req({ limit: '1e2' }), 'limit')).toBeNull();
    expect(queryInt(req({ limit: 'abc' }), 'limit')).toBeNull();
    expect(queryInt(req({ limit: ['10'] }), 'limit')).toBeNull();
  });
});

describe('queryTokens (Loop 111)', () => {
  it('splits comma lists, trims, lowercases, and ignores non-strings', () => {
    expect(queryTokens(req({ plane: 'CENTRAL, mist , ,LOCAL' }), 'plane')).toEqual([
      'central',
      'mist',
      'local',
    ]);
    expect(queryTokens(req({ plane: '  MIST  ' }), 'plane')).toEqual(['mist']);
    expect(queryTokens(req({}), 'plane')).toEqual([]);
    expect(queryTokens(req({ plane: '' }), 'plane')).toEqual([]);
    expect(queryTokens(req({ plane: ' , , ' }), 'plane')).toEqual([]);
    expect(queryTokens(req({ plane: ['a', 'b'] }), 'plane')).toEqual([]);
  });
});
