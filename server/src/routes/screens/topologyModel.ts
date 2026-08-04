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

export function liveTopologyNotes(reports: TopologyEdgeReportInput[]): string[] {
  const sources = [
    ...new Set(
      reports
        .map((r) => r.plane)
        .filter((p): p is Plane => p !== null && p !== undefined),
    ),
  ];
  if (sources.length > 0) {
    return [
      `Every edge is a reported neighbour fact from ${sources.join(' + ')}.`,
      'A reported neighbour with no inventory row is a ghost, drawn as reported and never promoted to a managed device.',
    ];
  }
  return ['No linked plane reported a neighbour fact for the current estate.'];
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
