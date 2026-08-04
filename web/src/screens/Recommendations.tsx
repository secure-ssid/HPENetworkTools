/**
 * web/src/screens/Recommendations.tsx — full-page read-only config hygiene.
 *
 * Deep-link filters: `?device=&site=&client=&severity=&category=` plus bulk
 * selection `?ids=` (Loop 186 — panel **Copy selection link**). When only
 * `?ids=` is active the header offers **Clear selection filter** (Loop 220);
 * mixed triage still says **Clear filters**. Panel selection-empty deep links
 * keep their own CTA (Loop 205). Panel scope-filter empties offer **Clear filters**
 * via the same strip reset (Loop 222). Header `KeyboardShortcuts` surfaces the
 * multi-select grid map (`?` / DATATABLE_ROW_SHORTCUTS — Loop 234). Suggestions
 * never auto-apply; cards only hand off to existing screens. Server CSV via
 * `/api/recommendations/export` (same filters). Visual references attach
 * operator floorplans/docs beside the hygiene list (not telemetry).
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { RecommendationCategory, RecommendationSeverity } from '@hpe/shared';
import {
  Alert,
  Badge,
  Button,
  DATATABLE_ROW_SHORTCUTS,
  Input,
  KeyboardShortcuts,
  Select,
  useToast,
} from '../nightdesk';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { recommendationsPath } from '../app/nav';
import { getRecommendations } from '../api/recommendations';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { ScreenHeader } from './ScreenHeader';

const SEVERITIES: RecommendationSeverity[] = ['warning', 'suggestion', 'info'];
const CATEGORIES: RecommendationCategory[] = [
  'firmware',
  'configuration',
  'redundancy',
  'security',
  'performance',
  'compliance',
  'inventory',
];

const SEV_CHIP_META: Array<{
  key: RecommendationSeverity;
  label: string;
  tone: 'danger' | 'warning' | 'info';
}> = [
  { key: 'warning', label: 'Warning', tone: 'danger' },
  { key: 'suggestion', label: 'Suggestion', tone: 'warning' },
  { key: 'info', label: 'Info', tone: 'info' },
];

const CAT_CHIP_META: Array<{
  key: RecommendationCategory;
  label: string;
}> = CATEGORIES.map((c) => ({
  key: c,
  label: c.charAt(0).toUpperCase() + c.slice(1),
}));

function trimOrEmpty(value: string | null): string {
  return value?.trim() ?? '';
}

function parseSeverity(raw: string | null): 'all' | RecommendationSeverity {
  const v = raw?.trim().toLowerCase() ?? '';
  if (v === 'warning' || v === 'suggestion' || v === 'info') return v;
  return 'all';
}

function parseCategory(raw: string | null): 'all' | RecommendationCategory {
  const v = raw?.trim().toLowerCase() ?? '';
  if ((CATEGORIES as readonly string[]).includes(v)) return v as RecommendationCategory;
  return 'all';
}

export default function Recommendations() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [device, setDevice] = useState(() => trimOrEmpty(searchParams.get('device')));
  const [site, setSite] = useState(() => trimOrEmpty(searchParams.get('site')));
  const [client, setClient] = useState(() => trimOrEmpty(searchParams.get('client')));
  const [severity, setSeverity] = useState<'all' | RecommendationSeverity>(() =>
    parseSeverity(searchParams.get('severity')),
  );
  const [category, setCategory] = useState<'all' | RecommendationCategory>(() =>
    parseCategory(searchParams.get('category')),
  );
  const [sevCounts, setSevCounts] = useState<Record<RecommendationSeverity, number>>({
    warning: 0,
    suggestion: 0,
    info: 0,
  });
  const [catCounts, setCatCounts] = useState<Partial<Record<RecommendationCategory, number>>>({});

  // Hydrate from URL when share links change (back/forward / paste).
  const [prevParams, setPrevParams] = useState(searchParams);
  if (prevParams !== searchParams) {
    setPrevParams(searchParams);
    setDevice(trimOrEmpty(searchParams.get('device')));
    setSite(trimOrEmpty(searchParams.get('site')));
    setClient(trimOrEmpty(searchParams.get('client')));
    setSeverity(parseSeverity(searchParams.get('severity')));
    setCategory(parseCategory(searchParams.get('category')));
  }

  const pushFilters = useCallback(
    (next: {
      device: string;
      site: string;
      client: string;
      severity: 'all' | RecommendationSeverity;
      category: 'all' | RecommendationCategory;
    }) => {
      const params = new URLSearchParams();
      if (next.device.trim()) params.set('device', next.device.trim());
      if (next.site.trim()) params.set('site', next.site.trim());
      if (next.client.trim()) params.set('client', next.client.trim());
      if (next.severity !== 'all') params.set('severity', next.severity);
      if (next.category !== 'all') params.set('category', next.category);
      /* Preserve bulk selection deep-link ids= (Loop 186). */
      const ids = searchParams.get('ids');
      if (ids != null && ids.trim()) params.set('ids', ids);
      if (params.toString() === searchParams.toString()) return;
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Debounce URL writes while typing so history stays calm.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      pushFilters({ device, site, client, severity, category });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [device, site, client, severity, category, pushFilters]);

  /* Severity chips count over device+site+client+category (not severity) so
   * operators see the full severity mix while a chip is active. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getRecommendations({
          device: device.trim() || undefined,
          site: site.trim() || undefined,
          client: client.trim() || undefined,
          category: category !== 'all' ? category : undefined,
          limit: 200,
        });
        if (cancelled) return;
        setSevCounts({
          warning: res.counts.bySeverity.warning ?? 0,
          suggestion: res.counts.bySeverity.suggestion ?? 0,
          info: res.counts.bySeverity.info ?? 0,
        });
      } catch {
        if (!cancelled) setSevCounts({ warning: 0, suggestion: 0, info: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device, site, client, category]);

  /* Category chips count over device+site+client+severity (not category) so
   * operators see the full category mix while a chip is active — Loop 146. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getRecommendations({
          device: device.trim() || undefined,
          site: site.trim() || undefined,
          client: client.trim() || undefined,
          severity: severity !== 'all' ? severity : undefined,
          limit: 200,
        });
        if (cancelled) return;
        setCatCounts(res.counts.byCategory ?? {});
      } catch {
        if (!cancelled) setCatCounts({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device, site, client, severity]);

  const copyFilterLink = () => {
    void (async () => {
      const path = recommendationsPath({
        device: device || undefined,
        site: site || undefined,
        client: client || undefined,
        severity: severity !== 'all' ? severity : undefined,
        category: category !== 'all' ? category : undefined,
      });
      const url = `${window.location.origin}${path}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Filter link copied', {
          description: path,
          tone: 'success',
        });
      } catch {
        toast('Could not copy link', { description: url, tone: 'warning' });
      }
    })();
  };

  const downloadServerCsv = () => {
    void (async () => {
      const qs = new URLSearchParams();
      if (device.trim()) qs.set('device', device.trim());
      if (site.trim()) qs.set('site', site.trim());
      if (client.trim()) qs.set('client', client.trim());
      if (severity !== 'all') qs.set('severity', severity);
      if (category !== 'all') qs.set('category', category);
      const suffix = qs.toString() ? `?${qs}` : '';
      const res = await downloadApiCsv(
        `/api/recommendations/export${suffix}`,
        'config-recommendations.csv',
      );
      if (res.ok) {
        toast('Server CSV downloaded', {
          description: 'config-recommendations.csv — filtered suggestions (read-only).',
          tone: 'success',
        });
      } else {
        toast('Server CSV failed', {
          description: res.error ?? 'Could not download recommendations export',
          tone: 'warning',
        });
      }
    })();
  };

  const scopedDevice = device.trim() || undefined;
  const scopedSite = site.trim() || undefined;
  const scopedClient = client.trim() || undefined;
  const scopedSeverity = severity !== 'all' ? severity : undefined;
  const scopedCategory = category !== 'all' ? category : undefined;
  const idsActive = Boolean((searchParams.get('ids') ?? '').trim());
  const scopeFiltersActive =
    Boolean(device.trim()) ||
    Boolean(site.trim()) ||
    Boolean(client.trim()) ||
    severity !== 'all' ||
    category !== 'all';
  const filtersActive = scopeFiltersActive || idsActive;
  /** Header labels selection-only clears apart from mixed triage (Loop 220). */
  const selectionOnlyActive = idsActive && !scopeFiltersActive;
  const sevChips = SEV_CHIP_META.map((m) => ({
    ...m,
    count: sevCounts[m.key] ?? 0,
  })).filter((c) => c.count > 0 || severity === c.key);
  const catChips = CAT_CHIP_META.map((m) => ({
    ...m,
    count: catCounts[m.key] ?? 0,
  })).filter((c) => c.count > 0 || category === c.key);
  const clearSelectionFilter = () => {
    if (!idsActive) return;
    const next = new URLSearchParams(searchParams);
    next.delete('ids');
    setSearchParams(next, { replace: true });
  };
  const clearFilters = () => {
    setDevice('');
    setSite('');
    setClient('');
    setSeverity('all');
    setCategory('all');
    clearSelectionFilter();
  };

  return (
    <div className="nt-page nt-stack-16 nt-recon-reveal nt-recommendations-shell nt-section-panel">
      <ScreenHeader
        overline="Change · Hygiene"
        title="Recommendations"
        subtitle="Read-only config hygiene suggestions from observed inventory. The portal never auto-applies these — open a related screen to act."
        actions={
          <>
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · hygiene
            </span>
            <Badge tone="neutral">READ ONLY</Badge>
            <Button variant="ghost" size="sm" onClick={copyFilterLink}>
              Copy filter link
            </Button>
            <Button variant="secondary" size="sm" onClick={downloadServerCsv}>
              Download server CSV
            </Button>
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
            {filtersActive ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={selectionOnlyActive ? clearSelectionFilter : clearFilters}
              >
                {selectionOnlyActive ? 'Clear selection filter' : 'Clear filters'}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="nt-plane-theater" role="note">NightDesk · recommendation theater · severity owns hue · never auto-applied</div>

      <Alert tone="info" title="Suggestions only">
        <span className="nt-fs-13">
          Filters deep-link via <code>?device=</code>, <code>?site=</code>, <code>?client=</code>,{' '}
          <code>?severity=</code>, <code>?category=</code>, and bulk <code>?ids=</code>. Severity chips
          share the same <code>?severity=</code> as the Select; category chips share{' '}
          <code>?category=</code>. Multi-select never auto-applies — export or share only.
        </span>
      </Alert>

      <div className="nt-wrap-8 nt-toolbar" role="search" aria-label="Recommendation filters">
        <div className="nt-filter-field nt-min-w-160">
          <Input
            size="sm"
            mono
            placeholder="device name"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            aria-label="Filter by device"
          />
        </div>
        <div className="nt-filter-field nt-min-w-160">
          <Input
            size="sm"
            mono
            placeholder="site"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            aria-label="Filter by site"
          />
        </div>
        <div className="nt-filter-field nt-min-w-160">
          <Input
            size="sm"
            mono
            placeholder="client MAC"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            aria-label="Filter by client MAC"
          />
        </div>
        <div className="nt-filter-field nt-min-w-140">
          <Select
            size="sm"
            value={severity}
            onValueChange={(v) => setSeverity(parseSeverity(v))}
            options={[
              { value: 'all', label: 'All severities' },
              ...SEVERITIES.map((s) => ({ value: s, label: s })),
            ]}
            aria-label="Filter by severity"
          />
        </div>
        <div className="nt-filter-field nt-min-w-160">
          <Select
            size="sm"
            value={category}
            onValueChange={(v) => setCategory(parseCategory(v))}
            options={[
              { value: 'all', label: 'All categories' },
              ...CATEGORIES.map((c) => ({ value: c, label: c })),
            ]}
            aria-label="Filter by category"
          />
        </div>
      </div>

      {sevChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Recommendation severity">
          <span className="nt-chip-row__label">Severity</span>
          {sevChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setSeverity(severity === c.key ? 'all' : c.key)}
              className={severity === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={severity === c.key}
            >
              <Badge tone={c.tone}>{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {catChips.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Recommendation category">
          <span className="nt-chip-row__label">Category</span>
          {catChips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(category === c.key ? 'all' : c.key)}
              className={category === c.key ? 'nt-chip nt-chip--active nt-toggle-chip' : 'nt-chip nt-toggle-chip'}
              aria-pressed={category === c.key}
            >
              <Badge tone="neutral">{c.label}</Badge>
              <span className="nt-chip__count">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      <VisualReferencePanel target={{ kind: 'service', id: 'recommendations' }} editable={false} />

      <ConfigRecommendationsPanel
        key={`${scopedDevice ?? ''}|${scopedSite ?? ''}|${scopedClient ?? ''}|${scopedSeverity ?? ''}|${scopedCategory ?? ''}`}
        title="Filtered recommendations"
        device={scopedDevice}
        site={scopedSite}
        clientMac={scopedClient}
        severity={scopedSeverity}
        category={scopedCategory}
        limit={50}
        showCopyLink={false}
        onClearFilters={clearFilters}
      />
    </div>
  );
}
