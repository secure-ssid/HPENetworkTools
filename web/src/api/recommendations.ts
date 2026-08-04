/** Read-only config recommendations + taxonomy summary. */

import type {
  CategoryBucket,
  ConfigRecommendation,
  RecommendationCategory,
  RecommendationSeverity,
} from '@hpe/shared';
import { apiFetch, serverMessage } from './core';

export interface RecommendationsResponse {
  recommendations: ConfigRecommendation[];
  counts: {
    total: number;
    bySeverity: Record<RecommendationSeverity, number>;
    byCategory: Partial<Record<RecommendationCategory, number>>;
  };
  readOnly: true;
  note: string;
}

export interface TaxonomySummaryResponse {
  devices: { total: number; byType: CategoryBucket[] };
  clients: { total: number; byType: CategoryBucket[] };
}

export async function getRecommendations(query: {
  device?: string;
  site?: string;
  client?: string;
  category?: RecommendationCategory;
  severity?: RecommendationSeverity;
  limit?: number;
} = {}): Promise<RecommendationsResponse> {
  const params = new URLSearchParams();
  if (query.device) params.set('device', query.device);
  if (query.site) params.set('site', query.site);
  if (query.client) params.set('client', query.client);
  if (query.category) params.set('category', query.category);
  if (query.severity) params.set('severity', query.severity);
  if (query.limit != null) params.set('limit', String(query.limit));
  const qs = params.toString();
  const r = await apiFetch(`/api/recommendations${qs ? `?${qs}` : ''}`);
  if (!r.ok) throw new Error(await serverMessage(r, 'Could not load recommendations'));
  return r.json() as Promise<RecommendationsResponse>;
}

export async function getTaxonomySummary(): Promise<TaxonomySummaryResponse> {
  const r = await apiFetch('/api/taxonomy/summary');
  if (!r.ok) throw new Error(await serverMessage(r, 'Could not load taxonomy summary'));
  return r.json() as Promise<TaxonomySummaryResponse>;
}
