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
  const seen = new Set([tax.typeLabel.trim().toLowerCase()]);
  const once = (label: string | null | undefined) => {
    const key = label?.trim().toLowerCase();
    if (!key || seen.has(key)) return null;
    seen.add(key);
    return label;
  };
  const family = showFamily ? once(tax.family) : null;
  const role = showRole ? once(tax.roleHint) : null;
  return (
    <span className="nt-badge-row">
      <Badge tone={tax.typeTone}>{tax.typeLabel}</Badge>
      {family ? <Badge tone="neutral">{family}</Badge> : null}
      {role ? <Badge tone="info">{role}</Badge> : null}
    </span>
  );
}
