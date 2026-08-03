/**
 * server/tests/appRisk.test.ts — the DPI application normalizer and
 * aggregators (shared/appRisk.ts), NO network.
 *
 * The risk-bucket aliases, the watchlist split and the category rollup are
 * pinned with hand-computed expectations, including the two honesty rules
 * that make the screen trustworthy: dead fields never render, and the bars
 * are share-of-largest, never percent-of-total.
 */

import { describe, expect, it } from 'vitest';
import {
  DPI_BYTES_ARE_ESTIMATES,
  RISK_BUCKET_ORDER,
  UNCATEGORIZED_CATEGORY,
  appIsFlagged,
  appIsUnclassified,
  byBytesDesc,
  isUnclassifiedCategory,
  normalizeRiskBucket,
  normalizeSiteApp,
  riskBucketCounts,
  rollupAppCategories,
  watchlistSplit,
  type DpiRiskBucket,
  type SiteAppRow,
} from '@hpe/shared';

describe('normalizeRiskBucket — the plane vocabulary folded worst-first', () => {
  it.each([
    ['suspicious', 'suspicious'],
    ['high', 'suspicious'],
    ['very_high', 'suspicious'],
    ['VERY HIGH', 'suspicious'],
    ['moderate', 'moderate'],
    ['medium', 'moderate'],
    ['low', 'low'],
    ['very_low', 'low'],
    ['very low', 'low'],
    ['trustworthy', 'trustworthy'],
    ['trusted', 'trustworthy'],
    ['safe', 'trustworthy'],
    ['unknown', 'unknown'],
    ['not_evaluated', 'unknown'],
    ['not evaluated', 'unknown'],
  ])('%s → %s', (word, bucket) => {
    expect(normalizeRiskBucket(word)).toBe(bucket);
  });

  it('an unlisted word is unknown, never a guess at a better bucket', () => {
    expect(normalizeRiskBucket('probably-fine')).toBe('unknown');
    expect(normalizeRiskBucket('')).toBe('unknown');
    expect(normalizeRiskBucket(null)).toBe('unknown');
    expect(normalizeRiskBucket(undefined)).toBe('unknown');
  });

  it('is idempotent — buckets and aliases normalize to a fixed point', () => {
    const words = [
      'suspicious', 'high', 'very_high', 'moderate', 'medium', 'low', 'very_low',
      'trustworthy', 'trusted', 'safe', 'unknown', 'not_evaluated', 'bogus', '',
    ];
    for (const w of words) {
      expect(normalizeRiskBucket(normalizeRiskBucket(w))).toBe(normalizeRiskBucket(w));
    }
    for (const bucket of RISK_BUCKET_ORDER) {
      expect(normalizeRiskBucket(bucket)).toBe(bucket);
    }
  });

  it('the bucket order is worst-first', () => {
    expect(RISK_BUCKET_ORDER).toEqual(['suspicious', 'moderate', 'low', 'trustworthy', 'unknown']);
  });
});

