/** Grouping switch ports for the port-configuration view. */

import { type PortObject } from '@hpe/shared';

export interface SwitchPortGroup {
  key: string;
  device: string;
  plane?: string;
  serial?: string;
  ports: PortObject[];
  up: number;
  down: number;
  unverified: number;
}

export function groupSwitchPorts(ports: PortObject[]): SwitchPortGroup[] {
  const groups = new Map<string, PortObject[]>();
  for (const port of ports) {
    const key = `${port.plane ?? 'unknown'}:${port.serial ?? 'no-serial'}:${port.device}`;
    groups.set(key, [...(groups.get(key) ?? []), port]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      device: rows[0]!.device,
      plane: rows[0]!.plane,
      serial: rows[0]!.serial,
      ports: [...rows].sort((a, b) => a.port.localeCompare(b.port, undefined, { numeric: true })),
      up: rows.filter((row) => /^(up|active|connected)$/i.test(row.state)).length,
      down: rows.filter((row) => /^(down|disabled|failed)$/i.test(row.state)).length,
      unverified: rows.filter((row) => row.origin === 'observed').length,
    }))
    .sort((a, b) => a.device.localeCompare(b.device));
}
