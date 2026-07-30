/**
 * One glyph per navigation destination.
 *
 * These exist for the collapsed sidebar rail, where the icon is the only thing
 * shown. They are deliberately a single stroked path set on a 16px grid with
 * `currentColor` so the active/hover colours of `.nd-navitem` apply without
 * per-icon styling, and they carry no text of their own — the accessible name
 * lives on the button.
 */
import type { ReactNode } from 'react';
import type { View } from '../../../shared';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const NAV_ICONS: Partial<Record<View, ReactNode>> = {
  overview: (
    <Svg>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </Svg>
  ),
  alerts: (
    <Svg>
      <path d="M8 2 1.5 13.5h13L8 2Z" />
      <path d="M8 6.5v3" />
      <path d="M8 11.5h.01" />
    </Svg>
  ),
  tickets: (
    <Svg>
      <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h9A1.5 1.5 0 0 1 14 5.5V7a1.5 1.5 0 0 0 0 2v1.5A1.5 1.5 0 0 1 12.5 12h-9A1.5 1.5 0 0 1 2 10.5V9a1.5 1.5 0 0 0 0-2V5.5Z" />
      <path d="M9.5 4v8" />
    </Svg>
  ),
  clients: (
    <Svg>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13.5c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5" />
      <path d="M11 3.5a2.3 2.3 0 0 1 0 4.4" />
      <path d="M12.5 13.5c0-1.5-.6-2.5-1.7-3.1" />
    </Svg>
  ),
  auth: (
    <Svg>
      <rect x="2.5" y="7" width="11" height="7" rx="1.5" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
      <path d="M8 10v1.5" />
    </Svg>
  ),
  inventory: (
    <Svg>
      <path d="M2.5 3.5h4" />
      <path d="M6.5 3.5v9h3" />
      <path d="M6.5 8h3" />
      <circle cx="11" cy="3.5" r="1.6" />
      <circle cx="11" cy="8" r="1.6" />
      <circle cx="11" cy="12.5" r="1.6" />
    </Svg>
  ),
  sites: (
    <Svg>
      <path d="M2 13.5V6.5L8 2.5l6 4v7" />
      <path d="M6.5 13.5v-4h3v4" />
      <path d="M1.5 13.5h13" />
    </Svg>
  ),
  devices: (
    <Svg>
      <rect x="1.5" y="3" width="13" height="4" rx="1" />
      <rect x="1.5" y="9" width="13" height="4" rx="1" />
      <path d="M4 5h.01" />
      <path d="M4 11h.01" />
    </Svg>
  ),
  licenses: (
    <Svg>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M4.5 6h7" />
      <path d="M4.5 8.5h7" />
      <path d="M4.5 11h4" />
    </Svg>
  ),
  configure: (
    <Svg>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4" />
    </Svg>
  ),
  compliance: (
    <Svg>
      <path d="M8 1.8 13.5 4v4.2c0 3-2.3 5.2-5.5 6-3.2-.8-5.5-3-5.5-6V4L8 1.8Z" />
      <path d="m5.8 8 1.6 1.6L10.3 6.7" />
    </Svg>
  ),
  systems: (
    <Svg>
      <circle cx="8" cy="3.5" r="1.8" />
      <circle cx="3.5" cy="12.5" r="1.8" />
      <circle cx="12.5" cy="12.5" r="1.8" />
      <path d="M8 5.3v2.4M8 7.7 4.5 11M8 7.7 11.5 11" />
    </Svg>
  ),
};
