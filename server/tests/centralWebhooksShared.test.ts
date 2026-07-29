/**
 * server/tests/centralWebhooksShared.test.ts — shared/webhooks.ts's pure
 * contracts: id/URL validation, SSRF-defense host classification, form
 * validation, the non-secret review diff, and the target-URL formatter.
 *
 * These are plain functions with no server/registry dependency, so this
 * file needs no HPE_SETTINGS_PATH/HPE_DATA_DIR setup and imports `shared`
 * statically like server/tests/sharedContracts.test.ts does.
 */

import { describe, expect, it } from 'vitest';
import {
  buildWebhookReviewDiff,
  canonicalizeWebhookCreateForm,
  canonicalWebhookCreateCandidate,
  isCreateFormComplete,
  isPrivateOrReservedHost,
  isWebhookId,
  validateCallbackUrl,
  validateWebhookForm,
  webhookTargetUrl,
  WEBHOOKS_API_PATH,
  type WebhookDetail,
  type WebhookForm,
} from '../../shared';

describe('isWebhookId', () => {
  it('accepts a uuid', () => {
    expect(isWebhookId('a5e6f0a0-2a4b-4d9a-9d5e-8f1c2b3a4d5e')).toBe(true);
  });
  it('rejects a path-traversal or non-id string', () => {
    expect(isWebhookId('../../etc/passwd')).toBe(false);
    expect(isWebhookId('abc/def')).toBe(false);
    expect(isWebhookId('')).toBe(false);
    expect(isWebhookId(42 as unknown as string)).toBe(false);
  });
  it('rejects an id longer than 64 characters', () => {
    expect(isWebhookId('a'.repeat(65))).toBe(false);
    expect(isWebhookId('a'.repeat(64))).toBe(true);
  });
});

