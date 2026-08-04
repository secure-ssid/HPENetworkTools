/**
 * Read-only configuration recommendations. Never pushes — only hands off to
 * existing screens (Configure, ClearPass, Systems, device detail).
 *
 * Scope filters prefer explicit props; otherwise
 * `?device=&site=&client=&severity=&category=` from the URL (full-page / deep-link).
 * **Copy panel context link** always shares the canonical `/recommendations`
 * surface with those filters.
 *
 * Multi-select (Loop 186) raises **Export selected**, **Copy IDs** (unique
 * newline-joined recommendation ids), **Copy titles** (unique newline-joined
 * titles when ids alone are sparse for a handoff — Alerts / Tickets **Copy
 * titles** pattern; Loop 234), **Copy selection link** (canonical
 * `/recommendations?ids=` plus active scope filters; clearable chip), and
 * **Clear**. Selection-empty deep links offer **Clear selection filter**
 * (Loop 205). Scope-filter empties (device/site/client/severity/category — not
 * selection) offer **Clear filters** via `onClearFilters` or URL-owned scope
 * (Loop 222). Full-list CSV stays in the header.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { countOf } from '@hpe/shared';
import type {
  ConfigRecommendation,
  RecommendationCategory,
  RecommendationSeverity,
} from '@hpe/shared';
import { getRecommendations } from '../api/recommendations';
import { namesFilterForParam, recommendationsPath } from '../app/nav';
import { ActionOverflow } from './ActionOverflow';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { exportTableCsv } from '../lib/csv';
import { Alert, Badge, Button, EmptyState, SectionHeader, Skeleton, useToast } from '../nightdesk';

const SEVERITY_TONE: Record<RecommendationSeverity, 'info' | 'warning' | 'danger' | 'neutral'> = {
  info: 'info',
  suggestion: 'warning',
  warning: 'danger',
};

const CATEGORIES: RecommendationCategory[] = [
  'firmware',
  'configuration',
  'redundancy',
  'security',
  'performance',
  'compliance',
  'inventory',
];

function trimParam(value: string | null | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

function parseSeverityParam(raw: string | null | undefined): RecommendationSeverity | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === 'warning' || v === 'suggestion' || v === 'info') return v;
  return undefined;
}

function parseCategoryParam(raw: string | null | undefined): RecommendationCategory | undefined {
  const v = raw?.trim().toLowerCase() ?? '';
  if ((CATEGORIES as readonly string[]).includes(v)) return v as RecommendationCategory;
  return undefined;
}

export function ConfigRecommendationsPanel({
  device,
  site,
  clientMac,
  severity,
  category,
  /**
   * Categories this screen already surfaces natively, so the roll-up does not
   * restate them. Overview lists alerts in "Needs you now"; repeating them as
   * `performance` recommendations a few hundred pixels above was the same
   * finding twice on one page.
   */
  excludeCategories,
  limit = 12,
  title = 'Recommendations',
  initialRecommendations,
  /** When false, hide Copy panel context link (full-page owns share chrome). */
  showCopyLink = true,
  /** Parent-owned scope clear (full-page Recommendations filter strip — Loop 222). */
  onClearFilters,
}: {
  device?: string;
  site?: string;
  clientMac?: string;
  severity?: RecommendationSeverity;
  category?: RecommendationCategory;
  excludeCategories?: RecommendationCategory[];
  limit?: number;
  title?: string;
  /** Test seam */
  initialRecommendations?: ConfigRecommendation[];
  showCopyLink?: boolean;
  onClearFilters?: () => void;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<ConfigRecommendation[] | null>(initialRecommendations ?? null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /recommendations?ids=a\nb (bulk Copy selection link). */
  const idsFilter = namesFilterForParam(searchParams.get('ids'));
  const idsFilterLc =
    idsFilter === null
      ? null
      : idsFilter.map((id) => id.trim().toLowerCase()).filter(Boolean);

  const effectiveDevice = device ?? trimParam(searchParams.get('device'));
  const effectiveSite = site ?? trimParam(searchParams.get('site'));
  const effectiveClient = clientMac ?? trimParam(searchParams.get('client'));
  const effectiveSeverity = severity ?? parseSeverityParam(searchParams.get('severity'));
  const effectiveCategory = category ?? parseCategoryParam(searchParams.get('category'));

  const scopeKey = JSON.stringify({
    device: effectiveDevice ?? '',
    site: effectiveSite ?? '',
    client: effectiveClient ?? '',
    severity: effectiveSeverity ?? '',
    category: effectiveCategory ?? '',
    limit,
  });

  useEffect(() => {
    if (initialRecommendations) return;
    let cancelled = false;
    void (async () => {
      try {
        setError(null);
        const res = await getRecommendations({
          device: effectiveDevice,
          site: effectiveSite,
          client: effectiveClient,
          severity: effectiveSeverity,
          category: effectiveCategory,
          limit,
        });
        if (cancelled) return;
        setRows(res.recommendations);
        setNote(res.note);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message || 'Could not load recommendations');
        setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // scopeKey captures the effective filters + limit
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional stable key
  }, [scopeKey, initialRecommendations]);

  const exportClientCsv = () => {
    if (!rows || rows.length === 0) return;
    const n = exportTableCsv(
      'config-recommendations.csv',
      [
        'id',
        'ruleId',
        'severity',
        'category',
        'title',
        'detail',
        'actionType',
        'evidence',
        'evidenceNote',
        'device',
        'site',
        'clientMac',
        'plane',
        'handoffPath',
        'impactCount',
      ],
      rows.map((r) => [
        r.id,
        r.ruleId,
        r.severity,
        r.category,
        r.title,
        r.detail,
        r.actionType,
        r.evidence,
        r.evidenceNote ?? '',
        r.device ?? '',
        r.site ?? '',
        r.clientMac ?? '',
        r.plane ?? '',
        r.handoffPath ?? '',
        r.impactCount ?? '',
      ]),
    );
    toast(`Exported ${n} recommendation${n === 1 ? '' : 's'}`, {
      description: 'config-recommendations.csv — rows currently in view (read-only).',
    });
  };

  const exportServerCsv = () => {
    void (async () => {
      const qs = new URLSearchParams();
      if (effectiveDevice) qs.set('device', effectiveDevice);
      if (effectiveSite) qs.set('site', effectiveSite);
      if (effectiveClient) qs.set('client', effectiveClient);
      if (effectiveSeverity) qs.set('severity', effectiveSeverity);
      if (effectiveCategory) qs.set('category', effectiveCategory);
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

  const copyPanelContextLink = () => {
    void (async () => {
      const path = recommendationsPath({
        device: effectiveDevice,
        site: effectiveSite,
        client: effectiveClient,
        severity: effectiveSeverity,
        category: effectiveCategory,
      });
      const url = `${window.location.origin}${path}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Panel context link copied', {
          description: path,
          tone: 'success',
        });
      } catch {
        toast('Could not copy link', { description: url, tone: 'warning' });
      }
    })();
  };

  const excluded = excludeCategories && excludeCategories.length > 0 ? excludeCategories : null;
  const scopedRows: ConfigRecommendation[] | null =
    rows === null ? null : excluded ? rows.filter((r) => !excluded.includes(r.category)) : rows;
  const viewRows =
    scopedRows && idsFilterLc
      ? scopedRows.filter((r) => idsFilterLc.includes(r.id.trim().toLowerCase()))
      : (scopedRows ?? []);
  const idsPresent =
    idsFilterLc === null || !rows
      ? 0
      : idsFilterLc.filter((id) => rows.some((r) => r.id.trim().toLowerCase() === id)).length;

  const toggleSelected = (id: string) => {
    setSelectedKeys((prev) => (prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id]));
  };

  const clearIdsFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('ids');
    setSearchParams(next, { replace: true });
    setSelectedKeys([]);
  };

  const scopeFiltersActive = Boolean(
    effectiveDevice || effectiveSite || effectiveClient || effectiveSeverity || effectiveCategory,
  );
  /* Props pin a parent scope (device detail / client drawer) — only URL-owned or
     parent-callback clears are honest empty-filter CTAs (Loop 222). */
  const propsPinScope = Boolean(device || site || clientMac || severity || category);
  const clearUrlScopeFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('device');
    next.delete('site');
    next.delete('client');
    next.delete('severity');
    next.delete('category');
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    setSelectedKeys([]);
  };
  const handleClearScopeFilters = onClearFilters ?? (!propsPinScope ? clearUrlScopeFilters : undefined);

  const recCsvRow = (r: ConfigRecommendation) => [
    r.id,
    r.ruleId,
    r.severity,
    r.category,
    r.title,
    r.detail,
    r.actionType,
    r.evidence,
    r.evidenceNote ?? '',
    r.device ?? '',
    r.site ?? '',
    r.clientMac ?? '',
    r.plane ?? '',
    r.handoffPath ?? '',
    r.impactCount ?? '',
  ];

  const recCsvHeaders = [
    'id',
    'ruleId',
    'severity',
    'category',
    'title',
    'detail',
    'actionType',
    'evidence',
    'evidenceNote',
    'device',
    'site',
    'clientMac',
    'plane',
    'handoffPath',
    'impactCount',
  ];

  return (
    <div className="nt-stack-12 nt-recs-shell nt-section-panel">
      <div className="nt-plane-theater" role="note">HPE Network Tools · recommendation lane · severity owns hue · never auto-applied</div>
      <div className="nt-row-between-8">
        <SectionHeader label={title} meta="READ ONLY · NO AUTO-APPLY" />
        <ActionOverflow label={`${title} actions`}>
          {showCopyLink ? (
            <Button variant="ghost" size="sm" onClick={copyPanelContextLink}>
              Copy panel context link
            </Button>
          ) : null}
          {rows !== null && rows.length > 0 ? (
            <>
              <Button variant="ghost" size="sm" onClick={exportClientCsv}>
                Export CSV
              </Button>
              <Button variant="ghost" size="sm" onClick={exportServerCsv}>
                Download server CSV
              </Button>
            </>
          ) : null}
        </ActionOverflow>
      </div>
      {note ? (
        <div className="nt-fs-12-muted">{note}</div>
      ) : null}
      {error ? (
        <Alert tone="warning" title="Recommendations unavailable">
          <span className="nt-fs-13">{error}</span>
        </Alert>
      ) : null}
      {error ? null : rows === null ? (
        <div
          className="nt-center-pad-16"
          role="status"
          aria-busy="true"
          aria-label="Loading recommendations"
        >
          <div className="nt-stack nt-gap-6">
            <Skeleton height={12} width="40%" />
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        </div>
      ) : scopedRows === null || scopedRows.length === 0 ? (
        <EmptyState
          title={
            scopeFiltersActive
              ? 'No recommendations match these filters'
              : 'No recommendations'
          }
          description={
            scopeFiltersActive
              ? handleClearScopeFilters
                ? 'Clear device / site / client / severity / category filters to widen the hygiene list.'
                : 'This screen pins its own scope. Nothing stood out here — the full hygiene list lives on Recommendations.'
              : 'Nothing stood out from observed inventory state for this scope.'
          }
        >
          {scopeFiltersActive && handleClearScopeFilters ? (
            <Button variant="secondary" size="sm" onClick={handleClearScopeFilters}>
              Clear filters
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <>
          {idsFilterLc !== null ? (
            <div className="nt-chip-row" role="group" aria-label="Selection deep link">
              <button
                type="button"
                onClick={clearIdsFilter}
                title={idsFilter?.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {idsPresent === idsFilterLc.length
                  ? `${idsFilterLc.length} selected recommendation${idsFilterLc.length === 1 ? '' : 's'}`
                  : `${idsPresent} of ${idsFilterLc.length} selected recommendations present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          {viewRows.length === 0 ? (
            <EmptyState
              title="No recommendations match this selection"
              description="Clear the selection filter to restore the full recommendation list for this scope."
            >
              <Button variant="secondary" size="sm" onClick={clearIdsFilter}>
                Clear selection filter
              </Button>
            </EmptyState>
          ) : (
            <ul className="nt-rec-list" aria-label="Configuration recommendations">
              {viewRows.map((rec) => {
                const marked = selectedKeys.includes(rec.id);
                return (
                  <li
                    key={rec.id}
                    className="nt-rec-card nt-card-lift"
                    data-severity={rec.severity}
                    data-tone={SEVERITY_TONE[rec.severity]}
                    data-selected={marked ? 'true' : 'false'}
                  >
                    <div className="nt-row-between-8">
                      <label className="nt-row nt-gap-8 nt-align-start">
                        <input
                          type="checkbox"
                          checked={marked}
                          onChange={() => toggleSelected(rec.id)}
                          aria-label={`Select recommendation ${rec.title}`}
                        />
                        <strong className="nt-fs-13">{rec.title}</strong>
                      </label>
                      <div className="nt-wrap-6">
                        <Badge tone={SEVERITY_TONE[rec.severity]}>{rec.severity}</Badge>
                        <Badge tone="neutral">{rec.category}</Badge>
                      </div>
                    </div>
                    <div className="nt-fs-13-sec">{rec.detail}</div>
                    {rec.evidenceNote ? (
                      <div className="nt-hint-muted">
                        {rec.evidenceNote}
                      </div>
                    ) : null}
                    {rec.handoffPath ? (
                      <div>
                        <Button variant="secondary" size="sm" onClick={() => navigate(rec.handoffPath!)}>
                          Open related screen
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Recommendation selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy ids or titles, or share a selection link for only the suggestions you
                marked — full list export stays in the header · never auto-applies
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = viewRows.filter((r) => selected.has(r.id));
                    if (picked.length === 0) {
                      toast('No selected recommendations still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'config-recommendations-selected.csv',
                      recCsvHeaders,
                      picked.map(recCsvRow),
                    );
                    toast(`Exported ${countOf(n, 'selected recommendation')}`, {
                      description: 'config-recommendations-selected.csv — read-only fields only.',
                      tone: 'success',
                    });
                  }}
                >
                  Export selected
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = viewRows.filter((r) => selected.has(r.id));
                      if (picked.length === 0) {
                        toast('No selected recommendations still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const ids = [...new Set(picked.map((r) => r.id.trim()).filter(Boolean))];
                      if (ids.length === 0) {
                        toast('No ids on the selected recommendations', {
                          description: 'Use Copy titles or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = ids.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(ids.length, 'id')}`, {
                          description: 'newline-joined · paste into a ticket or change window',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy ids', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy IDs
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = viewRows.filter((r) => selected.has(r.id));
                      if (picked.length === 0) {
                        toast('No selected recommendations still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const titles = [
                        ...new Set(
                          picked
                            .map((r) => (r.title ?? '').trim())
                            .filter((title) => title.length > 0 && title !== '—'),
                        ),
                      ];
                      if (titles.length === 0) {
                        toast('No titles on the selected recommendations', {
                          description: 'Those rows did not publish a title — use Copy IDs or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = titles.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(titles.length, 'title')}`, {
                          description:
                            titles.length < picked.length
                              ? `${picked.length - titles.length} selected without a title skipped`
                              : 'newline-joined · paste into a ticket or handoff',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy titles', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy titles
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = viewRows.filter((r) => selected.has(r.id));
                      if (picked.length === 0) {
                        toast('No selected recommendations still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const ids = [...new Set(picked.map((r) => r.id.trim()).filter(Boolean))];
                      if (ids.length === 0) {
                        toast('No ids on the selected recommendations', {
                          description: 'Use Copy titles or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const path = recommendationsPath({
                        device: effectiveDevice,
                        site: effectiveSite,
                        client: effectiveClient,
                        severity: effectiveSeverity,
                        category: effectiveCategory,
                      });
                      const u = new URL(path, window.location.origin);
                      u.searchParams.set('ids', ids.join('\n'));
                      const url = u.toString();
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${ids.length} recommendation${ids.length === 1 ? '' : 's'} · ids=`,
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy link', { description: url, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy selection link
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                  Clear
                </Button>
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
