/**
 * Read-only configuration recommendations. Never pushes — only hands off to
 * existing screens (Configure, ClearPass, Systems, device detail).
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ConfigRecommendation, RecommendationSeverity } from '@hpe/shared';
import { getRecommendations } from '../api/recommendations';
import { Alert, Badge, Button, EmptyState, SectionHeader, Spinner } from '../nightdesk';

const SEVERITY_TONE: Record<RecommendationSeverity, 'info' | 'warning' | 'danger' | 'neutral'> = {
  info: 'info',
  suggestion: 'warning',
  warning: 'danger',
};

export function ConfigRecommendationsPanel({
  device,
  site,
  clientMac,
  limit = 12,
  title = 'Recommendations',
  initialRecommendations,
}: {
  device?: string;
  site?: string;
  clientMac?: string;
  limit?: number;
  title?: string;
  /** Test seam */
  initialRecommendations?: ConfigRecommendation[];
}) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ConfigRecommendation[] | null>(initialRecommendations ?? null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (initialRecommendations) return;
    let cancelled = false;
    void (async () => {
      try {
        setError(null);
        const res = await getRecommendations({
          device,
          site,
          client: clientMac,
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
  }, [device, site, clientMac, limit, initialRecommendations]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHeader label={title} meta="READ ONLY · NO AUTO-APPLY" />
      {note ? (
        <div style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>{note}</div>
      ) : null}
      {error ? (
        <Alert tone="warning" title="Recommendations unavailable">
          <span style={{ fontSize: 13 }}>{error}</span>
        </Alert>
      ) : null}
      {rows === null ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}>
          <Spinner size="sm" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No recommendations"
          description="Nothing stood out from observed inventory state for this scope."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((rec) => (
            <li
              key={rec.id}
              style={{
                border: '1px solid var(--nd-border-default)',
                background: 'var(--nd-bg-raised)',
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <strong style={{ fontSize: 13 }}>{rec.title}</strong>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Badge tone={SEVERITY_TONE[rec.severity]}>{rec.severity}</Badge>
                  <Badge tone="neutral">{rec.category}</Badge>
                </div>
              </div>
              <div style={{ fontSize: 13, color: 'var(--nd-text-secondary)' }}>{rec.detail}</div>
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
          ))}
        </ul>
      )}
    </div>
  );
}
