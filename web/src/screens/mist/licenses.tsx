/**
 * web/src/screens/mist/licenses.tsx — the Mist screen's licence usage table:
 * per-site consumption as /orgs/{org}/licenses/usages reports it, the one
 * plane that publishes the read.
 *
 * The honesty rules are the Licenses screen's own (it renders the same
 * dataset): null means Mist reported NOTHING this cycle — not linked, or
 * the read failed — and is worded "not reported", never zero consumption;
 * an explicit 0 inside a service map is a real count and renders as one;
 * a service named only by the fully-loaded demand map renders its
 * consumption as '—', because the row did not state it.
 */

import { SectionHeader } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { MistLicenseUsageRow } from '@hpe/shared';
import { noteStyle } from './style';

/* The two counts a usage row may carry, each omitted when the row did not
   carry it — '0 devices' would be a claim Mist never made. */
function devicePart(row: MistLicenseUsageRow): string {
  const parts = [
    row.numDevices !== null ? countOf(row.numDevices, 'device') : null,
    row.numAps !== null ? countOf(row.numAps, 'AP') : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : 'device counts not reported';
}

/* One site's per-service consumption against its fully-loaded demand
   ('SUB-SW 22 / 24') — used / demand, '—' when the row did not state a
   consumption for a service the demand map names. */
function servicePart(row: MistLicenseUsageRow): string {
  if (row.usages === null) return 'consumption not reported';
  const usages = row.usages;
  const services = [...new Set([...Object.keys(usages), ...Object.keys(row.fullyLoaded ?? {})])];
  return services
    .map((service) => {
      const used = usages[service];
      const demand = row.fullyLoaded?.[service];
      const usedText = typeof used === 'number' ? String(used) : '—';
      return typeof demand === 'number' ? `${service} ${usedText} / ${demand}` : `${service} ${usedText}`;
    })
    .join(' · ');
}

export function LicenseUsageSection({ licenseUsages }: { licenseUsages: MistLicenseUsageRow[] | null | undefined }) {
  const meta =
    licenseUsages == null
      ? 'NOT REPORTED'
      : licenseUsages.length === 0
        ? 'NO SITES'
        : `${countOf(licenseUsages.length, 'SITE').toUpperCase()} · USED / FULLY-LOADED · MIST`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader label="Licence usage per site" meta={meta} />
      {licenseUsages == null ? (
        <div style={noteStyle}>
          Mist reported no licence usage this cycle — the plane is not linked, or the usages read
          failed. Absent is not zero consumption.
        </div>
      ) : licenseUsages.length === 0 ? (
        <div style={noteStyle}>
          Mist answered the usages read with no per-site rows — a real answer, not a failed read.
        </div>
      ) : (
        licenseUsages.map((row) => (
          <div
            key={row.siteId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '9px 0',
              borderBottom: '1px solid var(--nd-border-subtle)',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
                {row.siteName}
              </span>
              <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)' }}>{devicePart(row)}</span>
            </span>
            <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', textAlign: 'right' }}>{servicePart(row)}</span>
          </div>
        ))
      )}
    </div>
  );
}
