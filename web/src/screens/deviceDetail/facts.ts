/**
 * Device detail: what was actually read, and how to word what was not.
 *
 * sectionsToRender and detailGapSentence carry the rule this screen exists to
 * respect. A detail section can be absent for three different reasons — never
 * asked, asked and genuinely empty, asked and failed — and they are worded
 * differently because an operator acts on them differently. Nothing here
 * defaults a missing section to an empty one.
 */

import { type DeviceDetailData } from '../../api/client';
import {
  detailState,
  type DetailFetchState,
  type DeviceDetailLive,
  type DeviceDetailSection,
  type DevicePort,
  type DeviceType,
  type Tone,
} from '@hpe/shared';

export type CfgTab = 'running' | 'diff' | 'history';

export const CFG_TABS = [
  { value: 'running', label: 'Running' },
  { value: 'diff', label: 'Drift vs. baseline' },
  { value: 'history', label: 'History' },
];

/** Envelope freshness stamp, same format the other live screens use. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Class blocks — the per-object subresources that actually apply to a device
//
// Central models an AP as radios + broadcast WLANs and a switch as interfaces;
// the flat inventory list carries none of it, so these panels read the route's
// on-demand detail payload (`detail` on the envelope) rather than the poller
// snapshot. Which panels exist is decided by the device CLASS: an access point
// has no ports, so it must not be handed a ports panel that then blames a plane
// for "not reporting" something the device does not have.
// ---------------------------------------------------------------------------

/**
 * The per-device detail read the route attaches to the envelope.
 *
 * OPTIONAL by contract, and this screen must stay renderable without it: the
 * detail read is made on the DETAIL REQUEST PATH for the one device being
 * viewed, not on the 60s poll, so an envelope that predates it, a plane with
 * no detail support, and a read that timed out all arrive here as `undefined`.
 * Every panel below degrades to its own honest sentence; nothing fabricates.
 */
export function servedDeviceDetail(data: DeviceDetailData): DeviceDetailLive | null {
  return data.detail ?? null;
}

/** Display order of the class blocks, whichever set a device ends up with. */
export const DETAIL_SECTION_ORDER: DeviceDetailSection[] = ['radios', 'wlans', 'ports'];

/**
 * Which subresources a device CLASS has at all.
 *
 * An AP has radios and WLANs and no ports; a switch has ports and no radios.
 * A gateway (and anything else) gets no class block by default — Central does
 * not serve gateway interfaces through the switch endpoint, so the panels for
 * those classes are payload-driven only: whatever the route actually read.
 */
export function classSections(type: DeviceType | undefined): DeviceDetailSection[] {
  if (type === 'ap') return ['radios', 'wlans'];
  if (type === 'switch') return ['ports'];
  return [];
}

/**
 * The blocks to render for this device: the ones its class has, plus any the
 * route actually attempted (so a gateway that DOES come back with interfaces
 * one day renders them without another change here).
 */
export function sectionsToRender(
  type: DeviceType | undefined,
  detail: DeviceDetailLive | null,
): DeviceDetailSection[] {
  const byClass = classSections(type);
  return DETAIL_SECTION_ORDER.filter(
    (s) => byClass.includes(s) || detailState(detail?.source, s) !== 'not-fetched',
  );
}

/**
 * The one sentence a class block with no rows may print.
 *
 * The four outcomes are four DIFFERENT statements and the README's honesty
 * rules turn on the difference: a section we never asked for must not be
 * reported as the plane withholding it, and a section the plane answered with
 * nothing is not an error.
 */
export function detailGapSentence(
  state: DetailFetchState,
  copy: { notFetched: string; empty: string; failed: string },
  note?: string | null,
): string {
  if (state === 'failed') return note ? `${copy.failed} — ${note}` : copy.failed;
  if (state === 'not-fetched') return copy.notFetched;
  // 'empty' — and 'ok' that carried no rows — say the same thing: the read
  // happened and the plane had nothing to give. That is not an error.
  return copy.empty;
}

/** `23` → `23%`; a value the plane omitted contributes no segment at all. */
export function pctText(v: number | null | undefined, label: string): string | null {
  return v == null ? null : `${label} ${v}%`;
}

/** Bits per second as an engineer writes it: 1000000000 → `1 Gb`. */
export function speedText(bps: number | null | undefined): string | null {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return null;
  if (bps >= 1e9) {
    const gb = bps / 1e9;
    return `${Number.isInteger(gb) ? gb : Number(gb.toFixed(1))} Gb`;
  }
  if (bps >= 1e6) {
    const mb = bps / 1e6;
    return `${Number.isInteger(mb) ? mb : Number(mb.toFixed(1))} Mb`;
  }
  return `${bps} b`;
}

/** Segments joined with the mono middot the rest of the screen uses. */
export function joinFacts(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(' · ');
}

/** `UP` / `DOWN` / anything else, as the plane worded it. */
export function statusTone(status: string | undefined): Tone {
  const s = (status ?? '').trim().toLowerCase();
  if (s === 'up' || s === 'enabled' || s === 'connected') return 'success';
  if (s === 'down' || s === 'disabled') return 'danger';
  return 'neutral';
}

/** Central's own health words on a link ('Good' | 'Fair' | 'Poor'). A poor far
 *  end is the correlation this screen exists for, so it is not muted. */
export function healthTone(health: string | undefined): Tone {
  const h = (health ?? '').trim().toLowerCase();
  if (h === 'good') return 'success';
  if (h === 'fair') return 'warning';
  if (h === 'poor' || h === 'bad' || h === 'critical') return 'danger';
  return 'neutral';
}

/** Radios lowest band first — Central numbers them 1/0/2 for 2.4/5/6 GHz, and
 *  nobody reads a radio list in that order. */
export function bandRank(band: string | undefined): number {
  const n = Number.parseFloat(band ?? '');
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** Is this port carrying anything? `operStatus` when the plane sent one, the
 *  rolled-up status word otherwise ('Not Connected' must not match). */
export function portIsUp(p: DevicePort): boolean {
  const oper = (p.operStatus ?? '').trim().toLowerCase();
  if (oper === 'up' || oper === 'down') return oper === 'up';
  return /^connected$/i.test((p.status ?? '').trim());
}

/** Is this display name just the MAC the row already carries? */
export function sameMac(name: string, mac?: string | null): boolean {
  if (!mac) return false;
  const strip = (v: string) => v.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return strip(name) === strip(mac) && strip(mac).length === 12;
}
