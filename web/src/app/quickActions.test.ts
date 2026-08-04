import { describe, expect, it } from 'vitest';
import { isQuickAction, matchQuickActions } from './quickActions';

describe('matchQuickActions', () => {
  it('returns nothing for short or empty queries', () => {
    expect(matchQuickActions('')).toEqual([]);
    expect(matchQuickActions('a')).toEqual([]);
    expect(matchQuickActions('go t')).toEqual([]);
  });

  it('matches raise-ticket phrases and deep-links the queue action', () => {
    const hit = matchQuickActions('raise ticket')[0];
    expect(hit?.kind).toBe('action');
    expect(hit?.path).toBe('/alerts?tab=queue&action=ticket');
    expect(hit?.label.toLowerCase()).toContain('ticket');

    expect(matchQuickActions('new ticket')[0]?.path).toContain('action=ticket');
    expect(matchQuickActions('go ticket')[0]?.path).toContain('/alerts');
  });

  it('matches silence / hush and lands on the silences workflow', () => {
    const hit = matchQuickActions('silence')[0];
    expect(hit?.path).toBe('/alerts?tab=silences&action=silence');
    expect(matchQuickActions('hush')[0]?.path).toContain('action=silence');
    expect(matchQuickActions('mute alert')[0]?.kind).toBe('action');
  });

  it('matches diagnostic / traceroute and opens Devices with action', () => {
    const hit = matchQuickActions('run diagnostic')[0];
    expect(hit?.path).toBe('/devices?action=diagnostics');
    expect(matchQuickActions('traceroute')[0]?.path).toContain('action=diagnostics');
  });

  it('strips go/open prefixes via shared normalizer', () => {
    expect(matchQuickActions('open silence')[0]?.path).toContain('action=silence');
  });
});

describe('isQuickAction', () => {
  it('detects action kind only', () => {
    expect(isQuickAction('action')).toBe(true);
    expect(isQuickAction('ACTION')).toBe(true);
    expect(isQuickAction('screen')).toBe(false);
    expect(isQuickAction(null)).toBe(false);
  });
});
