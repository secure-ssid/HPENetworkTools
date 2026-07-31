/**
 * web/src/app/nav.test.ts — the deep-link builders in web/src/app/nav.ts.
 *
 * These are the only place a screen is allowed to construct a cross-screen
 * URL, so a mistake here is a mistake on every screen that links.
 */

import { describe, expect, it } from 'vitest';
import { findingDevicesPath, namesFilterForParam, planeFilterForParam } from './nav';

describe('findingDevicesPath', () => {
  /* A Compliance finding is every device of one plane that failed one check,
     and the table renders its count as the link. It used to go to
     /devices/<first name>: a count of 12 opened one device and gave no sign
     the other eleven existed. */
  it('sends a multi-device finding to the list, carrying every name', () => {
    const path = findingDevicesPath(['ap-1', 'ap-2', 'sw-3']);
    expect(path.startsWith('/devices?names=')).toBe(true);
    const names = new URL(path, 'http://x').searchParams.get('names');
    expect(names?.split('\n')).toEqual(['ap-1', 'ap-2', 'sw-3']);
  });

  it('still opens the device itself when the finding covers exactly one', () => {
    expect(findingDevicesPath(['ap-1'])).toBe('/devices/ap-1');
  });

  /* Comma is a plausible character in a vendor-supplied device name and
     newline is not, which is the whole reason for the separator choice. */
  it('round-trips a name containing a comma, a space and a slash', () => {
    const awkward = ['rack 4, top', 'ap/roof', 'plain'];
    const names = new URL(findingDevicesPath(awkward), 'http://x').searchParams.get('names');
    expect(namesFilterForParam(names)).toEqual(awkward);
  });
});

describe('namesFilterForParam', () => {
  it('reads no param as no filter, distinct from a filter matching nothing', () => {
    expect(namesFilterForParam(null)).toBeNull();
    expect(namesFilterForParam('nothing-matches-this')).toEqual(['nothing-matches-this']);
  });

  /* An empty or blank param must read as "no filter" rather than as a filter
     of zero names — the latter would empty the inventory screen and blame the
     estate for it. */
  it('treats an empty or blank param as no filter at all', () => {
    expect(namesFilterForParam('')).toBeNull();
    expect(namesFilterForParam('   ')).toBeNull();
    expect(namesFilterForParam('\n\n')).toBeNull();
  });

  it('drops blank entries and trims the rest', () => {
    expect(namesFilterForParam('ap-1\n\n  ap-2  \n')).toEqual(['ap-1', 'ap-2']);
  });
});

describe('planeFilterForParam', () => {
  it('maps a registry id to its inventory label and passes a label through', () => {
    expect(planeFilterForParam('central')).toBe('CENTRAL');
    expect(planeFilterForParam('CENTRAL')).toBe('CENTRAL');
    expect(planeFilterForParam(null)).toBe('all');
  });
});