describe('normalizeSiteApp — one DPI row, dead fields and all', () => {
  const LAST_USED_ISO = '2026-07-28T11:58:00.000Z';
  const ROW = {
    name: 'Microsoft 365',
    id: 'app-0365',
    risk: 'trusted',
    state: 'active',
    rxBytes: '4230000000',
    txBytes: '810000000',
    categories: ['Collaboration', ' Web ', ''],
    applicationHostType: 'cloud',
    destLocation: ['US', ''],
    experience: 0, // the verified dead field
    lastUsedTime: String(Date.parse(LAST_USED_ISO)),
    tlsVersion: '',
    certificateExpiryDate: '',
  };

  it('maps the full row: string bytes, alias risk, trimmed lists, ISO instants', () => {
    const app = normalizeSiteApp(ROW)!;
    expect(app.id).toBe('app-0365');
    expect(app.name).toBe('Microsoft 365');
    expect(app.riskRaw).toBe('trusted'); // the plane's own word, verbatim
    expect(app.risk).toBe('trustworthy');
    expect(app.state).toBe('active');
    expect(app.rxBytes).toBe(4_230_000_000);
    expect(app.txBytes).toBe(810_000_000);
    expect(app.totalBytes).toBe(5_040_000_000);
    expect(app.categories).toEqual(['Collaboration', 'Web']);
    expect(app.applicationHostType).toBe('cloud');
    expect(app.destLocation).toEqual(['US']);
    expect(app.lastUsedAt).toBe(LAST_USED_ISO);
  });

  it('the verified dead fields normalize to null — never a 0 score or a 1970', () => {
    const app = normalizeSiteApp(ROW)!;
    expect(app.experience).toBeNull();
    expect(app.tlsVersion).toBeNull();
    expect(app.certificateExpiryAt).toBeNull();
    expect(normalizeSiteApp({ name: 'x', lastUsedTime: '0' })!.lastUsedAt).toBeNull();
  });

  it('a non-zero experience score survives; an all-zero object does not', () => {
    expect(normalizeSiteApp({ name: 'x', experience: 87 })!.experience).toBe(87);
    expect(normalizeSiteApp({ name: 'x', experience: { score: 91 } })!.experience).toBe(91);
    expect(normalizeSiteApp({ name: 'x', experience: { score: 0 } })!.experience).toBeNull();
  });

  it('a certificate expiry parses from ISO or epoch, and junk is null', () => {
    expect(normalizeSiteApp({ name: 'x', certificateExpiryDate: '2027-01-04T00:00:00Z' })!.certificateExpiryAt).toBe(
      '2027-01-04T00:00:00.000Z',
    );
    expect(
      normalizeSiteApp({ name: 'x', certificateExpiryDate: String(Date.parse('2027-01-04T00:00:00Z')) })!
        .certificateExpiryAt,
    ).toBe('2027-01-04T00:00:00.000Z');
    expect(normalizeSiteApp({ name: 'x', certificateExpiryDate: 'someday' })!.certificateExpiryAt).toBeNull();
  });

  it('totalBytes is null when neither side was reported, and one-sided when one was', () => {
    expect(normalizeSiteApp({ name: 'x' })!.totalBytes).toBeNull();
    expect(normalizeSiteApp({ name: 'x', rxBytes: '10' })!.totalBytes).toBe(10);
    expect(normalizeSiteApp({ name: 'x', txBytes: 7 })!.totalBytes).toBe(7);
  });

  it('falls back between name and id, and drops a row that names nothing', () => {
    expect(normalizeSiteApp({ id: 'app-9' })!.name).toBe('app-9');
    expect(normalizeSiteApp({ name: 'only-name' })!.id).toBe('only-name');
    expect(normalizeSiteApp({ risk: 'high' })).toBeNull();
    expect(normalizeSiteApp({})).toBeNull();
    expect(normalizeSiteApp(null)).toBeNull();
    expect(normalizeSiteApp('junk')).toBeNull();
  });
});

describe('the watchlist split', () => {
  const app = (over: Partial<SiteAppRow>): SiteAppRow => ({
    id: 'a', name: 'a', riskRaw: '', risk: 'unknown', state: '', rxBytes: null, txBytes: null,
    totalBytes: null, categories: [], applicationHostType: null, destLocation: [],
    experience: null, lastUsedAt: null, tlsVersion: null, certificateExpiryAt: null, ...over,
  });

  it('the unclassified words are exactly the verified set, case-insensitively', () => {
    for (const w of ['', 'not available', 'unknown', 'n/a', 'none', ' N/A ', 'UNKNOWN']) {
      expect(isUnclassifiedCategory(w)).toBe(true);
    }
    expect(isUnclassifiedCategory('Streaming')).toBe(false);
  });

  it('flagged = suspicious or moderate; unclassified = every category a non-answer', () => {
    expect(appIsFlagged(app({ risk: 'suspicious' }))).toBe(true);
    expect(appIsFlagged(app({ risk: 'moderate' }))).toBe(true);
    expect(appIsFlagged(app({ risk: 'low' }))).toBe(false);
    expect(appIsFlagged(app({ risk: 'unknown' }))).toBe(false);
    expect(appIsUnclassified(app({ categories: [] }))).toBe(true); // none at all
    expect(appIsUnclassified(app({ categories: ['unknown', 'n/a'] }))).toBe(true);
    expect(appIsUnclassified(app({ categories: ['unknown', 'Streaming'] }))).toBe(false);
  });

  it('splits the flagged rows and leaves everything else out', () => {
    const rows = [
      app({ name: 'tor', risk: 'suspicious', categories: ['Anonymizer'] }),
      app({ name: 'mystery', risk: 'moderate', categories: ['unknown'] }),
      app({ name: 'quiet-udp', risk: 'low', categories: ['not available'] }), // unclassified but NOT flagged
      app({ name: 'yt', risk: 'low', categories: ['Streaming'] }),
      app({ name: 'bt', risk: 'suspicious', categories: ['Peer-to-Peer'] }),
    ];
    const split = watchlistSplit(rows);
    expect(split.unclassified.map((a) => a.name)).toEqual(['mystery']);
    expect(split.known.map((a) => a.name)).toEqual(['tor', 'bt']);
  });
});

