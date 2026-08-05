/**
 * server/tests/compliancePartialInventory.test.ts — a walk that stopped early
 * is not a walk that did not happen, and neither is a whole estate.
 *
 * Adapters do not empty a dataset they could not read: they omit it, and
 * planesMissingDataset finds it by that omission. A truncated walk cannot be
 * found that way, because it ships real rows and the key is present —
 * central.ts's partialDatasets says so in as many words and names the dataset
 * in PlanePull.partial instead.
 *
 * Compliance is the screen an operator screenshots for an audit, so the
 * distinction has to reach both the tones and the copy-pasteable evidence
 * text: a scorecard drawn over part of an estate is no greener for the reason
 * the rest is absent.
 */

import { describe, expect, it } from 'vitest';
import { DEVICES } from '@hpe/shared';
import { liveComplianceData } from '../src/routes/screens/complianceModel';

/**
 * A device that passes all five EVIDENCE_CHECKS: a reported model and
 * firmware, a usable reachability state, and a single claiming plane. The
 * demo estate deliberately carries evidence gaps, so a fixture slice can
 * never go green — and a control that cannot go green proves nothing about a
 * gate that is supposed to stop it.
 */
const rows = DEVICES.slice(0, 4).map((d) => ({
  ...d,
  model: 'AP-635',
  firmware: '10.4.1.0',
  state: 'up' as const,
  claimedBy: [d.plane],
}));

const stat = (data: ReturnType<typeof liveComplianceData>, label: string) =>
  data.stats.find((s) => s.label === label)!;

describe('liveComplianceData — inventories that stopped early', () => {
  it('does not let a truncated walk earn the tone of a complete run', () => {
    const whole = liveComplianceData(rows, [], undefined, []);
    const cut = liveComplianceData(rows, [], undefined, ['CENTRAL']);
    // The control: with every plane fully read, 'Sites complete' may be green.
    expect(stat(whole, 'Sites complete').tone).toBe('positive');
    // Central answered, so planesMissingDataset never saw it and every number
    // above quietly narrowed to the devices that arrived.
    expect(stat(cut, 'Sites complete').tone).not.toBe('positive');
  });

  it('suppresses the clean-result colour on the findings tile too', () => {
    const whole = liveComplianceData(rows, [], undefined, []);
    const cut = liveComplianceData(rows, [], undefined, ['CENTRAL']);
    expect(stat(whole, 'Coverage findings').tone).toBe('positive');
    expect(stat(cut, 'Coverage findings').tone).toBe('neutral');
  });

  it('puts the scope in the evidence text, which is what gets copied', () => {
    const data = liveComplianceData(rows, [], undefined, ['CENTRAL']);
    expect(data.diff).toContain('! Scope:');
    expect(data.diff).toContain('CENTRAL stopped short of a full inventory');
    // Never the unread wording — Central did contribute.
    expect(data.diff).not.toContain('contributed no inventory');
  });

  it('words a plane that answered in part differently from one that did not', () => {
    const unread = liveComplianceData(rows, ['MIST'], undefined, []);
    const cut = liveComplianceData(rows, [], undefined, ['MIST']);
    expect(unread.diff).toContain('MIST contributed no inventory');
    expect(cut.diff).not.toContain('MIST contributed no inventory');
    expect(stat(unread, 'Sites complete').delta).toContain('not in this run');
    expect(stat(cut, 'Sites complete').delta).toContain('only partly in this run');
  });

  it('reports both causes at once without conflating them', () => {
    const data = liveComplianceData(rows, ['MIST'], undefined, ['CENTRAL']);
    expect(data.diff).toContain('MIST contributed no inventory');
    expect(data.diff).toContain('CENTRAL stopped short of a full inventory');
    const scope = stat(data, 'Devices in scope').delta;
    expect(scope).toContain('1 unread inventory short of the estate');
    expect(scope).toContain('CENTRAL read stopped early');
  });

  it('says nothing when every plane handed over its whole inventory', () => {
    // A caveat that is always on is worth nothing on the day it matters, so
    // the fully-read estate must read exactly as it did before.
    const data = liveComplianceData(rows, [], undefined, []);
    expect(stat(data, 'Devices in scope').delta).toBe('from live inventory');
    expect(stat(data, 'Sites complete').delta).toBe('for available evidence fields');
    expect(data.diff).not.toContain('! Scope:');
    expect(data.diff).not.toContain('stopped short');
  });
});
