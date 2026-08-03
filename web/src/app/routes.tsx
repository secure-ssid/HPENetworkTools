/**
 * web/src/app/routes.tsx — react-router v6 routes inside the shell layout.
 * The URL carries view + entity (/sites/:siteId, /devices/:name); / redirects
 * to /overview. The /ds design gallery keeps its own shell, so it stays a
 * standalone route outside the app shell.
 *
 * Every screen is a lazy chunk: the shell stays eager, and the Suspense
 * boundary around <Outlet /> in AppShell keeps the sidebar and topbar on
 * screen while a screen's chunk loads. /ds sits outside that boundary, so
 * it carries its own.
 */

import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShellLayout, RouteFallback } from './AppShell';

const Overview = lazy(() => import('../screens/Overview'));
const Topology = lazy(() => import('../screens/Topology'));
const Alerts = lazy(() => import('../screens/Alerts'));
const Tickets = lazy(() => import('../screens/Tickets'));
const Clients = lazy(() => import('../screens/Clients'));
const AuthEvents = lazy(() => import('../screens/AuthEvents'));
const ClearPass = lazy(() => import('../screens/ClearPass'));
const Central = lazy(() => import('../screens/Central'));
const Mist = lazy(() => import('../screens/Mist'));
const Inventory = lazy(() => import('../screens/Inventory'));
const Sites = lazy(() => import('../screens/Sites'));
const SiteDetail = lazy(() => import('../screens/SiteDetail'));
const Devices = lazy(() => import('../screens/Devices'));
const DeviceDetail = lazy(() => import('../screens/DeviceDetail'));
const Licenses = lazy(() => import('../screens/Licenses'));
const GreenLake = lazy(() => import('../screens/GreenLake'));
const Configure = lazy(() => import('../screens/Configure'));
const Compliance = lazy(() => import('../screens/Compliance'));
const Systems = lazy(() => import('../screens/Systems'));
const Uxi = lazy(() => import('../screens/Uxi'));
const DsGallery = lazy(() =>
  import('../screens/DsGallery').then((module) => ({ default: module.DsGallery })),
);

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShellLayout />}>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/topology" element={<Topology />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/tickets" element={<Tickets />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/auth-events" element={<AuthEvents />} />
        <Route path="/clearpass" element={<ClearPass />} />
        <Route path="/central" element={<Central />} />
        <Route path="/mist" element={<Mist />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/sites" element={<Sites />} />
        <Route path="/sites/:siteId" element={<SiteDetail />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/devices/:name" element={<DeviceDetail />} />
        <Route path="/licenses" element={<Licenses />} />
        <Route path="/greenlake" element={<GreenLake />} />
        <Route path="/configure" element={<Configure />} />
        <Route path="/compliance" element={<Compliance />} />
        <Route path="/systems" element={<Systems />} />
        <Route path="/uxi" element={<Uxi />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
      <Route
        path="/ds"
        element={
          <Suspense fallback={<RouteFallback />}>
            <DsGallery />
          </Suspense>
        }
      />
    </Routes>
  );
}
