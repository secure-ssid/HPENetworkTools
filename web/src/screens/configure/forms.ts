/**
 * Configure screen: the shapes an operator fills in, and their vocabulary.
 *
 * The scope labels and catalog-section names are here rather than inline
 * because a section the plane did not publish must be described as
 * unavailable, not omitted — ssidSectionUnavailableNote is the sentence that
 * says so, and it has to read the same wherever a section is missing.
 */

import {
  VLAN_SCOPE_OPTIONS,
  planeKeyOf,
  ssidDependencyRequirementsFor,
  type ConfigForm,
  type ConfigKind,
  type PortForm,
  type SsidForm,
  type SsidScopeCategory,
  type SsidScopeOption,
  type SsidSecurity,
  type VlanForm,
} from '@hpe/shared';

/** The direct-write target plane for an SSID form — the drawer's Mist
 *  switches, catalog query and refusal notes all read this one derivation so
 *  they can never disagree. A label planeKeyOf cannot place ('CENTRAL +
 *  MIST', an AOS-8 row) rides the Central flow, exactly as the server treats
 *  it (ssidDirectWrite.ts refuses anything that is not central or mist). */
export function ssidPlaneOf(form: SsidForm): 'mist' | 'central' {
  return planeKeyOf(form.plane as Parameters<typeof planeKeyOf>[0]) === 'mist' ? 'mist' : 'central';
}

export const LIVE_SSID_FORM: SsidForm = {
  name: '',
  vlan: '',
  security: 'wpa2-psk',
  group: '',
  bands: 'all',
  broadcast: true,
  isolate: false,
  noDfs: false,
  plane: 'CENTRAL',
};

export const LIVE_PORT_FORM: PortForm = {
  device: '',
  id: '',
  desc: '',
  mode: 'access',
  vlan: '',
  poe: false,
  dot1x: false,
  mab: false,
  up: true,
};

export const LIVE_VLAN_FORM: VlanForm = {
  id: '',
  name: '',
  helpers: '',
  scope: 'core-only',
};

export const LIVE_VLAN_SCOPE_OPTIONS = VLAN_SCOPE_OPTIONS.map((option) => ({
  ...option,
  label:
    option.value === 'cx-campus-01'
      ? 'Campus-01 CX switches'
      : option.value === 'cx-all'
        ? 'Every CX switch'
        : 'Core switches only',
}));

/** Scope-map category → the multi-select group heading (SsidCatalog.scopes). */
export const SSID_SCOPE_CATEGORY_LABEL: Record<SsidScopeCategory, string> = {
  site: 'Sites',
  'site-collection': 'Site collections',
  'ap-group': 'AP device groups',
  ap: 'Individual APs',
};

export const SSID_SCOPE_CATEGORY_ORDER: SsidScopeCategory[] = ['site', 'site-collection', 'ap-group', 'ap'];

/** SsidCatalogSection → the plain-English name used in "not reported" notes. */
export const SSID_CATALOG_SECTION_LABEL: Record<string, string> = {
  sites: 'sites',
  'site-collections': 'site collections',
  'ap-groups': 'AP device groups',
  aps: 'individual APs',
  roles: 'roles',
  authServerGroups: 'authentication server groups',
  captivePortalProfiles: 'captive-portal profiles',
};

/** Group a flat scope list by category, in a fixed display order, dropping
 *  categories with nothing to offer rather than heading an empty list. */
export function groupScopesByCategory(scopes: SsidScopeOption[]): { category: SsidScopeCategory; options: SsidScopeOption[] }[] {
  return SSID_SCOPE_CATEGORY_ORDER.map((category) => ({
    category,
    options: scopes.filter((s) => s.category === category),
  })).filter((group) => group.options.length > 0);
}

/** "Central did not report any <section> — Apply is disabled until this is
 *  available." — the honest note under a dependency select the catalog could
 *  not answer. */
export function ssidSectionUnavailableNote(section: string): string {
  return `Central did not report any ${SSID_CATALOG_SECTION_LABEL[section] ?? section} — Apply is disabled until this is available.`;
}

/** Prepend a non-selectable placeholder so an unset dependency never LOOKS
 *  chosen just because it renders as the first real option. */
export function withPlaceholder(options: { value: string; label: string }[], placeholder: string): { value: string; label: string }[] {
  return [{ value: '', label: placeholder }, ...options];
}

export const LIVE_CONFIG_DESCS: Record<ConfigKind, string> = {
  ssid: 'Create or update a named New Central WLAN profile, verify it, then assign it to the reviewed Central scopes.',
  port: 'Build a switch payload for the named live device. The dry run resolves collector reachability and rollback evidence.',
  vlan: 'Build a VLAN payload for the selected broker scope. The dry run resolves actual reachable devices.',
};

export const LIVE_PUSH_NOTES: Record<ConfigKind, string> = {
  ssid: 'The broker resolves the live target during dry run; no AP count, client count, Mist hand-off, or authentication trust is assumed.',
  port: 'The broker verifies collector reachability and requests a rollback snapshot during dry run.',
  vlan: 'The broker resolves reachable switches during dry run; no device, client, or compliance count is assumed.',
};

export function formForPreview(
  kind: ConfigKind | null,
  ssid: SsidForm,
  port: PortForm,
  vlan: VlanForm,
): ConfigForm {
  return kind === 'port' ? port : kind === 'vlan' ? vlan : ssid;
}

/** Drop values that the selected security mode cannot use. Hidden inputs
 *  must not survive a mode change and later ride along with a direct write.
 *  The dependency rules are the target plane's (Central needs a role for
 *  every mode; Mist keeps only the write-only passphrase). */
export function ssidFormForSecurity(form: SsidForm, security: SsidSecurity): SsidForm {
  const { passphrase, authServerGroupId, captivePortalProfileId, ...base } = form;
  const requirement = ssidDependencyRequirementsFor(security, form.plane);
  return {
    ...base,
    security,
    ...(requirement.passphrase && passphrase !== undefined ? { passphrase } : {}),
    ...(requirement.authServerGroup && authServerGroupId !== undefined ? { authServerGroupId } : {}),
    ...(requirement.captivePortal && captivePortalProfileId !== undefined ? { captivePortalProfileId } : {}),
  };
}
