import { classifyClient, type ClientType, type EndpointRow } from '@hpe/shared';
import { Badge } from '../nightdesk';

export function ClientCategoryBadges({
  type,
  model,
  os,
  endpoint,
  compact = false,
}: {
  type: ClientType;
  model?: string | null;
  os?: string | null;
  endpoint?: Pick<EndpointRow, 'category' | 'family' | 'os' | 'insightTags'> | null;
  compact?: boolean;
}) {
  const tax = classifyClient({ type, model, os }, endpoint ?? null);
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <Badge tone={tax.typeTone}>{tax.effectiveCategory}</Badge>
      {!compact && tax.osFamily ? <Badge tone="neutral">{tax.osFamily}</Badge> : null}
      {!compact && tax.categoryConfidence === 'profiled' ? <Badge tone="success">PROFILED</Badge> : null}
      {!compact && tax.categoryConfidence === 'unknown' ? <Badge tone="warning">UNCATEGORIZED</Badge> : null}
      {!compact && type !== 'unknown' && tax.effectiveCategory !== tax.typeLabel ? (
        <Badge tone="info">{tax.typeLabel}</Badge>
      ) : null}
    </span>
  );
}
