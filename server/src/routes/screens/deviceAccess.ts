/**
 * Whether a device can be opened, and what a shell would connect to.
 *
 * Kept apart from the device view-model because this is an access decision,
 * not a display one: canOpenShell() is consulted before a terminal is offered,
 * and a plane that does not support shell access must say so rather than
 * present a button that fails on click.
 */

import { registry } from '../../planes/registry';
import { type PlaneId } from '../../planes/types';
import {
  planeIdForLabel,
  type ReconciledDeviceRow,
} from '../../services/reconcile';
import { terminalManager } from '../../services/terminal';
import { evidenceChecksFor } from './complianceModel';
import {
  datasetReported,
  displayParts,
  reportedValue,
} from './context';
import { liveClients } from './liveCore';
import {
  deviceTerminalKind,
  terminalBanner,
  terminalQuickCommands,
  type DeviceClientSet,
  type DeviceEvidence,
  type TerminalLine,
  countOf,
} from '@hpe/shared';

export function liveDeviceClients(deviceName: string): DeviceClientSet | null {
  if (!datasetReported('clients')) return null;
  const key = deviceName.trim().toLowerCase();
  const clients = liveClients()
    .filter((client) => client.attach.trim().toLowerCase() === key)
    .map((client) => ({
      name: client.name,
      detail: displayParts([client.model, client.mac, String(client.ip), client.where]),
      // Also sent apart, so the screen can lay them out in columns rather than
      // splitting the sentence above back into the fields it was built from.
      model: reportedValue(client.model) ? client.model : null,
      mac: reportedValue(client.mac) ? client.mac : null,
      ip: reportedValue(String(client.ip)) ? String(client.ip) : null,
      where: reportedValue(client.where) ? client.where : null,
      state: client.health,
      tone: client.healthTone,
    }));
  return {
    meta: clients.length === 0 ? 'No active sessions reported' : countOf(clients.length, 'active session'),
    rows: clients,
  };
}

/**
 * Do the planes claiming this device allow a shell to it?
 *
 * A vote among the claimants, and it is three-valued, because a plane can
 * publish PlaneCapabilities.localShell true, publish it false, or publish
 * nothing. Silence is the common case: a plane with no adapter — 'local'
 * included, which is the plane the collector shell actually runs through —
 * publishes no capabilities at all.
 *
 *   any claimant says true   → allowed. A cloud plane is right that IT cannot
 *                              open a shell and wrong as a verdict on the
 *                              device; one plane that can is enough.
 *   every claimant says false → refused. Nobody has a path to it.
 *   anything else            → allowed. Silence is not a refusal, and it does
 *                              not become one by standing next to one.
 *
 * That last line is the case to be deliberate about, because it is the one a
 * stricter reading would get wrong. A device claimed by CENTRAL (false) and
 * LOCAL (silent) is allowed here. Counting LOCAL's silence as agreement with
 * CENTRAL would refuse exactly the dual-claimed devices the collector exists
 * to reach — it has no adapter to speak with.
 *
 * Note the two unknowns are not the same and do not behave the same. A label
 * naming no registry plane ('THIRD-PARTY') is dropped from the vote entirely,
 * so it cannot cancel a plane that genuinely said no; a plane that is present
 * but silent is a voter, and it allows.
 *
 * This is not the last gate, which is why it can afford to be permissive:
 * canOpenShell() below also requires the row's own `localShell` and
 * terminalManager.canShell(), and the README honesty rule that the shell block
 * must never advertise a session the bridge cannot open is enforced by all
 * three together, weakest wins.
 */
export function planeAllowsShell(device: ReconciledDeviceRow): boolean {
  const labels = device.claimedBy && device.claimedBy.length > 0 ? device.claimedBy : [device.plane];
  const claims = labels
    .map((label) => planeIdForLabel(label))
    .filter((id): id is PlaneId => id !== undefined)
    .map((id) => registry.state(id).capabilities?.localShell);
  if (claims.length === 0) return true; // no registry plane behind the label — the row decides
  if (claims.some((claim) => claim === true)) return true;
  return !claims.every((claim) => claim === false);
}

/**
 * Can the portal open a recorded shell to this row RIGHT NOW? Three facts,
 * weakest wins:
 *   - the plane's own row claim (`localShell`, a union across claimants),
 *   - no claiming plane's adapter vetoing it (planeAllowsShell), and
 *   - terminalManager.canShell(): the device class has a CLI, the inventory
 *     names a dialable management IP, and local-plane credentials — the shell
 *     path itself — are stored.
 *
 * This is THE shell gate for live rows. liveDeviceData() applies it to every
 * row as it leaves the merge, so `device.localShell` on anything this router
 * serves already means "the portal can open a session", and calling the gate
 * again later (the terminal block, the site core pick, the Launchpad SSH row)
 * is idempotent — it re-states the rule at the point a control is offered
 * rather than trusting a field that arrived from somewhere else.
 *
 * DeviceDetail drives its WS attempt and all three honest shell notes off that
 * one field, so a row that says `true` while the bridge would refuse renders a
 * terminal that can never open (finding
 * devicedetail-live-terminal-gate-can-never-open).
 */
export function canOpenShell(device: ReconciledDeviceRow): boolean {
  return (
    device.localShell &&
    planeAllowsShell(device) &&
    terminalManager.canShell({ name: device.name, ip: device.ip, type: device.type, plane: device.plane })
  );
}

/** One reconciled row with `localShell` replaced by the live gate. Same object
 *  back when the merge already agreed, so the common case allocates nothing. */
export function withLiveShellGate(device: ReconciledDeviceRow): ReconciledDeviceRow {
  const localShell = canOpenShell(device);
  return localShell === device.localShell ? device : { ...device, localShell };
}

/**
 * The shell block /api/devices/:name serves next to a live device — the same
 * `{banner, quickCommands}` pair the demo branch has always sent, so the two
 * branches and the screen name ONE source (contract drift closed). The kind
 * comes from the inventory row's device type via the shared helper the client
 * also uses, so the two sides cannot disagree; a device with no shell gets no
 * block at all rather than a banner promising a session.
 */
export function liveTerminalPayload(
  device: ReconciledDeviceRow,
): { terminal: { banner: TerminalLine[]; quickCommands: string[] } } | Record<string, never> {
  const kind = deviceTerminalKind(device, device.name);
  if (kind === 'none' || !canOpenShell(device)) return {};
  return { terminal: { banner: terminalBanner(kind), quickCommands: terminalQuickCommands(kind) } };
}

/**
 * The device-detail Compliance panel's evidence block. `mode` is what stops an
 * empty list reading as a clean scorecard: a live row always yields five
 * verdicts, so 'live' is honest here, while a name the merge does not hold
 * never reaches this function at all.
 */
export function liveDeviceEvidence(device: ReconciledDeviceRow): DeviceEvidence {
  return { checks: evidenceChecksFor(device), mode: 'live' };
}
