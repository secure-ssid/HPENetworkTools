/** Queued and historical changes: their rows, states and tones. */

import { type BrokeredChange } from '../../api/client';
import {
  VLAN_SCOPE_OPTIONS,
  type BrokerAuditEvent,
  type ConfigKind,
  type PortForm,
  type QueuedChangeRow,
  type SsidForm,
  type VlanForm,
} from '@hpe/shared';
import { type CSSProperties } from 'react';

export const MICRO_LINK: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontFamily: 'var(--nd-font-mono)',
  fontSize: 10,
  letterSpacing: '.08em',
  color: 'var(--nd-accent-text)',
  textTransform: 'uppercase',
};

export const ROW: CSSProperties = {
  width: '100%',
  textAlign: 'left',
  background: 'none',
  border: 'none',
  borderBottom: '1px solid var(--nd-border-subtle)',
  borderLeft: '2px solid transparent',
  padding: '12px 10px',
  cursor: 'pointer',
};

/**
 * The broker writes its own outcome word into every audit row ('applied',
 * 'rejected', 'lease-expired', 'render-only (read-only plane)', …). The badge
 * colours the ones whose meaning is unambiguous and leaves everything else
 * neutral — a word this screen does not recognise must not be painted green.
 */
export function auditTone(result: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const r = result.toLowerCase();
  if (r.startsWith('applied')) return 'success';
  if (r === 'rejected' || r.includes('error') || r.includes('failed')) return 'danger';
  if (r === 'lease-expired' || r === 'unverified-path' || r.startsWith('render-only')) return 'warning';
  return 'neutral';
}

/** What the "Change history" drawer is showing right now.
 *  `unreadable` carries the rotated generations the server could not open, so
 *  a partial log is never presented as the whole of what was brokered. */
export type HistoryState =
  | { kind: 'loading' }
  | { kind: 'ok'; events: BrokerAuditEvent[]; unreadable: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'offline' };

/** A queue row: brokered server-side (id set) or local offline fallback (id null).
 *  `expiresAt` is the broker's 15-minute write lease — an entry whose lease has
 *  run out cannot be pushed (the broker answers 409), so the row has to say so. */
export type QueueEntry = QueuedChangeRow & { id: string | null; expiresAt?: string | null };

export const STATE_TONE: Record<QueuedChangeRow['state'], QueuedChangeRow['tone']> = {
  ready: 'success',
  applying: 'info',
  'needs window': 'warning',
  console: 'neutral',
};

/** Server change → display row; the broker's state/what/where are authoritative. */
export function rowForChange(change: BrokeredChange): QueueEntry {
  return {
    id: change.id,
    state: change.state,
    tone: STATE_TONE[change.state],
    what: change.what,
    where: change.where,
    ticket: change.ticket,
    expiresAt: change.expiresAt,
  };
}

/** The "what / where" summary a freshly queued change gets in the list. */
export function queuedEntryFor(
  kind: ConfigKind,
  ssid: SsidForm,
  port: PortForm,
  vlan: VlanForm,
  ticket: string,
): QueueEntry {
  const base = { id: null, state: 'ready' as const, tone: 'success' as const, ticket };
  if (kind === 'ssid') {
    return {
      ...base,
      what: `Update wireless SSID ${ssid.name || '(unnamed)'}`,
      where: `${ssid.plane || 'CENTRAL'} · target group ${ssid.group}`,
    };
  }
  if (kind === 'port') {
    return {
      ...base,
      what: `Port ${port.id} on ${port.device} — ${port.desc || 'no description'}`,
      where: `${port.device} · local collector, recorded session`,
    };
  }
  const scopeLabel =
    VLAN_SCOPE_OPTIONS.find((o) => o.value === vlan.scope)?.label ?? vlan.scope.toUpperCase();
  return {
    ...base,
    what: `VLAN ${vlan.id}${vlan.name ? ` ${vlan.name}` : ''}`,
    where: `${scopeLabel} · local collector`,
  };
}
