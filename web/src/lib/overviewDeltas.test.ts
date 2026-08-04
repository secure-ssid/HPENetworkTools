import { describe, expect, it } from 'vitest';
import type { MetricsHistoryEnvelope } from '@hpe/shared';
import {
  latestSampleMs,
  overviewActionChips,
  overviewHourDeltas,
  overviewLicenceChip,
  pointNear,
} from './overviewDeltas';

const T0 = '2026-08-04T10:00:00.000Z';
const T30 = '2026-08-04T10:30:00.000Z';
const T60 = '2026-08-04T11:00:00.000Z';
const END = Date.parse(T60);

function envelope(partial: Partial<MetricsHistoryEnvelope['planes']>): MetricsHistoryEnvelope {
  return {
    dataSource: 'live',
    since: T0,
    sampleMs: 300_000,
    retentionMs: 86_400_000,
    planes: partial as MetricsHistoryEnvelope['planes'],
    deviceClients: {},
  };
}

describe('pointNear / latestSampleMs', () => {
  it('picks the closest sample and the newest timestamp', () => {
    const pts = [
      { t: T0, v: 1 },
      { t: T30, v: 2 },
      { t: T60, v: 3 },
    ];
    expect(pointNear(pts, Date.parse(T30))?.v).toBe(2);
    expect(pointNear([], Date.now())).toBeNull();
    expect(
      latestSampleMs({
        CENTRAL: { devices: pts, devicesDown: [], clients: [], alerts: [] },
      }),
    ).toBe(END);
  });
});

describe('overviewHourDeltas', () => {
  it('returns empty without metrics or without a time span', () => {
    expect(overviewHourDeltas(null)).toEqual([]);
    expect(
      overviewHourDeltas(
        envelope({
          CENTRAL: {
            devices: [{ t: T60, v: 10 }],
            devicesDown: [],
            clients: [],
            alerts: [],
          },
        }),
        END,
      ),
    ).toEqual([]);
  });

  it('emits actionable chips for downs, alerts, devices, and clients', () => {
    const chips = overviewHourDeltas(
      envelope({
        CENTRAL: {
          devices: [
            { t: T0, v: 100 },
            { t: T60, v: 105 },
          ],
          devicesDown: [
            { t: T0, v: 2 },
            { t: T60, v: 5 },
          ],
          clients: [
            { t: T0, v: 200 },
            { t: T60, v: 180 },
          ],
          alerts: [
            { t: T0, v: 3 },
            { t: T60, v: 7 },
          ],
        },
        MIST: {
          devices: [
            { t: T0, v: 50 },
            { t: T60, v: 50 },
          ],
          devicesDown: [
            { t: T0, v: 1 },
            { t: T60, v: 0 },
          ],
          clients: [],
          alerts: [
            { t: T0, v: 1 },
            { t: T60, v: 0 },
          ],
        },
      }),
      END,
    );

    expect(chips).toEqual([
      { id: 'devices-down', label: '+2 down', href: '/devices', tone: 'negative' },
      { id: 'alerts', label: '+3 alerts', href: '/alerts', tone: 'negative' },
      { id: 'devices', label: '+5 devices', href: '/devices', tone: 'neutral' },
      { id: 'clients', label: '-20 clients', href: '/clients', tone: 'neutral' },
    ]);
  });

  it('wording recovers downs and fewer alerts as positive', () => {
    const chips = overviewHourDeltas(
      envelope({
        CENTRAL: {
          devices: [
            { t: T0, v: 10 },
            { t: T60, v: 10 },
          ],
          devicesDown: [
            { t: T0, v: 4 },
            { t: T60, v: 1 },
          ],
          clients: [],
          alerts: [
            { t: T0, v: 6 },
            { t: T60, v: 2 },
          ],
        },
      }),
      END,
    );
    expect(chips).toContainEqual({
      id: 'devices-down',
      label: '3 recovered',
      href: '/devices',
      tone: 'positive',
    });
    expect(chips).toContainEqual({
      id: 'alerts',
      label: '4 fewer alerts',
      href: '/alerts',
      tone: 'positive',
    });
  });
});

describe('overviewLicenceChip / overviewActionChips', () => {
  it('parses Licences ≤60d counts and skips zero/missing', () => {
    expect(
      overviewLicenceChip([{ label: 'Licences ≤60d', value: '34', delta: '', tone: 'neutral' }]),
    ).toEqual({
      id: 'licences',
      label: '34 licences ≤60d',
      href: '/licenses',
      tone: 'negative',
    });
    expect(
      overviewLicenceChip([{ label: 'Licenses due', value: '1', delta: '', tone: 'neutral' }]),
    ).toEqual({
      id: 'licences',
      label: '1 licence ≤60d',
      href: '/licenses',
      tone: 'negative',
    });
    expect(
      overviewLicenceChip([{ label: 'Licences ≤60d', value: '0', delta: '', tone: 'neutral' }]),
    ).toBeNull();
    expect(overviewLicenceChip([{ label: 'Devices reachable', value: '10', delta: '', tone: 'positive' }])).toBeNull();
  });

  it('appends the licence chip after hour deltas', () => {
    const chips = overviewActionChips(
      envelope({
        CENTRAL: {
          devices: [
            { t: T0, v: 10 },
            { t: T60, v: 12 },
          ],
          devicesDown: [],
          clients: [],
          alerts: [],
        },
      }),
      [{ label: 'Licences ≤60d', value: '5', delta: '', tone: 'neutral' }],
      END,
    );
    expect(chips.some((c) => c.id === 'devices')).toBe(true);
    expect(chips[chips.length - 1]).toEqual({
      id: 'licences',
      label: '5 licences ≤60d',
      href: '/licenses',
      tone: 'negative',
    });
  });
});
