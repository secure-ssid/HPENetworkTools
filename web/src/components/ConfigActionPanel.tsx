/**
 * Capability-gated configuration handoff. Never invents write buttons for
 * products that only support reads — those get an explicit read-only reason.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  configCapabilitiesFor,
  type ConfigActionCapability,
  type VisualTarget,
} from '@hpe/shared';
import { Alert, Badge, Button, SectionHeader } from '../nightdesk';

export function ConfigActionPanel({
  target,
  plane,
  targetKind,
  capability,
  capabilities,
}: {
  target?: VisualTarget;
  plane?: string;
  targetKind?: string;
  /** Single capability (tests). */
  capability?: ConfigActionCapability;
  /** Explicit list; defaults to catalog filter. */
  capabilities?: ConfigActionCapability[];
}) {
  const navigate = useNavigate();
  const [previewed, setPreviewed] = useState<string | null>(null);
  const caps = useMemo(() => {
    if (capability) return [capability];
    if (capabilities) return capabilities;
    return configCapabilitiesFor({ plane, targetKind });
  }, [capability, capabilities, plane, targetKind]);

  if (caps.length === 0) {
    return (
      <div>
        <SectionHeader label="Configuration actions" meta="NONE DECLARED" />
        <Alert tone="info" title="No configuration actions for this object">
          <span style={{ fontSize: 13 }}>
            Only product-supported preview/review/push paths appear here. Use Configure or the product console when a
            write is required outside this portal.
          </span>
        </Alert>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHeader label="Configuration actions" meta="CAPABILITY GATED" />
      {caps.map((cap) => {
        if (cap.readOnlyReason) {
          return (
            <Alert key={cap.id} tone="neutral" title={`${cap.label} — read only`}>
              <span style={{ fontSize: 13 }}>{cap.readOnlyReason}</span>
            </Alert>
          );
        }
        const showReview = previewed === cap.id;
        return (
          <div
            key={cap.id}
            style={{
              border: '1px solid var(--nd-border-default)',
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              background: 'var(--nd-bg-raised)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <strong style={{ fontSize: 13 }}>{cap.label}</strong>
              <div style={{ display: 'flex', gap: 6 }}>
                <Badge tone={cap.tone ?? 'neutral'}>{String(cap.plane)}</Badge>
                {cap.reviewRequired ? <Badge tone="warning">REVIEW</Badge> : null}
                {cap.dryRun ? <Badge tone="info">DRY-RUN</Badge> : null}
              </div>
            </div>
            {target ? (
              <div className="nt-hint-muted">
                {target.kind}:{target.id}
                {target.plane ? ` · ${target.plane}` : ''}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPreviewed(cap.id)}
              >
                Preview change
              </Button>
              {/* Push is never immediate — only after preview/review acknowledgement. */}
              {showReview && !cap.reviewRequired ? (
                <Button variant="primary" size="sm" onClick={() => navigate(cap.handoffPath)}>
                  Continue to apply
                </Button>
              ) : null}
            </div>
            {showReview && cap.reviewRequired ? (
              <Alert tone="warning" title="Review required">
                <span style={{ fontSize: 13 }}>
                  This action uses the existing preview → review → push workflow. The portal will not push from this
                  panel without that gate.
                </span>
                <div style={{ marginTop: 10 }}>
                  <Button variant="primary" size="sm" onClick={() => navigate(cap.handoffPath)}>
                    Open reviewed workflow
                  </Button>
                </div>
              </Alert>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
