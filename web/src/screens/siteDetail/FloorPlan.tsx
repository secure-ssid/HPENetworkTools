/**
 * web/src/screens/siteDetail/FloorPlan.tsx — the site page's floor-plan
 * section: the site's Mist map image with AP and client dots placed by the
 * plane's own pixel coordinates.
 *
 * Hand-rolled SVG, no chart library: one <image> at the map's intrinsic pixel
 * size (the same field carries Mist's hosted URL live and the demo world's
 * inline SVG data-URI — rendered identically), then nightdesk-token circles
 * at the reported x/y. Labels are hover <title>s — the plane's words
 * (device name, client name + MAC), never re-derived.
 *
 * Honesty rules, matching the rest of the portal:
 *  - `maps` ABSENT  -> the route did not say ("not reported").
 *  - `maps` EMPTY   -> a real answer: no plan is uploaded — say so in words
 *                      (and say WHERE plans come from for a Mist site), never
 *                      draw a fabricated placeholder image.
 *  - a map row with no image URL or no intrinsic dimensions -> nothing drawn,
 *                      and the line says why rather than guessing a size.
 *  - an AP with null x/y is "assigned to the map, position not reported" — it
 *                      draws no dot and is counted under the map, not placed
 *                      at (0,0).
 */

import { Badge, SectionHeader } from '../../nightdesk';
import type { MistSiteMap, MistSiteMapAp, Tone } from '@hpe/shared';
import { countOf } from '@hpe/shared';
import type { SiteMapClientDot } from '../../api/client';

/** Status-dot colours — the same token map the site topology diagram uses. */
const DOT: Partial<Record<Tone, string>> = {
  success: 'var(--nd-success)',
  warning: 'var(--nd-warning)',
  danger: 'var(--nd-danger)',
  neutral: 'var(--nd-border-strong)',
  accent: 'var(--nd-accent)',
  info: 'var(--nd-info, var(--nd-border-strong))',
};

/** One floor plan: image, AP dots, the client dots the roster locates on THIS
 *  map, and the legend line naming what was placed. */
function MapBlock({ map, clients }: { map: MistSiteMap; clients: SiteMapClientDot[] }) {
  const placedAps = map.aps.filter(
    (ap): ap is MistSiteMapAp & { x: number; y: number } => ap.x !== null && ap.y !== null,
  );
  const unplaced = map.aps.length - placedAps.length;
  const located = clients.filter((c) => c.mapId === map.mapId);
  const dims = [
    map.widthM !== null && map.heightM !== null ? `${map.widthM} m × ${map.heightM} m` : null,
    map.widthPx !== null && map.heightPx !== null ? `${map.widthPx}×${map.heightPx} px` : null,
  ]
    .filter((d): d is string => d !== null)
    .join(' · ');

  return (
    <div className="nt-site-section nt-section-panel nt-stack nt-gap-8">
      <div className="nt-row-baseline-wrap">
        <span className="nt-fs-12-pri">
          {map.name ?? 'Unnamed floor plan'}
        </span>
        {dims ? <span className="nt-service-note nt-fs-10">{dims}</span> : null}
      </div>
      {map.imageUrl !== null && map.widthPx !== null && map.heightPx !== null ? (
        <svg
          role="img"
          aria-label={`Floor plan ${map.name ?? map.mapId} with ${countOf(placedAps.length, 'AP')} and ${countOf(located.length, 'client')} located`}
          viewBox={`0 0 ${map.widthPx} ${map.heightPx}`}
          className="nt-floor-img"
        >
          <image href={map.imageUrl} x={0} y={0} width={map.widthPx} height={map.heightPx} />
          {placedAps.map((ap) => (
            <circle
              key={ap.deviceUuid ?? ap.mac ?? ap.deviceName}
              data-dot="ap"
              cx={ap.x}
              cy={ap.y}
              r={16}
              fill="var(--nd-accent)"
              stroke="var(--nd-bg-canvas)"
              strokeWidth={3}
            >
              <title>{ap.deviceName}</title>
            </circle>
          ))}
          {located.map((c) => (
            <circle
              key={c.mac}
              data-dot="client"
              cx={c.x}
              cy={c.y}
              r={9}
              fill={DOT[c.healthTone] ?? 'var(--nd-border-strong)'}
              stroke="var(--nd-bg-canvas)"
              strokeWidth={2}
            >
              <title>{`${c.name} · ${c.mac} · ${c.health}`}</title>
            </circle>
          ))}
        </svg>
      ) : (
        <div className="nt-service-note">
          {map.imageUrl === null
            ? 'This map row carries no image — nothing is drawn rather than a guessed placeholder.'
            : 'This map row reports no image dimensions, so its pixel coordinates cannot be placed — nothing is drawn.'}
        </div>
      )}
      <div className="nt-service-note nt-hint-muted nt-fs-105">
        {placedAps.length > 0
          ? `APs placed: ${placedAps.map((ap) => ap.deviceName).join(' · ')}`
          : 'No AP has a reported position on this map.'}
        {unplaced > 0 ? ` ${countOf(unplaced, 'AP')} assigned to this map without a reported position.` : ''}
        {located.length > 0 ? ` ${countOf(located.length, 'located client')} on the roster.` : ''}
      </div>
    </div>
  );
}

/**
 * The floor-plan section. Always rendered: a site with no map gets the honest
 * empty state (where plans come from, for a Mist-claimed site), never a
 * fabricated placeholder image.
 */
export function SiteFloorPlan({
  maps,
  clients,
  mistClaimed,
}: {
  maps: MistSiteMap[] | undefined;
  clients: SiteMapClientDot[] | undefined;
  mistClaimed: boolean;
}) {
  if (maps === undefined) {
    return (
      <div className="nt-stack nt-gap-10">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">HPE Network Tools · floor plan lane · operator geometry</div>
        <SectionHeader label="Floor plan" meta="NOT REPORTED" />
        <div className="nt-service-note">The portal did not say whether this site has floor plans.</div>
      </div>
    );
  }
  if (maps.length === 0) {
    return (
      <div className="nt-stack nt-gap-10">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">HPE Network Tools · floor plan lane · operator geometry</div>
        <SectionHeader label="Floor plan" meta={mistClaimed ? 'NONE UPLOADED' : 'NOT PUBLISHED'} />
        <div className="nt-service-note">
          {mistClaimed
            ? 'No floor plan uploaded to Mist for this site — floor plans are uploaded in the Mist dashboard.'
            : 'No linked plane publishes a floor plan for this site.'}
        </div>
      </div>
    );
  }
  return (
    <div className="nt-stack nt-gap-14 nt-floor-shell">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">HPE Network Tools · floor plan lane · operator geometry</div>
      <SectionHeader
        label="Floor plan"
        meta={
          <span className="nt-inline-center-8">
            {`${countOf(maps.length, 'map').toUpperCase()} · `}
            <Badge plane>MIST</Badge>
          </span>
        }
      />
      {maps.map((map) => (
        <MapBlock key={map.mapId} map={map} clients={clients ?? []} />
      ))}
    </div>
  );
}
