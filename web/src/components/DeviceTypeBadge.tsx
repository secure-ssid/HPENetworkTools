import { classifyDevice, type DeviceType } from '@hpe/shared';
import { Badge } from '../nightdesk';

export function DeviceTypeBadge({
  type,
  model,
  name,
  showFamily = false,
  showRole = false,
}: {
  type: DeviceType;
  model?: string | null;
  name?: string | null;
  showFamily?: boolean;
  showRole?: boolean;
}) {
  const tax = classifyDevice({ type, model, name });
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <Badge tone={tax.typeTone}>{tax.typeLabel}</Badge>
      {showFamily && tax.family ? <Badge tone="neutral">{tax.family}</Badge> : null}
      {showRole && tax.roleHint ? <Badge tone="info">{tax.roleHint}</Badge> : null}
    </span>
  );
}
