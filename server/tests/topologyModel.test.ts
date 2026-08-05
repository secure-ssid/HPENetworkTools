/**
 * liveTopologyNotes — the captions under the live estate graph.
 *
 * The rule under test: a report with `plane: null` is wiring the portal
 * recorded itself. Those edges are drawn, so the caption may neither credit
 * them to a plane nor pass over them in silence.
 */
import { describe, expect, it } from 'vitest';
import type { TopologyEdgeReportInput } from '@hpe/shared';
import { liveTopologyNotes } from '../src/routes/screens/topologyModel';

type Plane = TopologyEdgeReportInput['plane'];

/** One neighbour report; `plane: null` is the portal's own wiring record. */
function report(plane: Plane, from = 'sw-a', to = 'sw-b'): TopologyEdgeReportInput {
  return {
    plane,
    protocol: plane === null ? 'recorded uplink' : 'LLDP',
    from: { name: from },
    to: { name: to },
  };
}

describe('liveTopologyNotes', () => {
  it('names the reporting planes when every fact came from one', () => {
    const notes = liveTopologyNotes([report('CENTRAL'), report('MIST')]);
    expect(notes[0]).toBe('Every edge is a reported neighbour fact from CENTRAL + MIST.');
    expect(notes.join(' ')).not.toContain('no plane badge');
  });

  it('does not credit the portal\u2019s own wiring to a plane', () => {
    const notes = liveTopologyNotes([report('CENTRAL'), report(null)]);
    // The old caption said "Every edge is a reported neighbour fact from
    // central." — putting Central's name on a link Central never observed.
    expect(notes[0]).not.toBe('Every edge is a reported neighbour fact from CENTRAL.');
    expect(notes[0]).toContain('CENTRAL');
    expect(notes[0]).toContain("portal's own wiring records");
  });

  it('counts the unbadged records so the graph and the caption agree', () => {
    const notes = liveTopologyNotes([report('CENTRAL'), report(null), report(null)]);
    expect(notes.join(' ')).toContain('2 neighbour records carry no plane badge');
  });

  it('does not caption a graph full of portal wiring as nothing reported', () => {
    const notes = liveTopologyNotes([report(null), report(null)]);
    // The bare sentence is still true — no *plane* reported anything — but on
    // its own it reads as an empty graph, and the graph is not empty.
    expect(notes[0]).toBe('No linked plane reported a neighbour fact for the current estate.');
    expect(notes).toHaveLength(3);
    expect(notes.join(' ')).toContain('2 neighbour records carry no plane badge');
  });

  it('says nothing about unbadged records when there are none', () => {
    const empty = liveTopologyNotes([]);
    expect(empty).toEqual(['No linked plane reported a neighbour fact for the current estate.']);
    const planed = liveTopologyNotes([report('MIST')]);
    expect(planed.join(' ')).not.toContain('no plane badge');
  });

  it('agrees with itself in the singular', () => {
    const notes = liveTopologyNotes([report(null)]);
    expect(notes.join(' ')).toContain('1 neighbour record carries no plane badge');
  });

  it('names each reporting plane once however many facts it sent', () => {
    const notes = liveTopologyNotes([report('CENTRAL'), report('CENTRAL'), report('CENTRAL')]);
    expect(notes[0]).toBe('Every edge is a reported neighbour fact from CENTRAL.');
  });

  it('keeps the ghost note wherever an edge can be drawn', () => {
    for (const reports of [[report('CENTRAL')], [report(null)], [report('CENTRAL'), report(null)]]) {
      expect(liveTopologyNotes(reports).at(-1)).toContain('ghost');
    }
  });
});
