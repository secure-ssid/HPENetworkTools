/**
 * Systems section deep-link helpers (Loop 124).
 */

import { describe, expect, it } from 'vitest';
import {
  buildSystemsSectionUrl,
  parseSystemsSection,
  systemsSectionDomId,
} from './share';

describe('parseSystemsSection', () => {
  it('accepts canonical keys and common aliases', () => {
    expect(parseSystemsSection('portal')).toBe('portal');
    expect(parseSystemsSection('identity')).toBe('identity');
    expect(parseSystemsSection('identity-provider')).toBe('identity');
    expect(parseSystemsSection('oidc')).toBe('identity');
    expect(parseSystemsSection('assistant')).toBe('assistant');
    expect(parseSystemsSection('chat')).toBe('assistant');
    expect(parseSystemsSection('notifications')).toBe('notifications');
    expect(parseSystemsSection('notify')).toBe('notifications');
    expect(parseSystemsSection('runtime-debug')).toBe('runtime-debug');
    expect(parseSystemsSection('runtime')).toBe('runtime-debug');
    expect(parseSystemsSection('#systems-section-portal')).toBe('portal');
    expect(parseSystemsSection('systems-section-assistant')).toBe('assistant');
  });

  it('rejects unknown keys', () => {
    expect(parseSystemsSection(null)).toBeNull();
    expect(parseSystemsSection('')).toBeNull();
    expect(parseSystemsSection('planes')).toBeNull();
  });
});

describe('buildSystemsSectionUrl', () => {
  it('builds shareable section URLs with hash anchors', () => {
    expect(buildSystemsSectionUrl('portal', 'http://x', '/systems')).toBe(
      'http://x/systems?section=portal#systems-section-portal',
    );
    expect(buildSystemsSectionUrl('identity', 'http://x', '/')).toBe(
      'http://x/systems?section=identity#systems-section-identity',
    );
    expect(systemsSectionDomId('notifications')).toBe('systems-section-notifications');
  });
});
