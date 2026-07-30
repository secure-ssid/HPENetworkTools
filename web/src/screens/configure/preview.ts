/**
 * Rendered previews of a pending change.
 *
 * writeSurfaceNote and leaseNote state what a push would actually touch. They
 * are deliberately explicit: the operator is about to change a production
 * network, and 'which box does this land on' is not something to infer from a
 * form title.
 */

import { QueueEntry } from './queue';
import {
  configPreviewFor,
  ssidDependencyRequirementsFor,
  type CapabilityRow,
  type ConfigForm,
  type ConfigKind,
  type PortForm,
  type SsidForm,
  type VlanForm,
} from '@hpe/shared';

export function livePreview(kind: ConfigKind, form: ConfigForm, capabilities: CapabilityRow[]): string {
  if (kind === 'ssid') {
    const ssid = form as SsidForm;
    const lines = [
      `POST/PATCH /network-config/v1alpha1/wlan-ssids/${encodeURIComponent(ssid.name || '{ssid}')}`,
      `ssid: ${ssid.name || '(not entered)'}`,
      `essid.name: ${ssid.name || '(not entered)'}`,
      `opmode: ${
        ssid.security === 'wpa3-enterprise'
          ? 'WPA3_ENTERPRISE_CCM_128'
          : ssid.security === 'wpa2-enterprise'
            ? 'WPA2_ENTERPRISE'
            : ssid.security === 'open'
              ? 'OPEN'
              : 'WPA2_PERSONAL'
      }`,
      'forward-mode: FORWARD_MODE_BRIDGE',
      `rf-band: ${ssid.bands === '5+6' ? '5GHZ_6GHZ' : ssid.bands === '5' ? '5GHZ' : 'BAND_ALL'}`,
      `vlan-selector: VLAN_RANGES (${ssid.vlan || 'not entered'})`,
      `default-role: ${ssid.defaultRole || 'not selected'}`,
      `hide-ssid: ${ssid.broadcast ? 'false' : 'true'}`,
      `client-isolation: ${ssid.isolate ? 'true' : 'false'}`,
    ];
    if (ssid.authServerGroupId) lines.push(`auth-server-group: ${ssid.authServerGroupId}`);
    if (ssid.captivePortalProfileId) {
      lines.push(`captive-portal: ${ssid.captivePortalProfileId}`, 'captive-portal-type: EXTERNAL_CP');
    }
    if (ssidDependencyRequirementsFor(ssid.security).passphrase) {
      lines.push(`personal-security.wpa-passphrase: ${ssid.passphrase ? '[write-only value supplied]' : '[required]'}`);
    }
    lines.push(
      `POST /network-config/v1alpha1/config-assignments (${ssid.scopeIds?.length ?? 0} scope${
        (ssid.scopeIds?.length ?? 0) === 1 ? '' : 's'
      })`,
    );
    return lines.join('\n');
  }
  const rendered =
    kind === 'port'
      ? configPreviewFor('port', form as PortForm)
      : configPreviewFor('vlan', form as VlanForm);
  const body = rendered
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .map((line) => (kind === 'port' ? line.replace(/,820,816$/, '') : line))
    .join('\n')
    .trimEnd();
  const target = kind === 'port' ? (form as PortForm).device || 'device not entered' : (form as VlanForm).scope;
  // The authored preview annotates the payload per plane ('# central → PUT
  // …', '# mist → read-only'). Those lines describe the fixture estate, so
  // live mode drops them rather than restating them for planes this
  // deployment may not have linked; naming the real call per plane needs the
  // broker's own pushPathFor (server-side) — see the handoff.
  const writeTargets = capabilities.filter((c) => c.mode !== 'read only').map((c) => c.plane);
  const writeLine =
    writeTargets.length > 0
      ? `# planes that can accept it → ${writeTargets.join(', ')}`
      : '# no linked plane can accept this payload — it opens in the plane console';
  return [
    body,
    `# target → ${target}`,
    writeLine,
    '# exact endpoint and impact are resolved by the broker dry run',
  ].join('\n');
}

export function liveRadius(kind: ConfigKind, form: ConfigForm) {
  if (kind === 'ssid') {
    return [
      { what: 'Configuration assignments requested', count: `${(form as SsidForm).scopeIds?.length ?? 0}` },
      { what: 'Client sessions affected', count: 'not reported by this API' },
      { what: 'Target plane', count: (form as SsidForm).plane || 'CENTRAL' },
    ];
  }
  if (kind === 'port') {
    return [
      { what: 'Interfaces changed', count: (form as PortForm).id ? '1 requested' : 'not entered' },
      { what: 'Clients on this port right now', count: 'requires live read-back' },
      { what: 'Rollback snapshot', count: 'requested during dry run' },
    ];
  }
  return [
    { what: 'Switches in scope', count: 'requires dry run' },
    { what: 'Clients on this VLAN', count: 'not reported by config inventory' },
    { what: 'Configuration drift resolved', count: 'not available' },
  ];
}

/** "a, b and c" — a plane list read as a sentence. */
export function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The brokered-write sentence, derived from the capability matrix the API
 * sends rather than asserted. In live/blend mode that matrix is THIS
 * deployment's linked planes (screens.ts liveCapabilityMatrix), so the
 * authored "Central, the local collector and AOS-8 accept pushes…" claim
 * would name planes this install has never been given credentials for.
 */
export function writeSurfaceNote(capabilities: CapabilityRow[]): string {
  const lease = 'Every push needs a ticket reference and holds a fifteen-minute lease.';
  if (capabilities.length === 0) {
    return `${lease} No plane has reported a write capability, so nothing here can be pushed until one is linked on Connected systems.`;
  }
  const writable = capabilities.filter((c) => c.mode !== 'read only').map((c) => c.plane);
  const readOnly = capabilities.filter((c) => c.mode === 'read only').map((c) => c.plane);
  const accepts =
    writable.length > 0
      ? `${listOf(writable)} accept${writable.length === 1 ? 's' : ''} pushes from here`
      : 'No linked plane accepts a push from here';
  if (readOnly.length === 0) return `${lease} ${accepts}.`;
  return `${lease} ${accepts}; ${listOf(readOnly)} ${readOnly.length === 1 ? 'is' : 'are'} read-only, so those changes open in their own console with the payload pre-filled.`;
}

/** Remaining write lease on a queued change, or null when it carries none. */
export function leaseNote(entry: QueueEntry, now: number): string | null {
  if (!entry.expiresAt) return entry.id === null ? 'not on the broker — no lease' : null;
  const msLeft = Date.parse(entry.expiresAt) - now;
  if (!Number.isFinite(msLeft)) return null;
  if (msLeft <= 0) return 'lease expired — re-queue before pushing';
  const mins = Math.floor(msLeft / 60_000);
  return mins >= 1 ? `lease ${mins}m left` : `lease ${Math.floor(msLeft / 1000)}s left`;
}
