/**
 * server/src/routes/screens.ts — read-only per-screen view-model endpoints.
 *
 * Every response is an envelope: { dataSource: 'demo'|'live', syncedAt, ...payload }.
 *
 * Demo mode (settings.demoMode, default on): payloads are assembled from the
 * shared fixtures, matching the per-screen view-model shapes in shared/types.ts.
 *
 * Live mode: device payloads are reconciled across planes (services/reconcile.ts
 * — one row per physical device, claimedBy, double-claim/unclaimed flags);
 * sites merge per-plane rows by SiteId (union of managed-by badges, counts and
 * health derived from the reconciled inventory); alerts merge sorted by
 * severity then age; licences and auth events compute their stats, renewals,
 * fail reasons and policy services from the GreenLake/ClearPass rows' metric
 * hints. Datasets no plane reports stay honestly empty.
 *
 * Domain handlers live under screens/*.ts and register onto screensRouter.
 * This file is the mount order only — static paths before param routes.
 */

import { Router } from 'express';

import { registerAlertsRoutes } from './screens/alertsScreen';
import { registerTicketsRoutes } from './screens/ticketsScreen';
import { registerLicensesRoutes } from './screens/licensesScreen';
import { registerComplianceRoutes } from './screens/complianceScreen';
import { registerAuthEventsRoutes } from './screens/authEventsScreen';
import { registerUxiRoutes } from './screens/uxiScreen';
import { registerClientsRoutes } from './screens/clientsScreen';
import { registerDevicesRoutes } from './screens/devicesScreen';
import { registerSitesRoutes } from './screens/sitesScreen';
import { registerSiteDetailRoutes } from './screens/siteDetailScreen';
import { registerMistRoutes } from './screens/mistScreen';
import { registerCentralRoutes } from './screens/centralScreen';
import { registerTopologyRoutes } from './screens/topologyScreen';
import { registerClearPassRoutes } from './screens/clearpassScreen';
import { registerConfigureScreenRoutes } from './screens/configureScreen';
import { registerSearchRoutes } from './screens/searchScreen';
import { registerOverviewRoutes } from './screens/overviewScreen';
import { registerSystemsRoutes } from './screens/systemsScreen';

// Re-exported: resetDetailCache belongs to the detail cache, but tests reach
// for it through this module because that is the router they mount.
export { resetDetailCache } from './screens/detailCache';

export const screensRouter = Router();

// Overview + systems static paths (export before any future /overview/:param).
registerOverviewRoutes(screensRouter);
registerSystemsRoutes(screensRouter);
// Alerts list/export/timeline (static export before :fingerprint; timeline/export before timeline).
registerAlertsRoutes(screensRouter);
registerTicketsRoutes(screensRouter);
registerLicensesRoutes(screensRouter);
registerComplianceRoutes(screensRouter);
registerAuthEventsRoutes(screensRouter);
registerUxiRoutes(screensRouter);
// Clients list/export/:mac (export before :mac; order matters).
registerClientsRoutes(screensRouter);
// Sites list/export before /sites/:siteId (order matters).
registerSitesRoutes(screensRouter);
// Site detail + SLE + applications (param routes after static list/export).
registerSiteDetailRoutes(screensRouter);
// Devices list/export/bulk/detail/trends (export+bulk+list before :name).
registerDevicesRoutes(screensRouter);
// Mist dashboard/export/audit-log (export before any future /mist/:param).
registerMistRoutes(screensRouter);
// Central dashboard + export (export before GET /central / future :param).
registerCentralRoutes(screensRouter);
// Estate topology list + CSV export (export before any future /topology/:param).
registerTopologyRoutes(screensRouter);
// ClearPass list/export/endpoints before /clearpass/services/:id (order matters).
registerClearPassRoutes(screensRouter);
// Configure screen envelope (broker history/export stays on routes/configure.ts).
registerConfigureScreenRoutes(screensRouter);
// Global command-palette search index.
registerSearchRoutes(screensRouter);

// Domain map (handlers live in screens/*):
//   overviewScreen, systemsScreen, alertsScreen, ticketsScreen, licensesScreen,
//   complianceScreen, authEventsScreen, uxiScreen, clientsScreen, sitesScreen,
//   siteDetailScreen (/sites/:siteId, /sle/:metric, /applications[+export]),
//   devicesScreen (/devices list/export/bulk/:name/trends), mistScreen,
//   centralScreen, topologyScreen, clearpassScreen, configureScreen, searchScreen.
