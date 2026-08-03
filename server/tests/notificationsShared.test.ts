/**
 * server/tests/notificationsShared.test.ts — the shared notification contracts.
 *
 * Covers shared/notifications.ts (via the @hpe/shared barrel, the way the
 * server notifier and the browser screen both import it):
 *   - transition detection: fired / resolved / escalated, and the three
 *     things that must NOT produce an event (a group moving to the silenced
 *     bench, a silenced group clearing, a group arriving already silenced);
 *   - template rendering: generic carries the verbatim event, slack/teams/
 *     ntfy carry the one-line summary in each receiver's own shape;
 *   - endpoint validation: the SSRF rule is the webhook rule (HTTPS, no
 *     private or loopback targets), names and secrets bounded, templates
 *     enumerated.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_NOTIFICATION_NAME_CHARS,
  MAX_NOTIFICATION_SECRET_CHARS,
  diffAlertGroups,
  isNotificationTemplateKind,
  notificationSummaryLine,
  renderNotification,
  validateNotificationEndpoint,
  type AlertGroup,
  type AlertRow,
  type NotificationEndpointForm,
  type NotificationEvent,
  type NotificationSampleState,
} from '@hpe/shared';

function row(over: Partial<AlertRow> = {}): AlertRow {
  return {
    sev: 'P1',
    tone: 'danger',
    title: 'Gateway down',
    detail: 'no keepalives for 5m',
    siteId: 'campus-01',
    siteName: 'Campus-01 HQ',
    plane: 'CENTRAL',
    state: 'open',
    age: '4m',
    device: 'gw-edge-1',
    ...over,
  };
}

function group(over: Partial<AlertGroup> = {}): AlertGroup {
  const latest = over.latest ?? row();
  return {
    fingerprint: over.fingerprint ?? 'central|gw-edge-1|gateway down',
    latest,
    count: 1,
    firstSeen: '9m',
    lastSeen: '4m',
    ...over,
  };
}

function state(groups: AlertGroup[], silenced: string[] = []): NotificationSampleState {
  return {
    groups: new Map(groups.map((g) => [g.fingerprint, g])),
    silenced: new Set(silenced),
  };
}

function event(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: 'evt-test',
    kind: 'fired',
    at: '2026-08-01T12:00:00.000Z',
    fingerprint: 'central|gw-edge-1|gateway down',
    plane: 'CENTRAL',
    device: 'gw-edge-1',
    title: 'Gateway down',
    sev: 'P1',
    state: 'open',
    siteName: 'Campus-01 HQ',
    age: '4m',
    count: 1,
    ...over,
  };
}

function form(over: Partial<NotificationEndpointForm> = {}): NotificationEndpointForm {
  return {
    name: 'noc-slack',
    url: 'https://hooks.slack.com/services/T00/B00/xxx',
    template: 'slack',
    enabled: true,
    ...over,
  };
}

describe('diffAlertGroups', () => {
  it('reports fired for a group that was not in the previous sample', () => {
    const g = group();
    const out = diffAlertGroups(state([]), { active: [g], silenced: [] });
    expect(out).toEqual([{ kind: 'fired', fingerprint: g.fingerprint, group: g }]);
  });

  it('reports nothing for a group that persists unchanged', () => {
    const g = group();
    expect(diffAlertGroups(state([g]), { active: [g], silenced: [] })).toEqual([]);
  });

  it('reports escalated with the previous count when the storm grows', () => {
    const before = group({ count: 2 });
    const after = group({ count: 5 });
    const out = diffAlertGroups(state([before]), { active: [after], silenced: [] });
    expect(out).toEqual([{ kind: 'escalated', fingerprint: after.fingerprint, group: after, previousCount: 2 }]);
  });

  it('does not report escalated when the count holds or shrinks', () => {
    const before = group({ count: 5 });
    for (const count of [5, 3]) {
      expect(diffAlertGroups(state([before]), { active: [group({ count })], silenced: [] })).toEqual([]);
    }
  });

  it('reports resolved only when a fingerprint leaves the queue entirely', () => {
    const g = group();
    const out = diffAlertGroups(state([g]), { active: [], silenced: [] });
    expect(out).toEqual([{ kind: 'resolved', fingerprint: g.fingerprint, group: g }]);
  });

  it('does NOT report resolved for a group that moved to the silenced bench — it is hushed, not resolved', () => {
    const g = group();
    expect(diffAlertGroups(state([g]), { active: [], silenced: [g] })).toEqual([]);
  });

  it('does NOT report resolved for a silenced group that cleared — it never paged anyone', () => {
    const g = group();
    expect(diffAlertGroups(state([g], [g.fingerprint]), { active: [], silenced: [] })).toEqual([]);
  });

  it('does NOT report fired for a group that arrives already silenced', () => {
    const g = group();
    expect(diffAlertGroups(state([]), { active: [], silenced: [g] })).toEqual([]);
  });
});

describe('notificationSummaryLine', () => {
  it('carries sev, kind, title, device, plane and site on one line', () => {
    expect(notificationSummaryLine(event())).toBe('[P1] FIRED: Gateway down — gw-edge-1 (CENTRAL · Campus-01 HQ)');
  });

  it('shows the escalation growth as ×count (was previous)', () => {
    expect(notificationSummaryLine(event({ kind: 'escalated', count: 5, previousCount: 2 }))).toBe(
      '[P1] ESCALATED: Gateway down — gw-edge-1 (CENTRAL · Campus-01 HQ) ×5 (was 2)',
    );
  });
});

describe('renderNotification', () => {
  it('generic carries the verbatim event as JSON', () => {
    const rendered = renderNotification('generic', event());
    expect(rendered.contentType).toBe('application/json');
    expect(JSON.parse(rendered.body)).toEqual(event());
  });

  it('slack renders the incoming-webhook { text } shape', () => {
    const rendered = renderNotification('slack', event());
    expect(JSON.parse(rendered.body)).toEqual({ text: notificationSummaryLine(event()) });
  });

  it('teams renders a MessageCard whose theme color follows the kind', () => {
    const fired = JSON.parse(renderNotification('teams', event()).body);
    expect(fired['@type']).toBe('MessageCard');
    expect(fired.themeColor).toBe('D22630');
    expect(fired.text).toContain('FIRED');
    const resolved = JSON.parse(renderNotification('teams', event({ kind: 'resolved' })).body);
    expect(resolved.themeColor).toBe('01A783');
  });

  it('ntfy renders a plain-text body (what curl -d sends)', () => {
    const rendered = renderNotification('ntfy', event({ detail: 'no keepalives for 5m' }));
    expect(rendered.contentType).toBe('text/plain; charset=utf-8');
    expect(rendered.body).toBe(`${notificationSummaryLine(event({ detail: 'no keepalives for 5m' }))}\n\nno keepalives for 5m`);
  });
});

describe('validateNotificationEndpoint', () => {
  it('accepts a well-formed endpoint', () => {
    expect(validateNotificationEndpoint(form())).toEqual([]);
    expect(validateNotificationEndpoint(form({ hmacSecret: 's3cret' }))).toEqual([]);
  });

  it('requires a name and caps it', () => {
    expect(validateNotificationEndpoint(form({ name: '' }))).toContain('name is required');
    expect(validateNotificationEndpoint(form({ name: 'x'.repeat(MAX_NOTIFICATION_NAME_CHARS + 1) }))).toEqual([
      `name must be ${MAX_NOTIFICATION_NAME_CHARS} characters or fewer`,
    ]);
  });

  it('refuses non-HTTPS, loopback and private targets — the webhook SSRF rule', () => {
    expect(validateNotificationEndpoint(form({ url: 'http://hooks.example.com/x' })).join()).toContain('HTTPS');
    expect(validateNotificationEndpoint(form({ url: 'https://127.0.0.1/hook' })).join()).toContain('private');
    expect(validateNotificationEndpoint(form({ url: 'https://192.168.1.10/hook' })).join()).toContain('private');
    expect(validateNotificationEndpoint(form({ url: 'https://169.254.169.254/latest' })).join()).toContain('private');
    expect(validateNotificationEndpoint(form({ url: 'not-a-url' })).join()).toContain('valid absolute URL');
    expect(validateNotificationEndpoint(form({ url: '' })).join()).toContain('required');
  });

  it('refuses an unknown template and an over-length secret', () => {
    expect(validateNotificationEndpoint(form({ template: 'pagerduty' as never })).join()).toContain('template must be one of');
    expect(
      validateNotificationEndpoint(form({ hmacSecret: 'x'.repeat(MAX_NOTIFICATION_SECRET_CHARS + 1) })).join(),
    ).toContain(`${MAX_NOTIFICATION_SECRET_CHARS} characters or fewer`);
  });
});

describe('isNotificationTemplateKind', () => {
  it('accepts exactly the four known kinds', () => {
    for (const k of ['generic', 'slack', 'teams', 'ntfy']) expect(isNotificationTemplateKind(k)).toBe(true);
    expect(isNotificationTemplateKind('webhook')).toBe(false);
    expect(isNotificationTemplateKind(42)).toBe(false);
  });
});
