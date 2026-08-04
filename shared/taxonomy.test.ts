import { describe, expect, it } from 'vitest';
import {
  classifyClient,
  classifyDevice,
  clientTypeBuckets,
  deviceTypeBuckets,
  inferDeviceFamily,
  inferDeviceRoleHint,
} from './taxonomy';

describe('taxonomy', () => {
  it('classifies device family and role hints from model/name', () => {
    const sw = classifyDevice({ type: 'switch', name: 'sw-core-a', model: 'CX 8325-48Y8C' });
    expect(sw.typeLabel).toBe('Switch');
    expect(sw.family).toBe('AOS-CX');
    expect(sw.roleHint).toBe('core');
    expect(inferDeviceFamily('AP-635')).toBe('Access point');
    expect(inferDeviceRoleHint({ type: 'ap', name: 'ap-3f-08' })).toBe('wireless edge');
  });

  it('prefers ClearPass profiled category over observed client type', () => {
    const tax = classifyClient(
      { type: 'unknown', model: 'generic' },
      { category: 'Phone', family: 'iOS', os: 'iOS 17', insightTags: ['Apple'] },
    );
    expect(tax.effectiveCategory).toBe('Phone');
    expect(tax.categoryConfidence).toBe('profiled');
    expect(tax.osFamily).toBe('iOS');
  });

  it('falls back to observed type then unknown', () => {
    expect(classifyClient({ type: 'laptop' }).categoryConfidence).toBe('observed');
    expect(classifyClient({ type: 'unknown' }).categoryConfidence).toBe('unknown');
  });

  it('buckets device and client types with counts', () => {
    expect(deviceTypeBuckets([{ type: 'switch' }, { type: 'switch' }, { type: 'ap' }])).toEqual([
      expect.objectContaining({ key: 'switch', count: 2 }),
      expect.objectContaining({ key: 'ap', count: 1 }),
    ]);
    expect(clientTypeBuckets([{ type: 'phone' }, { type: 'laptop' }])[0]?.count).toBe(1);
  });
});
