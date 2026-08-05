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
 */
export function liveTopologyNotes(reports: TopologyEdgeReportInput[]): string[] {
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

  if (sources.length === 0) {
    const none = 'No linked plane reported a neighbour fact for the current estate.';
    return asserted > 0 ? [none, assertedNote, ghostNote] : [none];
  }
  if (asserted > 0) {
    return [
      `Neighbour facts come from ${sources.join(' + ')}, and from the portal's own wiring records.`,
      assertedNote,
      ghostNote,
    ];
  }
  return [`Every edge is a reported neighbour fact from ${sources.join(' + ')}.`, ghostNote];
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