describe('aggregates', () => {
  const app = (over: Partial<SiteAppRow>): SiteAppRow => ({
    id: 'a', name: 'a', riskRaw: '', risk: 'unknown', state: '', rxBytes: null, txBytes: null,
    totalBytes: null, categories: [], applicationHostType: null, destLocation: [],
    experience: null, lastUsedAt: null, tlsVersion: null, certificateExpiryAt: null, ...over,
  });

  it('byBytesDesc ranks by total, unreported totals last, names break ties', () => {
    const ranked = byBytesDesc([
      app({ name: 'zeta', totalBytes: 50 }),
      app({ name: 'no-bytes' }),
      app({ name: 'alpha', totalBytes: 100 }),
      app({ name: 'beta', totalBytes: 100 }),
    ]);
    expect(ranked.map((a) => a.name)).toEqual(['alpha', 'beta', 'zeta', 'no-bytes']);
  });

  it('riskBucketCounts carries every bucket, zeros included', () => {
    const counts = riskBucketCounts([app({ risk: 'suspicious' }), app({ risk: 'suspicious' }), app({ risk: 'low' })]);
    expect(counts).toEqual({ suspicious: 2, moderate: 0, low: 1, trustworthy: 0, unknown: 0 });
    // every key a renderer might index is present
    for (const bucket of RISK_BUCKET_ORDER) expect(Object.keys(counts)).toContain(bucket);
  });

  it('the honesty caveat is pinned verbatim', () => {
    expect(DPI_BYTES_ARE_ESTIMATES).toBe(
      'DPI byte totals are estimates — read as a ranking, not a measurement',
    );
  });

  it('bytes sum into EVERY category an app carries, and shares are share-of-largest', () => {
    const rolled = rollupAppCategories([
      app({ name: 'a', totalBytes: 100, categories: ['Web', 'Streaming'] }),
      app({ name: 'b', totalBytes: 50, categories: ['Streaming'] }),
      app({ name: 'c', totalBytes: 30, categories: ['unknown'] }), // → Uncategorized
      app({ name: 'd', totalBytes: null, categories: ['Web'] }), // counts an app, no bytes
    ]);
    expect(rolled.map((r) => r.category)).toEqual(['Streaming', 'Web', UNCATEGORIZED_CATEGORY]);
    const [streaming, web, uncategorized] = rolled;
    expect(streaming).toMatchObject({ apps: 2, bytes: 150, share: 1 });
    // 100/150 = share of the LARGEST — percent of the 280 total would be ~0.36
    expect(web.share).toBeCloseTo(100 / 150, 9);
    expect(web.apps).toBe(2); // 'd' counts even with no bytes
    expect(uncategorized).toMatchObject({ apps: 1, bytes: 30, share: 30 / 150 });
  });

  it('a fully unclassified table rolls one honest Uncategorized bucket with share 0 when nothing has bytes', () => {
    const rolled = rollupAppCategories([app({ name: 'a', categories: ['n/a'] }), app({ name: 'b', categories: [] })]);
    expect(rolled).toEqual([{ category: UNCATEGORIZED_CATEGORY, apps: 2, bytes: 0, share: 0 }]);
  });
});

describe('DpiRiskBucket stays a closed vocabulary', () => {
  it('every bucket is reachable from an alias and maps to itself', () => {
    const buckets: DpiRiskBucket[] = [...RISK_BUCKET_ORDER];
    expect(new Set(buckets).size).toBe(5);
  });
});
