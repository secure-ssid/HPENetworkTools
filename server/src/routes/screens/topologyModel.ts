/**
 * server/src/routes/screens/topologyModel.ts — topology payload assembly.
 *
 * Extracted from screens.ts so the estate graph path can evolve without
 * growing the god-route further. screens.ts still owns the HTTP mount.
 */

import {
  buildDemoTopologyGraph,
  buildTopologyGraph,
  demoTopologyNotes,
  type Plane,
  type TopologyDeviceInput,
  type TopologyEdgeReportInput,
} from '@hpe/shared';
import type { ReconciledDeviceRow } from '../../services/reconcile';

export { demoTopologyNotes, buildDemoTopologyGraph };

/**
 * Captions under the live estate graph.
 *
 * `plane: null` is not a missing value. It marks wiring the portal recorded
 * itself — asserted, never claimed as a plane's observation — and the graph
 * draws those edges like any other. So the caption may neither credit them to
 * a plane nor pass over them: crediting them puts a vendor's name on the
 * portal's own say-so, and passing over them captions a graph full of links
 * with a sentence saying no link was reported. `demoTopologyNotes` has always
 * drawn this distinction ('no plane badge — asserted wiring'); the live notes
 * did not, so the same estate read honestly in demo and misleadingly live.
 *
 * Counted in reports rather than edges on purpose: several reports of one
 * physical link merge into a single edge, so a count of edges here would not
 * be a count of anything the caller could check.
 *
 * `unread` names the planes that were asked for neighbour facts and did not
 * answer. Without it every sentence here is derived purely from the reports
 * that ARRIVED, so a plane whose read failed leaves no trace: the caption
 * reads "No linked plane reported a neighbour fact" over an estate nobody
 * managed to look at. That is the same lie the paragraph above rejects, told
 * from the other end -- there the caption passed over edges that existed,
 * here it passes over the reason edges are absent.
 */
export function liveTopologyNotes(
  reports: TopologyEdgeReportInput[],
  unread: readonly Plane[] = [],
): string[] {
  const sources = [
    ...new Set(
      reports
        .map((r) => r.plane)
        .filter((p): p is Plane => p !== null && p !== undefined),
    ),
  ];
  const asserted = reports.filter((r) => r.plane === null || r.plane === undefined).length;
  const ghostNote =
    'A reported neighbour with no inventory row is a ghost, drawn as reported and never promoted to a managed device.';
  const assertedNote = `${asserted} neighbour ${asserted === 1 ? 'record carries' : 'records carry'} no plane badge: wiring the portal recorded itself, asserted rather than observed.`;
  const silent = [...new Set(unread)];
  const unreadNote =
    silent.length > 0
      ? `${silent.join(' + ')} could not be read for neighbour facts this cycle, so the graph may be missing links it would otherwise draw.`
      : null;
  const notes = (...lines: (string | null)[]): string[] => lines.filter((l): l is string => l !== null);

  if (sources.length === 0) {
    // 'No linked plane reported' is a claim about the planes, and it is only
    // the portal's to make when every plane actually answered. When one could
    // not be read, all the portal knows is that nothing reached it.
    const none =
      unreadNote === null
        ? 'No linked plane reported a neighbour fact for the current estate.'
        : 'No neighbour fact reached the portal for the current estate.';
    return asserted > 0 ? notes(none, unreadNote, assertedNote, ghostNote) : notes(none, unreadNote);
  }
  if (asserted > 0) {
    return notes(
      `Neighbour facts come from ${sources.join(' + ')}, and from the portal's own wiring records.`,
      unreadNote,
      assertedNote,
      ghostNote,
    );
  }
  // 'Every edge is a reported fact' stays true whatever went unread -- each
  // drawn edge really was reported. What it must not do alone is imply the
  // set is complete, which is the caveat's job.
  return notes(`Every edge is a reported neighbour fact from ${sources.join(' + ')}.`, unreadNote, ghostNote);
}

export function devicesForTopology(devices: ReconciledDeviceRow[]): TopologyDeviceInput[] {
  return devices.map((d) => ({
    name: d.name,
    model: d.model,
    type: d.type,
    serial: d.serial,
    mac: d.mac,
    plane: d.plane,
    claimedBy: d.claimedBy,
    siteId: d.siteId,
    siteName: d.siteName,
    state: d.state,
    tone: d.stateTone,
  }));
}

export function buildDemoTopologyPayload(): {
  graph: ReturnType<typeof buildDemoTopologyGraph>;
  notes: string[];
} {
  return { graph: buildDemoTopologyGraph(), notes: demoTopologyNotes() };
}

export function buildLiveTopologyGraph(
  devices: ReconciledDeviceRow[],
  reports: TopologyEdgeReportInput[],
  sites: Parameters<typeof buildTopologyGraph>[2],
): ReturnType<typeof buildTopologyGraph> {
  return buildTopologyGraph(devicesForTopology(devices), reports, sites);
}
