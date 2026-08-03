/**
 * Floor-plan section tests: the demo map renders its image and dots at the
 * plane's own pixel coordinates, and every no-map outcome is an honest
 * sentence rather than a fabricated placeholder image.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SiteFloorPlan } from './FloorPlan';
import { MIST_SITE_MAPS } from '@hpe/shared';
import type { MistSiteMap } from '@hpe/shared';
import type { SiteMapClientDot } from '../../api/client';

const DEMO_MAP = MIST_SITE_MAPS[0]!; // campus-02, 'Tower B · 3rd floor — east labs'

const CLIENT_DOTS: SiteMapClientDot[] = [
  { name: 'm.okonjo', mac: '3c:22:fb:41:0a:19', x: 362, y: 268, mapId: 'map-cam02-3f', health: 'good', healthTone: 'success' },
  { name: 's.mehta', mac: 'de:ad:0b:14:65:22', x: 414, y: 296, mapId: 'map-cam02-3f', health: 'sticky client', healthTone: 'warning' },
  // Located, but on a DIFFERENT map — must not draw on this one.
  { name: 'elsewhere', mac: '00:11:22:33:44:55', x: 10, y: 10, mapId: 'map-other', health: 'good', healthTone: 'success' },
];

afterEach(cleanup);

describe('SiteFloorPlan', () => {
  it('renders the demo map image at intrinsic size with AP and client dots in bounds', () => {
    const { container } = render(
      <SiteFloorPlan maps={[DEMO_MAP]} clients={CLIENT_DOTS} mistClaimed />,
    );
    const svg = container.querySelector('svg[role="img"]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 1200 800');

    const image = container.querySelector('image');
    expect(image?.getAttribute('href')).toContain('data:image/svg+xml');
    expect(image?.getAttribute('width')).toBe('1200');
    expect(image?.getAttribute('height')).toBe('800');

    // Both authored APs draw at the plane's own pixels, inside the image.
    const apDots = [...container.querySelectorAll('circle[data-dot="ap"]')];
    expect(apDots).toHaveLength(2);
    const xy = apDots.map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]);
    expect(xy).toContainEqual([320, 240]);
    expect(xy).toContainEqual([880, 560]);
    for (const [x, y] of xy) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1200);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(800);
    }
    // Hover labels are the plane's own names.
    expect(screen.getByText('ap-3f-12').tagName).toBe('title');
    expect(screen.getByText('ap-3f-14').tagName).toBe('title');

    // Only the two clients located on THIS map draw; the other map's dot stays off.
    const clientDots = [...container.querySelectorAll('circle[data-dot="client"]')];
    expect(clientDots).toHaveLength(2);
    expect(screen.getByText('s.mehta · de:ad:0b:14:65:22 · sticky client').tagName).toBe('title');
    expect(screen.queryByText(/elsewhere/)).toBeNull();
  });

  it('names the placed APs under the map and reports an unplaced AP instead of dotting (0,0)', () => {
    const withUnplaced: MistSiteMap = {
      ...DEMO_MAP,
      aps: [...DEMO_MAP.aps, { deviceName: 'ap-unplaced', deviceUuid: null, mac: null, x: null, y: null }],
    };
    const { container } = render(
      <SiteFloorPlan maps={[withUnplaced]} clients={[]} mistClaimed />,
    );
    expect(container.querySelectorAll('circle[data-dot="ap"]')).toHaveLength(2);
    expect(screen.getByText(/APs placed: ap-3f-12 · ap-3f-14/)).toBeTruthy();
    expect(screen.getByText(/1 AP assigned to this map without a reported position/)).toBeTruthy();
  });

  it('a Mist site with no map says where plans come from — no placeholder image', () => {
    const { container } = render(<SiteFloorPlan maps={[]} clients={[]} mistClaimed />);
    expect(
      screen.getByText(
        'No floor plan uploaded to Mist for this site — floor plans are uploaded in the Mist dashboard.',
      ),
    ).toBeTruthy();
    expect(container.querySelector('image')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('a site no Mist badge claims says no plane publishes floor plans', () => {
    render(<SiteFloorPlan maps={[]} clients={[]} mistClaimed={false} />);
    expect(screen.getByText('No linked plane publishes a floor plan for this site.')).toBeTruthy();
  });

  it('an absent maps key is "not reported", not an empty estate', () => {
    render(<SiteFloorPlan maps={undefined} clients={undefined} mistClaimed />);
    expect(screen.getByText('The portal did not say whether this site has floor plans.')).toBeTruthy();
  });

  it('a map row without an image draws nothing and says why', () => {
    const noImage: MistSiteMap = { ...DEMO_MAP, imageUrl: null };
    const { container } = render(<SiteFloorPlan maps={[noImage]} clients={[]} mistClaimed />);
    expect(screen.getByText(/carries no image/)).toBeTruthy();
    expect(container.querySelector('image')).toBeNull();
  });
});
