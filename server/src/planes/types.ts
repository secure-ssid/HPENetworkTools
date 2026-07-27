/**
 * server/src/planes/types.ts — plane adapter contract.
 *
 * Every control plane (Central new, Classic, Mist, GreenLake, AOS-8, AOS-10,
 * the local SSH collector, ClearPass, UXI) has one adapter. Adapters with
 * complete credentials are real (central, greenlake, clearpass, uxi, mist,
 * aos8 today); adapters with partial credentials are `StubAdapter`s (linked,
 * but pull() returns nothing — real implementations land later), adapters
 * without credentials are `UnconfiguredAdapter`s.
 *
 * PlanePull datasets use the normalized shared row types so a real adapter's
 * output can flow straight into the poller cache and the screen endpoints.
 */

import type {
  AlertRow,
  AuthEventRow,
  ClientRow,
  DeviceRow,
  SiteRow,
  SubscriptionRow,
} from '../../../shared';

export const PLANE_IDS = [
  'central',
  'classic',
  'mist',
  'greenlake',
  'aos8',
  'aos10',
  'local',
  'clearpass',
  'uxi',
] as const;

export type PlaneId = (typeof PLANE_IDS)[number];

export type PlaneHealth = 'healthy' | 'degraded' | 'warning' | 'unlinked';

export interface PlaneState {
  id: PlaneId;
  linked: boolean;
  health: PlaneHealth;
  lastSync: string | null; // ISO timestamp of the last successful pull
  deviceCount: number | null;
  callsToday: number;
  note: string | null;
}

/** Partial datasets a plane can contribute; empty for stubs. */
export interface PlanePull {
  devices?: DeviceRow[];
  sites?: SiteRow[];
  clients?: ClientRow[];
  alerts?: AlertRow[];
  authEvents?: AuthEventRow[];
  subscriptions?: SubscriptionRow[];
}

export interface PlaneAdapter {
  id: PlaneId;
  state(): PlaneState;
  pull(): Promise<PlanePull>;
}

/** One recorded outbound API call (ring buffer, last 50 per plane). */
export interface ApiCallLogEntry {
  time: string; // ISO
  path: string;
  ms: number;
  code: string;
}
