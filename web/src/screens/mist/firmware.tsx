/**
 * web/src/screens/mist/firmware.tsx — the Mist screen's firmware section:
 * the Mist-claimed devices running BEHIND the recommended train, each
 * linking to its device page.
 *
 * The verdict rule is the Devices screen's own: a row is behind when the
 * plane published a recommended train (`firmwareTarget`), the device is not
 * approved-current (`firmwareApproved` false) and its running train is a
 * reported value at all. The plane's upgrade-state word (`firmwareUpdate`,
 * e.g. 'inprogress') rides verbatim beside it. Rows with no target read are
 * counted as unreported — the section never calls them compliant, and the
 * all-clear sentence only covers the rows the plane actually scored.
 */

import { Link } from 'react-router-dom';
import { Badge, SectionHeader } from '../../nightdesk';
import { countOf } from '@hpe/shared';
import type { DeviceRow } from '@hpe/shared';
import { deviceDetailPath } from '../../app/nav';
import { noteStyle } from './style';

/** The Devices screen's display rule: '—'/'unknown'/'' read "Not reported". */
function reportedFirmware(value: string): boolean {
  const normal = value.trim().toLowerCase();
  return value !== '' && normal !== '—' && normal !== 'unknown';
}

export function FirmwareSection({ devices }: { devices: DeviceRow[] }) {
  const scored = devices.filter((d) => d.firmwareTarget !== undefined);
  const behind = scored.filter((d) => !d.firmwareApproved && reportedFirmware(d.firmware));
  const unreported = devices.length - scored.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader
        label="Firmware"
        meta={
          devices.length === 0
            ? 'NO DEVICES'
            : `${behind.length > 0 ? `${behind.length} BEHIND · ` : ''}${countOf(devices.length, 'DEVICE').toUpperCase()} · MIST`
        }
      />
      {devices.length === 0 ? (
        <div style={noteStyle}>No Mist-claimed devices in the inventory this cycle.</div>
      ) : (
        <>
          {behind.map((d) => (
            <Link
              key={`${d.plane}:${d.serial ?? d.name}`}
              to={deviceDetailPath({ name: d.name, plane: d.plane, serial: d.serial })}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '9px 0',
                borderBottom: '1px solid var(--nd-border-subtle)',
                textDecoration: 'none',
              }}
            >
              <Badge tone="warning">behind → {d.firmwareTarget}</Badge>
              {d.firmwareUpdate ? <Badge tone="neutral">{d.firmwareUpdate}</Badge> : null}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
                  {d.name}
                </span>
                <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)' }}>{d.siteName}</span>
              </span>
              <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', textAlign: 'right' }}>
                running {d.firmware}
              </span>
            </Link>
          ))}
          {behind.length === 0 ? (
            <div style={noteStyle}>
              {scored.length > 0
                ? `Every Mist device with a recommended-train read (${countOf(scored.length, 'device')}) runs it.`
                : 'No Mist device carried a recommended-train read this cycle.'}
            </div>
          ) : null}
          {unreported > 0 ? (
            <div style={{ ...noteStyle, fontSize: 10.5, paddingTop: 6 }}>
              {countOf(unreported, 'device')} carried no recommended-train read — their standing is
              unreported, not compliant.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
