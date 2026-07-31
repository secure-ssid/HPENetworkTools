/**
 * server/tests/deviceAccess.test.ts — the shell gate.
 *
 * `planeAllowsShell` is an access decision, not a display one: it is consulted
 * before the portal offers a recorded SSH session, and the rule it applies is
 * three-valued. A plane can say it CAN give a shell to hardware it claims, say
 * it CANNOT, or say nothing at all — and 'nothing at all' is the common case,
 * because a plane with no adapter publishes no capabilities.
 *
 * Three-valued logic mixed with a double-claim is exactly the shape of rule
 * that drifts under maintenance, and the module had no tests. These pin the
 * behaviour at every combination that can actually reach it, including the one
 * the docstring and the implementation used to describe differently.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Plane } from '@hpe/shared';
import type { ReconciledDeviceRow } from '../src/services/reconcile';
import type { PlaneId } from '../src/planes/types';

let planeAllowsShell: (device: ReconciledDeviceRow) => boolean;
let registry: (typeof import('../src/planes/registry'))['registry'];

beforeAll(async () => {
  process.env.HPE_SETTINGS_PATH = join(mkdtempSync(join(tmpdir(), 'hpe-access-')), 'settings.json');
  ({ planeAllowsShell } = await import('../src/routes/screens/deviceAccess'));
  ({ registry } = await import('../src/planes/registry'));
});

/** Publish (or withdraw) one plane's localShell capability claim. */
function claim(id: PlaneId, localShell: boolean | undefined): void {
  const state = registry.get(id).state();
  state.capabilities = localShell === undefined ? undefined : { localShell };
}

function device(plane: Plane, claimedBy?: Plane[]): ReconciledDeviceRow {
  return { name: 'sw-1', plane, claimedBy } as unknown as ReconciledDeviceRow;
}

beforeEach(() => {
  // Every plane silent, so each test states only the claims it is about.
  for (const id of ['central', 'mist', 'aos8', 'local', 'clearpass'] as PlaneId[]) {
    claim(id, undefined);
  }
});

describe('planeAllowsShell', () => {
  it('lets a plane that claims it can give a shell give one', () => {
    claim('aos8', true);
    expect(planeAllowsShell(device('AOS-8'))).toBe(true);
  });

  it('refuses when the only claiming plane says it cannot', () => {
    // A cloud plane describing hardware it has no path to. Offering a button
    // here is the failure the gate exists to prevent: it can only ever fail on
    // click, and it fails after the operator has committed to the attempt.
    claim('central', false);
    expect(planeAllowsShell(device('CENTRAL'))).toBe(false);
  });

  it('does not read silence as a refusal', () => {
    // Most planes publish nothing. Treating that as 'no' would switch the
    // shell off across the estate on the strength of data nobody sent.
    expect(planeAllowsShell(device('LOCAL'))).toBe(true);
  });

  it('lets one plane that can override one that cannot', () => {
    // The double-claim this is really for: a device inventoried by a cloud
    // plane AND reachable through the local collector. CENTRAL is right that
    // IT cannot open a shell, and wrong as a verdict on the device.
    claim('central', false);
    claim('aos8', true);
    expect(planeAllowsShell(device('CENTRAL', ['CENTRAL', 'AOS-8']))).toBe(true);
    // Order must not decide it.
    expect(planeAllowsShell(device('AOS-8', ['AOS-8', 'CENTRAL']))).toBe(true);
  });

  it('refuses only when every claiming plane says it cannot', () => {
    claim('central', false);
    claim('mist', false);
    expect(planeAllowsShell(device('CENTRAL', ['CENTRAL', 'MIST']))).toBe(false);
  });

  /* The case worth being explicit about: a stated refusal beside a silence.
     It resolves to ALLOW, and that is deliberate rather than incidental.
     'local' is the plane the collector shell actually runs through and it has
     no adapter, so it publishes nothing; reading its silence as agreement with
     CENTRAL's 'no' would refuse precisely the dual-claimed devices the
     collector exists to reach. The claim is not the last gate — canOpenShell
     still requires the row's own localShell flag and terminalManager.canShell,
     which wants a dialable IP and stored local-plane credentials. */
  it('lets a silent plane stand beside a refusing one without refusing', () => {
    claim('central', false);
    claim('local', undefined);
    expect(planeAllowsShell(device('CENTRAL', ['CENTRAL', 'LOCAL']))).toBe(true);
  });

  it('lets the row decide when no label names a registry plane', () => {
    // 'THIRD-PARTY' is a real label in this inventory and no plane behind it.
    // With nothing to consult, the capability gate abstains rather than
    // inventing a verdict — the row's own localShell still has to be true.
    expect(planeAllowsShell(device('THIRD-PARTY' as Plane))).toBe(true);
  });

  it('ignores unrecognised labels beside a real refusal', () => {
    // Over-application guard: an unmappable label must not turn into a
    // permissive vote that cancels a plane which genuinely said no.
    claim('central', false);
    expect(planeAllowsShell(device('CENTRAL', ['CENTRAL', 'THIRD-PARTY' as Plane]))).toBe(false);
  });

  it('falls back to the row plane when claimedBy is absent or empty', () => {
    claim('central', false);
    expect(planeAllowsShell(device('CENTRAL'))).toBe(false);
    expect(planeAllowsShell(device('CENTRAL', []))).toBe(false);
  });
});