describe('isPrivateOrReservedHost (SSRF defense-in-depth)', () => {
  it('flags loopback, link-local, RFC1918, and the cloud metadata address', () => {
    expect(isPrivateOrReservedHost('localhost')).toBe(true);
    expect(isPrivateOrReservedHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedHost('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedHost('internal-service.local')).toBe(true);
    expect(isPrivateOrReservedHost('bare-hostname')).toBe(true);
    expect(isPrivateOrReservedHost('fe80::1')).toBe(true);
    expect(isPrivateOrReservedHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('fc00::1')).toBe(true);
    expect(isPrivateOrReservedHost('192.0.2.1')).toBe(true);
    expect(isPrivateOrReservedHost('198.51.100.1')).toBe(true);
    expect(isPrivateOrReservedHost('203.0.113.1')).toBe(true);
    expect(isPrivateOrReservedHost('127.1')).toBe(true);
    expect(isPrivateOrReservedHost('localhost.')).toBe(true);
  });
  it('allows an ordinary public hostname and public IPv4', () => {
    expect(isPrivateOrReservedHost('example.com')).toBe(false);
    expect(isPrivateOrReservedHost('webhook.site')).toBe(false);
    expect(isPrivateOrReservedHost('8.8.8.8')).toBe(false);
  });
});

describe('validateCallbackUrl', () => {
  it('requires an absolute URL', () => {
    expect(validateCallbackUrl('').ok).toBe(false);
    expect(validateCallbackUrl('not a url').ok).toBe(false);
    expect(validateCallbackUrl('/relative/path').ok).toBe(false);
  });
  it('requires HTTPS by default, rejecting http', () => {
    const result = validateCallbackUrl('http://example.com/hook');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/HTTPS/);
  });
  it('accepts https', () => {
    expect(validateCallbackUrl('https://example.com/hook')).toEqual({ ok: true });
  });
  it('has no request-side insecure override', () => {
    expect(validateCallbackUrl('http://example.com/hook').ok).toBe(false);
    expect(validateCallbackUrl('http://localhost:4000/hook').ok).toBe(false);
  });
  it('rejects ambiguous numeric and trailing-dot hosts', () => {
    expect(validateCallbackUrl('https://127.1/hook').ok).toBe(false);
    expect(validateCallbackUrl('https://localhost./hook').ok).toBe(false);
    expect(validateCallbackUrl('https://example.com./hook').ok).toBe(false);
  });
  it('rejects a non-http(s) scheme', () => {
    expect(validateCallbackUrl('ftp://example.com/hook').ok).toBe(false);
  });
});

const BASE_API_KEY_FORM: WebhookForm = {
  name: 'noc-hook',
  endpoint: 'https://example.com/hook',
  authMechanism: 'API_KEY',
  apiKey: 'a-real-key',
};

const BASE_OIDC_FORM: WebhookForm = {
  name: 'noc-hook',
  endpoint: 'https://example.com/hook',
  authMechanism: 'OIDC',
  oidcClientId: 'client-1',
  oidcClientSecret: 'secret-1',
  oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
};

describe('validateWebhookForm / isCreateFormComplete', () => {
  it('accepts a complete API_KEY form', () => {
    expect(validateWebhookForm(BASE_API_KEY_FORM)).toEqual([]);
    expect(isCreateFormComplete(BASE_API_KEY_FORM)).toBe(true);
  });
  it('accepts a complete OIDC form', () => {
    expect(validateWebhookForm(BASE_OIDC_FORM)).toEqual([]);
    expect(isCreateFormComplete(BASE_OIDC_FORM)).toBe(true);
  });
  it('requires a name, capped at 64 characters', () => {
    expect(validateWebhookForm({ ...BASE_API_KEY_FORM, name: '' })).toContain('name is required');
    expect(validateWebhookForm({ ...BASE_API_KEY_FORM, name: 'x'.repeat(65) })).toContain(
      'name must be 64 characters or fewer',
    );
  });
  it('requires OIDC client ID, secret, and well-known URL — each reported separately', () => {
    const errors = validateWebhookForm({ ...BASE_OIDC_FORM, oidcClientId: '', oidcWellKnownUrl: '' });
    expect(errors).toContain('OIDC client ID is required');
    expect(errors).toContain('OIDC well-known URL is required');
  });
  it('isCreateFormComplete is false when the matching secret is missing, even if otherwise valid', () => {
    expect(isCreateFormComplete({ ...BASE_API_KEY_FORM, apiKey: '' })).toBe(false);
    expect(isCreateFormComplete({ ...BASE_OIDC_FORM, oidcClientSecret: '' })).toBe(false);
  });
  it('flags an unsupported endpoint URL', () => {
    expect(validateWebhookForm({ ...BASE_API_KEY_FORM, endpoint: 'http://example.com/hook' }).length).toBeGreaterThan(0);
  });

  it('canonicalizes trimmed non-secret create identity while preserving secret bytes', () => {
    const canonical = canonicalizeWebhookCreateForm({
      name: '  hook  ',
      endpoint: '  https://hooks.example.com/callback  ',
      authMechanism: 'OIDC',
      oidcClientId: '  client  ',
      oidcClientSecret: ' secret bytes ',
      oidcWellKnownUrl: '  https://issuer.example/.well-known/openid-configuration  ',
    });
    expect(canonical).toEqual({
      name: 'hook',
      endpoint: 'https://hooks.example.com/callback',
      authMechanism: 'OIDC',
      oidcClientId: 'client',
      oidcClientSecret: ' secret bytes ',
      oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
    });
    expect(canonicalWebhookCreateCandidate(canonical)).not.toHaveProperty('oidcClientSecret');
    expect(buildWebhookReviewDiff(null, {
      ...canonical,
      name: '  hook  ',
      endpoint: '  https://hooks.example.com/callback  ',
    })).toContain('+ name: hook');
  });
});

describe('buildWebhookReviewDiff — exact, never a secret value', () => {
  const existingApiKey: WebhookDetail = {
    id: 'wh-1',
    name: 'old-name',
    endpoint: 'https://old.example/hook',
    authMechanism: 'API_KEY',
    generation: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: null,
    apiKeyConfigured: true,
    oidcClientSecretConfigured: false,
  };

  it('marks every field as new (+) for a brand-new webhook', () => {
    const diff = buildWebhookReviewDiff(null, BASE_API_KEY_FORM);
    expect(diff).toContain('+ name: noc-hook');
    expect(diff).toContain('+ endpoint: https://example.com/hook');
    expect(diff.some((l) => l.startsWith('+ apiKey:'))).toBe(true);
    expect(diff.join('\n')).not.toContain('a-real-key');
  });

  it('shows a before/after pair only for fields that actually changed', () => {
    const diff = buildWebhookReviewDiff(existingApiKey, { ...BASE_API_KEY_FORM, name: 'old-name' });
    expect(diff).toContain('  expected generation: 1');
    expect(diff).toContain('  name: old-name'); // unchanged
    expect(diff).toContain('- endpoint: https://old.example/hook');
    expect(diff).toContain('+ endpoint: https://example.com/hook');
  });

  it('never renders a secret value, only a redacted set/replace/unchanged marker', () => {
    const diff = buildWebhookReviewDiff(existingApiKey, BASE_API_KEY_FORM).join('\n');
    expect(diff).not.toContain('a-real-key');
    expect(diff).toMatch(/apiKey: \(replaced — write-only, never shown\)/);

    const oidcDiff = buildWebhookReviewDiff(null, BASE_OIDC_FORM).join('\n');
    expect(oidcDiff).not.toContain('secret-1');
    expect(oidcDiff).toMatch(/oidcClientSecret: \(set — write-only, never shown\)/);
    // Non-secret OIDC fields ARE shown in full.
    expect(oidcDiff).toContain('client-1');
  });

  it('reports the auth mechanism transition explicitly', () => {
    const diff = buildWebhookReviewDiff(existingApiKey, BASE_OIDC_FORM).join('\n');
    expect(diff).toContain('- authMechanism: API_KEY');
    expect(diff).toContain('+ authMechanism: OIDC');
  });
});

describe('webhookTargetUrl', () => {
  it('builds the exact outbound path for list/create, single-object, and rotate', () => {
    const base = 'https://us1.api.central.arubanetworks.com';
    expect(webhookTargetUrl(base)).toBe(`${base}${WEBHOOKS_API_PATH}`);
    expect(webhookTargetUrl(base, 'wh-1')).toBe(`${base}${WEBHOOKS_API_PATH}/wh-1`);
    expect(webhookTargetUrl(base, 'wh-1', 'rotate-hmac-key')).toBe(`${base}${WEBHOOKS_API_PATH}/wh-1/rotate-hmac-key`);
  });
  it('renders a placeholder, never a broken URL, when Central is not linked', () => {
    expect(webhookTargetUrl(null)).toContain('not linked');
  });
});
