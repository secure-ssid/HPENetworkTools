/**
 * web/src/app/routes.tsx — react-router v6 routes inside the shell layout.
 * The URL carries view + entity (/sites/:siteId, /devices/:name); / redirects
 * to /overview. The /ds design gallery keeps its own shell, so it stays a
 * standalone route outside the app shell.
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShellLayout } from './AppShell';
import Overview from '../screens/Overview';
import Alerts from '../screens/Alerts';
import Tickets from '../screens/Tickets';
import Clients from '../screens/Clients';
import AuthEvents from '../screens/AuthEvents';
import ClearPass from '../screens/ClearPass';
import Inventory from '../screens/Inventory';
import Sites from '../screens/Sites';
import SiteDetail from '../screens/SiteDetail';
import Devices from '../screens/Devices';
import DeviceDetail from '../screens/DeviceDetail';
import Licenses from '../screens/Licenses';
import GreenLake from '../screens/GreenLake';
import Configure from '../screens/Configure';
import Compliance from '../screens/Compliance';
import Systems from '../screens/Systems';
import Uxi from '../screens/Uxi';
import { DsGallery } from '../screens/DsGallery';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShellLayout />}>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/tickets" element={<Tickets />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/auth-events" element={<AuthEvents />} />
        <Route path="/clearpass" element={<ClearPass />} />
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
      <Route path="/ds" element={<DsGallery />} />
    </Routes>
  );
}
