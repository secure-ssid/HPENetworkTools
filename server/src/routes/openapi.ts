/**
 * server/src/routes/openapi.ts — machine-readable route catalog stub.
 *
 * Not a full OpenAPI generator. Documents the high-traffic and newly added
 * contracts so operators and agents can discover them without reading source.
 */

import { Router } from 'express';
import { h } from './handler';

export const openapiRouter = Router();

const SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'HPE Network Tools API',
    version: '0.2.0',
    description:
      'Operator portal API. Authenticated JSON is Cache-Control: private, no-cache. Recommendations never auto-apply configuration.',
  },
  paths: {
    '/api/health': {
      get: {
        summary: 'Process health and plane freshness',
        parameters: [
          {
            name: 'deep',
            in: 'query',
            description:
              'When 1/true and the caller is an authenticated operator (not OIDC stranger), include process/notifier facts. Never secrets or bodies. Strangers get deepWithheld:true.',
            schema: { type: 'string', enum: ['1', 'true'] },
          },
        ],
        responses: {
          '200': {
            description:
              'OK. Optional deep block or deepWithheld when deep requested but not allowed.',
          },
        },
      },
    },
    '/api/devices': {
      get: {
        summary: 'Unified device inventory (optional page + q/plane/type/site/state/issues filters)',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'Optional page size (max 500). Omit for full list.',
            schema: { type: 'integer' },
          },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter across identity fields' },
          {
            name: 'plane',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated plane labels (OR); also matches claimedBy',
          },
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Exact device type (case-insensitive)' },
          {
            name: 'site',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated siteId or siteName values (OR)',
          },
          {
            name: 'state',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated device state values (OR)',
          },
          {
            name: 'issues',
            in: 'query',
            schema: { type: 'string', enum: ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'] },
            description:
              'queryFlag: 1/true/yes/on = reconciliationIssue only; 0/false/no/off = clean only',
          },
        ],
        responses: {
          '200': { description: 'Envelope with devices[]; optional page {total,limit,cursor,nextCursor}' },
          '304': { description: 'Not modified (If-None-Match)' },
        },
      },
    },
    '/api/clients/export': {
      get: {
        summary:
          'CSV export of client sessions (optional q/plane/medium/type/site/group/health/problems filters)',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter across identity fields' },
          { name: 'plane', in: 'query', schema: { type: 'string' }, description: 'Plane label (also sources)' },
          {
            name: 'medium',
            in: 'query',
            schema: { type: 'string', enum: ['wired', 'wireless'] },
            description: 'Exact medium',
          },
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Exact client type' },
          { name: 'site', in: 'query', schema: { type: 'string' }, description: 'Exact siteName (case-insensitive)' },
          { name: 'group', in: 'query', schema: { type: 'string' }, description: 'Exact group (case-insensitive)' },
          {
            name: 'health',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Exact health word (case-insensitive; e.g. good, weak signal, roaming, unverified). Empty/unknown → no-op / empty match.',
          },
          {
            name: 'problems',
            in: 'query',
            schema: { type: 'string', enum: ['1', 'true'] },
            description: 'When set, only problem rows',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/sites/export': {
      get: {
        summary: 'CSV export of sites (optional q/plane/health filters)',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter' },
          { name: 'plane', in: 'query', schema: { type: 'string' }, description: 'Plane badge name on sites.planes[]' },
          {
            name: 'health',
            in: 'query',
            schema: { type: 'string', enum: ['ok', 'warn', 'bad', 'stale'] },
            description: 'SiteHealthTone filter (row tone)',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/devices/export': {
      get: {
        summary:
          'CSV export of device inventory (optional q/plane/type/site/state/issues filters). Authoritative portal inventory CSV for Devices and Inventory explorer — there is no separate inventory export route.',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter' },
          {
            name: 'plane',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated plane labels (OR); also matches claimedBy',
          },
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Exact device type (case-insensitive)' },
          {
            name: 'site',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated siteId or siteName values (OR)',
          },
          {
            name: 'state',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated device state values (OR)',
          },
          {
            name: 'issues',
            in: 'query',
            schema: { type: 'string', enum: ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'] },
            description:
              'queryFlag: 1/true/yes/on = reconciliationIssue only; 0/false/no/off = clean only',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/inventory/tree': {
      get: {
        summary: 'Lazy inventory hierarchy page (systems → sites/devices/SSE); not a full-estate dump',
        parameters: [
          { name: 'parent', in: 'query', schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'InventoryTreePage { nodes, nextCursor, … }' } },
      },
    },
    '/api/inventory/search': {
      get: {
        summary: 'Cross-plane inventory search (paged). CSV of loaded hits is client-side; full device CSV via /api/devices/export',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'InventorySearchPage' } },
      },
    },
    '/api/inventory/node': {
      get: {
        summary: 'Single inventory tree node by id',
        parameters: [
          { name: 'id', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'InventoryTreeNode' },
          '404': { description: 'Unknown node' },
        },
      },
    },
    '/api/mist': {
      get: {
        summary:
          'Mist operational dashboard envelope (SLE, rogues, AP stats, WLANs, licenses, claimed devices; no secrets)',
        responses: { '200': { description: 'Envelope with plane, sleBySiteId, rogues, apStats, wlans, devices, …' } },
      },
    },
    '/api/mist/export': {
      get: {
        summary:
          'CSV of Mist dashboard slices (part=devices|rogues|ap-stats|sle|wlans|licenses; default devices; no secrets/PSKs)',
        parameters: [
          {
            name: 'part',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['devices', 'rogues', 'ap-stats', 'sle', 'wlans', 'licenses'],
            },
            description:
              'Export slice (default devices). wlans = SSID inventory (no PSKs); licenses = per-site usage tallies.',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'part=wlans: substring on name/vlan/security/targets/plane/note',
          },
          {
            name: 'enabled',
            in: 'query',
            schema: { type: 'string', enum: ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'] },
            description:
              'part=wlans: enabled flag filter (queryFlag vocabulary). Rows with undefined enabled never match.',
          },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: 'Invalid part' },
        },
      },
    },
    '/api/mist/audit-log/export': {
      get: {
        summary:
          'CSV of Mist org audit-log entries (id/at/admin/message/site/before/after; portal-redacted; no secrets)',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100 },
            description: 'Max entries (default 25)',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/systems/mist/audit-log': {
      get: {
        summary:
          'On-demand Mist org audit log JSON (portal-redacted before/after; limit 1–100; null when plane unlinked)',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100 },
            description: 'Max entries (default 25)',
          },
        ],
        responses: {
          '200': { description: 'Envelope with auditLog: MistAuditLogLive | null' },
        },
      },
    },
    '/api/central': {
      get: {
        summary:
          'Central plane dashboard envelope (claimed devices, site rollup, firmware, WLANs, recent alerts)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/central/export': {
      get: {
        summary:
          'CSV of Central dashboard slices (combined device+site, or dedicated firmware/wlans/alerts; no secrets)',
        parameters: [
          {
            name: 'part',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['device', 'site', 'firmware', 'wlans', 'alerts'],
            },
            description:
              'device|site narrow the combined section CSV; firmware|wlans|alerts are dedicated column sets; omit = devices+sites',
          },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: 'Invalid part' },
        },
      },
    },
    '/api/central/webhooks/export': {
      get: {
        summary:
          'CSV of Central webhook summaries (id/name/endpoint/auth/generation/timestamps; no secrets/HMAC)',
        parameters: [
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Substring filter on name/endpoint (same as list)',
          },
        ],
        responses: { '200': { description: 'text/csv central-webhooks.csv' } },
      },
    },
    '/api/hooks/events': {
      get: {
        summary: 'Recent inbound webhook receiver events (summary fields only)',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          {
            name: 'source',
            in: 'query',
            schema: { type: 'string', enum: ['mist', 'central'] },
            description: 'Optional source filter',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Substring across title/detail/device/eventType/site',
          },
        ],
        responses: { '200': { description: '{ events, note? }' } },
      },
    },
    '/api/hooks/events/export': {
      get: {
        summary:
          'CSV of recent inbound webhook events (no raw payloads or signing secrets)',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          {
            name: 'source',
            in: 'query',
            schema: { type: 'string', enum: ['mist', 'central'] },
          },
          { name: 'q', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'text/csv webhook-events.csv' } },
      },
    },
    '/api/clearpass': {
      get: {
        summary:
          'ClearPass screen envelope (services/roles/policies/stats; endpoint rows stay on-demand)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/clearpass/endpoints': {
      get: {
        summary:
          'On-demand ClearPass endpoint page (optional q/status/category; not the screen envelope snapshot)',
        parameters: [
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', minimum: 0 },
            description: 'Row offset (default 0)',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100 },
            description: 'Page size (default 50, max 100)',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Substring over hostname/MAC/IP (and related fields)',
          },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact endpoint status (Known/Unknown/Disabled/…)',
          },
          {
            name: 'category',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact endpoint category',
          },
        ],
        responses: {
          '200': { description: 'Endpoint page { endpoints, offset, limit, total? }' },
          '400': { description: 'offset/limit validation failed' },
        },
      },
    },
    '/api/clearpass/export': {
      get: {
        summary:
          'CSV of ClearPass endpoint snapshot + auth sessions, or services (optional q/status/category/enabled; part=endpoints|sessions|services; no secrets)',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter' },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact endpoint status (Known/Unknown/Disabled/…); endpoints only',
          },
          {
            name: 'category',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact endpoint category; endpoints only',
          },
          {
            name: 'enabled',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off'] },
            description:
              'Service enabled filter (queryFlag vocabulary: 1/true/yes/on | 0/false/no/off); services part only',
          },
          {
            name: 'part',
            in: 'query',
            schema: { type: 'string', enum: ['endpoints', 'sessions', 'services'] },
            description: 'endpoints, sessions, services (dedicated columns), or omit for endpoints+sessions',
          },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: "part must be 'endpoints', 'sessions', 'services', or omitted" },
        },
      },
    },
    '/api/configure': {
      get: {
        summary:
          'Configure screen envelope (stats, SSID/port/VLAN inventory examples, broker queue, capability matrix)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/configure/export': {
      get: {
        summary:
          'CSV of Configure inventory (part=ssids|ports|vlans; optional q via shared queryString; summary columns only, no bodies/secrets)',
        parameters: [
          {
            name: 'part',
            in: 'query',
            schema: { type: 'string', enum: ['ssids', 'ports', 'vlans'] },
            description: 'ssids (default), ports, or vlans',
          },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter' },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: "part must be 'ssids', 'ports', or 'vlans'" },
        },
      },
    },
    '/api/search-index': {
      get: {
        summary: 'Global search index (raised tickets + live inventory hits + applicable fixtures)',
        responses: { '200': { description: 'Envelope with entries[]' } },
      },
    },
    '/api/search-index/export': {
      get: {
        summary:
          'CSV of the global search index (kind/label/meta/view/arg only; optional q/kind filters; no secrets)',
        parameters: [
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Substring across kind/label/meta/view/arg',
          },
          {
            name: 'kind',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact kind filter (case-insensitive)',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/topology': {
      get: {
        summary: 'Estate neighbour graph (reported facts only; demo or live envelope)',
        responses: { '200': { description: 'Envelope with graph {nodes,edges,sites,omissions} and notes[]' } },
      },
    },
    '/api/topology/export': {
      get: {
        summary:
          'CSV of estate topology graph facts (part=nodes|edges; optional q/plane/ghosts/type match screen filter; no guessed edges)',
        parameters: [
          {
            name: 'part',
            in: 'query',
            schema: { type: 'string', enum: ['nodes', 'edges'] },
            description: 'nodes (default) or edges',
          },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter (name/serial/site/plane)' },
          { name: 'plane', in: 'query', schema: { type: 'string' }, description: 'Plane badge filter (e.g. MIST)' },
          {
            name: 'type',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact device type filter (e.g. ap, switch); empty/all = no-op',
          },
          {
            name: 'ghosts',
            in: 'query',
            schema: { type: 'string', enum: ['1', 'true', 'yes', 'on'] },
            description: 'When 1/true/yes/on (queryFlag), only ghost (unfiled) nodes',
          },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: "part must be 'nodes' or 'edges'" },
        },
      },
    },
    '/api/devices/bulk': {
      get: {
        summary: 'Bulk device lookup by serial',
        parameters: [
          { name: 'serials', in: 'query', required: true, schema: { type: 'string' }, description: 'Comma-separated serials (max 50)' },
          { name: 'planes', in: 'query', schema: { type: 'string' }, description: 'Optional comma-separated plane filter' },
        ],
        responses: {
          '200': { description: '{ devices, missing, requested }' },
          '400': { description: 'serials required' },
        },
      },
    },
    '/api/clients': {
      get: {
        summary:
          'Unified client sessions (optional page + q/plane/medium/type/site/group/problems filters)',
        parameters: [
          { name: 'mac', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter across identity fields' },
          { name: 'plane', in: 'query', schema: { type: 'string' }, description: 'Plane label (also sources)' },
          {
            name: 'medium',
            in: 'query',
            schema: { type: 'string', enum: ['wired', 'wireless'] },
            description: 'Exact medium',
          },
          { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Exact client type' },
          { name: 'site', in: 'query', schema: { type: 'string' }, description: 'Exact siteName (case-insensitive)' },
          { name: 'group', in: 'query', schema: { type: 'string' }, description: 'Exact group (case-insensitive)' },
          {
            name: 'problems',
            in: 'query',
            schema: { type: 'string', enum: ['1', 'true'] },
            description: 'When set, only problem rows',
          },
        ],
        responses: {
          '200': { description: 'Envelope with clients[]; optional page' },
          '304': { description: 'Not modified' },
        },
      },
    },
    '/api/sites': {
      get: {
        summary: 'Merged site inventory (optional page + q/plane/health filters)',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Substring filter across name/id/subnet/mix/sync',
          },
          {
            name: 'plane',
            in: 'query',
            schema: { type: 'string' },
            description: 'Plane badge name on sites.planes[] (case-insensitive)',
          },
          {
            name: 'health',
            in: 'query',
            schema: { type: 'string', enum: ['ok', 'warn', 'bad', 'stale'] },
            description: 'SiteHealthTone (row tone)',
          },
        ],
        responses: {
          '200': { description: 'Envelope with sites[]; optional page {total,limit,cursor,nextCursor}' },
          '304': { description: 'Not modified' },
          '400': { description: 'Pagination validation failed' },
        },
      },
    },
    '/api/sites/{siteId}': {
      get: {
        summary: 'Site detail envelope (profile/reachability/devices/alerts + Mist maps/SLE/rogues when present)',
        parameters: [{ name: 'siteId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Unknown site' },
        },
      },
    },
    '/api/devices/{name}': {
      get: {
        summary: 'Device detail envelope by display name (prefer plane+serial identity query)',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
          { name: 'serial', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Unknown device' },
        },
      },
    },
    '/api/devices/{name}/clients/export': {
      get: {
        summary:
          'CSV of client sessions attached to one device (same plane/serial identity as detail; empty CSV when none reported; no secrets)',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
          { name: 'serial', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: 'Invalid identity query' },
          '404': { description: 'Unknown device' },
          '409': { description: 'Ambiguous device name — pass plane and serial' },
        },
      },
    },
    '/api/devices/{name}/ports/export': {
      get: {
        summary:
          'CSV of port/interface rows for one device (same plane/serial identity as detail; demo profile or live detail ports; empty CSV when none reported; no secrets)',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
          { name: 'serial', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: 'Invalid identity query' },
          '404': { description: 'Unknown device' },
          '409': { description: 'Ambiguous device name — pass plane and serial' },
        },
      },
    },
    '/api/clients/{mac}': {
      get: {
        summary:
          'Client detail by MAC (same envelope as GET /api/clients?mac=; missing MAC yields client:null, not 404)',
        parameters: [{ name: 'mac', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Clients envelope with optional client detail' } },
      },
    },
    '/api/sites/{siteId}/sle/export': {
      get: {
        summary:
          'CSV of polled Mist SLE metric scores for one site (summary columns only; no secrets)',
        parameters: [{ name: 'siteId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'text/csv' },
          '404': { description: 'Unknown site or no SLE scores available' },
        },
      },
    },
    '/api/sites/{siteId}/sle/{metric}/export': {
      get: {
        summary:
          'CSV of one Mist SLE metric drill (classifiers + impacted clients/APs; no secrets)',
        parameters: [
          { name: 'siteId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'metric', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '404': { description: 'Unknown site or missing drill' },
        },
      },
    },
    '/api/sites/{siteId}/sle/{metric}': {
      get: {
        summary: 'On-demand Mist SLE metric drill-down for one site',
        parameters: [
          { name: 'siteId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'metric', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Envelope with sleDetail (or null when no plane can answer)' },
          '404': { description: 'Unknown site or missing demo drill' },
        },
      },
    },
    '/api/devices/{name}/trends/export': {
      get: {
        summary:
          'CSV of device trend samples (part=hardware|interfaces|ap; metric key/t/v only; no secrets)',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'part',
            in: 'query',
            schema: { type: 'string', enum: ['hardware', 'interfaces', 'ap'] },
            description: 'Trend slice (default hardware for switches, ap for APs)',
          },
          {
            name: 'metric',
            in: 'query',
            schema: { type: 'string', enum: ['cpu', 'memory', 'throughput'] },
            description: 'AP metric when part=ap (default cpu)',
          },
          { name: 'start', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'end', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
          { name: 'serial', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: 'Invalid part or identity' },
          '404': { description: 'Unknown device or no trend read' },
          '409': { description: 'Ambiguous device name' },
        },
      },
    },
    '/api/sites/{siteId}/applications': {
      get: {
        summary: 'On-demand Central DPI applications table for one site/window',
        parameters: [
          { name: 'siteId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'start', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'end', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          '200': { description: 'Envelope with applications (or null when no plane can answer)' },
          '404': { description: 'Unknown site or missing demo table' },
        },
      },
    },
    '/api/sites/{siteId}/applications/export': {
      get: {
        summary: 'CSV of site DPI applications (same window as JSON route; no secrets)',
        parameters: [
          { name: 'siteId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'start', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'end', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '404': { description: 'Unknown site or no applications available' },
        },
      },
    },
    '/api/sites/{siteId}/rogues/export': {
      get: {
        summary:
          'CSV of Mist rogue/neighbor BSSIDs heard at one site (poll-time; on-LAN first; no secrets)',
        parameters: [{ name: 'siteId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'text/csv (empty body rows = nothing heard)' },
          '404': { description: 'Unknown site' },
        },
      },
    },
    '/api/auth-events': {
      get: {
        summary: 'RADIUS / policy auth events',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Filter events only; stats stay full-feed' },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
          {
            name: 'result',
            in: 'query',
            schema: { type: 'string', enum: ['accept', 'reject', 'timeout'] },
            description: 'Exact result filter (unknown values ignored)',
          },
          {
            name: 'service',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact service name (case-insensitive)',
          },
          {
            name: 'method',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact auth method (case-insensitive; e.g. EAP-TLS, MAB)',
          },
          {
            name: 'role',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact role label (case-insensitive; e.g. Clinical staff)',
          },
          {
            name: 'range',
            in: 'query',
            schema: { type: 'string', enum: ['15m', '1h', '24h', '7d'] },
            description:
              'Quick time window on event.at ending now (UI TimeRangeControl). Undated rows always pass. Unknown/absent = all.',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer' },
            description: 'Optional page size for events[] (max 500). Omit for full list.',
          },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Envelope with events[]; optional page when limit set' },
          '304': { description: 'Not modified' },
        },
      },
    },
    '/api/auth-events/export': {
      get: {
        summary: 'CSV of auth events (optional q/plane/result/service/method/role/range; no secrets)',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter' },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
          {
            name: 'result',
            in: 'query',
            schema: { type: 'string', enum: ['accept', 'reject', 'timeout'] },
          },
          { name: 'service', in: 'query', schema: { type: 'string' } },
          {
            name: 'method',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact auth method (case-insensitive)',
          },
          {
            name: 'role',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact role label (case-insensitive)',
          },
          {
            name: 'range',
            in: 'query',
            schema: { type: 'string', enum: ['15m', '1h', '24h', '7d'] },
            description: 'Quick time window on event.at (same as list)',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/tickets/export': {
      get: {
        summary: 'CSV of ticket queue (noteCount only — no note bodies; optional q/pri/state/site)',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring on operator-visible fields' },
          { name: 'pri', in: 'query', schema: { type: 'string', enum: ['P1', 'P2', 'P3'] } },
          {
            name: 'state',
            in: 'query',
            schema: { type: 'string', enum: ['open', 'in progress', 'waiting', 'resolved', 'openish'] },
          },
          {
            name: 'site',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact siteName or siteId (case-insensitive)',
          },
        ],
        responses: {
          '200': { description: 'text/csv including noteCount column' },
          '400': { description: 'Invalid pri/state' },
        },
      },
    },
    '/api/uxi': {
      get: {
        summary: 'UXI sensor fleet envelope',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring on name/serial/site/model/MAC' },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['online', 'offline', 'issues', 'unknown', 'idle'] },
            description: 'Sensor health filter',
          },
          { name: 'site', in: 'query', schema: { type: 'string' }, description: 'Exact site name (case-insensitive)' },
          {
            name: 'severity',
            in: 'query',
            schema: { type: 'string', enum: ['critical', 'warning', 'info'] },
            description: 'Sensors with at least one active issue of this severity',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer' },
            description: 'Optional page size for sensors[] (max 500). Omit for full list.',
          },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Envelope with sensors[]; optional page when limit set; optional missingSources when UXI is linked but silent',
          },
          '304': { description: 'Not modified' },
          '400': { description: 'Invalid paging' },
        },
      },
    },
    '/api/uxi/export': {
      get: {
        summary: 'CSV of UXI sensors (no credentials; optional q/status/site/severity)',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['online', 'offline', 'issues', 'unknown', 'idle'] },
          },
          { name: 'site', in: 'query', schema: { type: 'string' } },
          {
            name: 'severity',
            in: 'query',
            schema: { type: 'string', enum: ['critical', 'warning', 'info'] },
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/overview': {
      get: {
        summary: 'Operations overview envelope (stats, needs-you-now, sites, planes, changes, launchpad)',
        responses: {
          '200': { description: 'OK (weak ETag; Cache-Control: private, no-cache)' },
          '304': { description: 'Not modified (If-None-Match)' },
        },
      },
    },
    '/api/overview/export': {
      get: {
        summary:
          'CSV of Overview landing slices (part=alerts|planes|sites|changes; sites honour health=; no secrets)',
        parameters: [
          {
            name: 'part',
            in: 'query',
            schema: { type: 'string', enum: ['alerts', 'planes', 'sites', 'changes'] },
            description:
              "alerts (default) Needs you now; planes management roster; sites estate preview; changes recent log",
          },
          {
            name: 'health',
            in: 'query',
            schema: { type: 'string', enum: ['ok', 'warn', 'bad', 'stale'] },
            description: 'Only with part=sites — same ok|warn|bad|stale vocabulary as Overview/Sites (shared queryString; trim; non-string → all)',
          },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: 'Unknown part or invalid health' },
        },
      },
    },
    '/api/systems': {
      get: {
        summary: 'Connected systems screen view model (systems + syncHistory + permissions)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/systems/export': {
      get: {
        summary:
          'CSV of connected-systems roster (name/planeId/kind/health/scope/sync/counts only — no credentials, tokens, call paths, or free-text notes)',
        parameters: [
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Substring on name/planeId/kind/health/scope',
          },
          {
            name: 'health',
            in: 'query',
            schema: { type: 'string', enum: ['healthy', 'warning', 'degraded', 'unlinked'] },
            description: 'Exact health (unknown values ignored — honest no-op)',
          },
          {
            name: 'linked',
            in: 'query',
            schema: { type: 'string', enum: ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'] },
            description:
              'queryFlag vocabulary: 1/true/yes/on → only non-unlinked rows; 0/false/no/off → only unlinked; unknown → no-op',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/alerts/export': {
      get: {
        summary:
          'CSV of active alert groups (latest + count; optional q=/plane=/sev=/site=/unacked=/cleared= on nested latest fields; no silence payloads)',
        parameters: [
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Substring on latest title/detail/site/device/plane/sev/fingerprint',
          },
          {
            name: 'plane',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact plane on latest.plane (case-insensitive; comma multi = OR)',
          },
          {
            name: 'sev',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact severity on latest.sev (P1|P2|P3; comma multi = OR)',
          },
          {
            name: 'site',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact site on latest.siteId or latest.siteName (case-insensitive; comma multi = OR)',
          },
          {
            name: 'unacked',
            in: 'query',
            schema: { type: 'string', enum: ['1', 'true', 'yes', 'on'] },
            description:
              'When 1/true/yes/on (queryFlag), only latest.state=open (Unacknowledged only)',
          },
          {
            name: 'cleared',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off'] },
            description:
              'queryFlag: 0/false/no/off drops cleared groups (UI default hide); 1/true/yes/on keeps them; omit/unknown = no cleared gate',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/alert-rules': {
      get: {
        summary: 'Device-down rules on file (optional enabled=/deviceType=)',
        parameters: [
          {
            name: 'enabled',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
            description: 'When set, only enabled (1/true) or disabled (0/false) rules',
          },
          {
            name: 'deviceType',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Canonical or alias device-type vocabulary (all|switch|ap|gateway; aliases ok). Exact match on rule.deviceTypeFilter; unknown → no-op',
          },
        ],
        responses: { '200': { description: '{ rules: DeviceDownRule[] }' } },
      },
      post: {
        summary: 'Create a device-down rule',
        responses: {
          '201': { description: '{ rule }' },
          '400': { description: 'validation failed' },
        },
      },
    },
    '/api/alert-rules/export': {
      get: {
        summary: 'CSV of device-down rules on file (optional enabled=/deviceType=; no secrets)',
        parameters: [
          {
            name: 'enabled',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
            description: 'When set, only enabled (1/true) or disabled (0/false) rules',
          },
          {
            name: 'deviceType',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Canonical or alias device-type vocabulary (all|switch|ap|gateway; aliases ok). Exact match on rule.deviceTypeFilter; unknown → no-op',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/silences': {
      get: {
        summary: 'Alert silences on file (optional active=/q= filters)',
        parameters: [
          {
            name: 'active',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
            description: 'When set, only active (1/true) or expired (0/false) silences',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on id / plane / device / titleContains / reason',
          },
        ],
        responses: { '200': { description: '{ silences: AlertSilence[] }' } },
      },
      post: {
        summary: 'Create a time-boxed silence',
        responses: {
          '201': { description: '{ silence }' },
          '400': { description: 'validation failed' },
        },
      },
    },
    '/api/silences/export': {
      get: {
        summary:
          'CSV of silences on file (optional active=/q=; matchers + reason + expiry; no secrets)',
        parameters: [
          {
            name: 'active',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
            description: 'When set, only active (1/true) or expired (0/false) silences',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on id / plane / device / titleContains / reason',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/maintenance-windows': {
      get: {
        summary:
          'Maintenance windows on file (+ demo fixtures when demoMode; optional enabled=/state=/q=)',
        parameters: [
          {
            name: 'enabled',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
          },
          {
            name: 'state',
            in: 'query',
            schema: { type: 'string', enum: ['active', 'upcoming', 'expired'] },
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on id / reason / plane / device / site / titleSubstring',
          },
        ],
        responses: { '200': { description: '{ windows: MaintenanceWindowView[] }' } },
      },
      post: {
        summary: 'Create a maintenance window',
        responses: {
          '201': { description: '{ window }' },
          '400': { description: 'validation failed' },
        },
      },
    },
    '/api/maintenance-windows/export': {
      get: {
        summary:
          'CSV of maintenance windows (optional enabled=/state=/q=; matchers + schedule + span; no secrets)',
        parameters: [
          {
            name: 'enabled',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
          },
          {
            name: 'state',
            in: 'query',
            schema: { type: 'string', enum: ['active', 'upcoming', 'expired'] },
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on id / reason / plane / device / site / titleSubstring',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/alert-rules/{id}': {
      put: {
        summary: 'Partial edit of a device-down rule',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ rule }' },
          '400': { description: 'validation failed' },
          '404': { description: 'unknown rule' },
        },
      },
      delete: {
        summary: 'Delete a device-down rule',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ ok, rule }' },
          '404': { description: 'unknown rule' },
        },
      },
    },
    '/api/alerts/{fingerprint}/timeline': {
      get: {
        summary:
          'Occurrence timeline for one alert group (firings, silences, changes, drift; no secrets)',
        parameters: [
          {
            name: 'fingerprint',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Normalised plane|device|title fingerprint',
          },
        ],
        responses: {
          '200': { description: 'Envelope with timeline events (oldest first)' },
          '404': { description: 'Unknown fingerprint with no store facts' },
        },
      },
    },
    '/api/alerts/{fingerprint}/timeline/export': {
      get: {
        summary:
          'CSV of one alert group occurrence timeline (ts/kind/label/detail; no secrets)',
        parameters: [
          {
            name: 'fingerprint',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Normalised plane|device|title fingerprint',
          },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '404': { description: 'Unknown fingerprint with no store facts' },
        },
      },
    },
    '/api/compliance': {
      get: {
        summary: 'Compliance findings, baselines, and evidence mode (no secrets)',
        parameters: [
          {
            name: 'baseline',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact baseline label on findings[] (stats/baselines stay full)',
          },
          {
            name: 'sev',
            in: 'query',
            schema: { type: 'string', enum: ['high', 'med', 'low'] },
            description: 'Finding severity filter',
          },
          {
            name: 'plane',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact plane on findings[] (case-insensitive)',
          },
          {
            name: 'fix',
            in: 'query',
            schema: { type: 'string', enum: ['auto', 'manual', 'window', 'ssh scan'] },
            description: 'Finding fix-class filter (exact, case-insensitive)',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on title/detail/rule/device/plane/baseline (stats stay full)',
          },
        ],
        responses: {
          '200': {
            description:
              'Envelope with stats, findings, baselines, diff, evidenceMode; optional missingInventories; findings may be filtered',
          },
          '400': { description: 'Invalid sev or fix' },
        },
      },
    },
    '/api/compliance/export': {
      get: {
        summary: 'CSV of compliance findings (no full diff body; optional baseline/sev/plane/fix/q)',
        parameters: [
          { name: 'baseline', in: 'query', schema: { type: 'string' } },
          {
            name: 'sev',
            in: 'query',
            schema: { type: 'string', enum: ['high', 'med', 'low'] },
          },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
          {
            name: 'fix',
            in: 'query',
            schema: { type: 'string', enum: ['auto', 'manual', 'window', 'ssh scan'] },
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Case-insensitive substring on title/detail/rule/device/plane/baseline',
          },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: 'Invalid sev or fix' },
        },
      },
    },
    '/api/config-backups/export': {
      get: {
        summary:
          'CSV of running-config backup roster metadata (no config bodies; optional drift/q/plane/status)',
        parameters: [
          {
            name: 'drift',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
            description:
              '1/true = only devices whose latest snapshot differs from previous; 0/false = non-drifted only; omit = full roster',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on device/plane/ip/status/note/latestSource (Loop 105)',
          },
          {
            name: 'plane',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact plane label (case-insensitive)',
          },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['ok', 'pending', 'no-source', 'failed'] },
            description: 'Exact backup status (unknown values ignored — honest no-op)',
          },
        ],
        responses: { '200': { description: 'text/csv config-backups.csv' } },
      },
    },
    '/api/licenses/export': {
      get: {
        summary: 'CSV of licence subscription rows or renewals table',
        parameters: [
          {
            name: 'part',
            in: 'query',
            schema: { type: 'string', enum: ['subscriptions', 'renewals'] },
            description: 'subscriptions (default) or renewals (soonest-first window)',
          },
          {
            name: 'idle',
            in: 'query',
            schema: { type: 'string', enum: ['1', 'true'] },
            description:
              'Include idle zero-assignment seats on subscriptions export. Default hides them (UI parity). Ignored for renewals.',
          },
          {
            name: 'plane',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Exact subscription plane (case-insensitive). Subscriptions only; ignored for renewals.',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Substring on name/sku/plane/term/status. Subscriptions only; ignored for renewals.',
          },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Exact subscription status (case-insensitive; e.g. active, idle, expiring, retiring). Applied after idle-hide. Subscriptions only; ignored for renewals.',
          },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: "part must be 'subscriptions' or 'renewals'" },
        },
      },
    },
    '/api/alerts': {
      get: {
        summary: 'Alert queue with groups',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Pages groups[] when set' },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Substring on latest title/detail/site/device/plane/sev/fingerprint (before paging)',
          },
          {
            name: 'plane',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact plane on latest.plane (case-insensitive; comma multi = OR; before paging)',
          },
          {
            name: 'sev',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact severity on latest.sev (P1|P2|P3; comma multi = OR; before paging)',
          },
          {
            name: 'site',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact site on latest.siteId or latest.siteName (case-insensitive; comma multi = OR; before paging)',
          },
          {
            name: 'unacked',
            in: 'query',
            schema: { type: 'string', enum: ['1', 'true', 'yes', 'on'] },
            description:
              'When 1/true/yes/on (queryFlag), only latest.state=open (before paging)',
          },
          {
            name: 'cleared',
            in: 'query',
            schema: { type: 'string', enum: ['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off'] },
            description:
              'queryFlag: 0/false/no/off drops cleared groups; 1/true/yes/on keeps them; omit/unknown = no cleared gate (before paging)',
          },
        ],
        responses: { '200': { description: 'OK' }, '304': { description: 'Not modified' } },
      },
    },
    '/api/recommendations': {
      get: {
        summary: 'Read-only config hygiene suggestions',
        parameters: [
          { name: 'device', in: 'query', schema: { type: 'string' } },
          { name: 'site', in: 'query', schema: { type: 'string' } },
          { name: 'client', in: 'query', schema: { type: 'string' } },
          {
            name: 'category',
            in: 'query',
            schema: {
              type: 'string',
              enum: [
                'firmware',
                'configuration',
                'redundancy',
                'security',
                'performance',
                'compliance',
                'inventory',
              ],
            },
            description: 'Unknown values are ignored (honest no-op)',
          },
          {
            name: 'severity',
            in: 'query',
            schema: { type: 'string', enum: ['info', 'suggestion', 'warning'] },
            description: 'Unknown values are ignored (honest no-op)',
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 0 },
            description: 'Non-negative integer; garbage → 400',
          },
        ],
        responses: { '200': { description: '{ recommendations, counts, readOnly: true }' } },
      },
    },
    '/api/recommendations/export': {
      get: {
        summary: 'CSV of filtered config recommendations (never applies config; limit ignored)',
        parameters: [
          { name: 'device', in: 'query', schema: { type: 'string' } },
          { name: 'site', in: 'query', schema: { type: 'string' } },
          { name: 'client', in: 'query', schema: { type: 'string' } },
          {
            name: 'category',
            in: 'query',
            schema: {
              type: 'string',
              enum: [
                'firmware',
                'configuration',
                'redundancy',
                'security',
                'performance',
                'compliance',
                'inventory',
              ],
            },
            description: 'Unknown values are ignored (honest no-op)',
          },
          {
            name: 'severity',
            in: 'query',
            schema: { type: 'string', enum: ['info', 'suggestion', 'warning'] },
            description: 'Unknown values are ignored (honest no-op)',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/taxonomy/summary': {
      get: {
        summary: 'Device and client category buckets',
        responses: { '200': { description: '{ devices, clients }' } },
      },
    },
    '/api/visual-references': {
      get: { summary: 'List operator visual references', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create url/native/product reference', responses: { '201': { description: 'Created' } } },
    },
    '/api/visual-references/export': {
      get: {
        summary:
          'CSV of visual reference metadata only (title/source/owner/url/asset id; never binary bytes)',
        parameters: [
          { name: 'kind', in: 'query', schema: { type: 'string' }, description: 'Target kind (requires id)' },
          { name: 'id', in: 'query', schema: { type: 'string' }, description: 'Target id (requires kind)' },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'text/csv visual-references.csv' },
          '400': { description: 'kind and id must be supplied together' },
        },
      },
    },
    '/api/visual-assets': {
      post: { summary: 'Upload visual asset (raw body + X-Visual-* headers)', responses: { '201': { description: 'Created' } } },
    },
    '/api/visual-assets/{assetId}': {
      get: { summary: 'Stream stored visual asset', parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Bytes' } } },
    },
    '/api/notifications/center': {
      get: { summary: 'In-app notification bell page', responses: { '200': { description: '{ entries, unread }' } } },
    },
    '/api/notifications/center/stream': {
      get: {
        summary: 'SSE stream of notification-center snapshots',
        responses: { '200': { description: 'text/event-stream' } },
      },
    },
    '/api/configure/history': {
      get: {
        summary: 'Broker change audit events (no payloads)',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'kind', in: 'query', schema: { type: 'string' }, description: 'Exact kind filter (ssid|port|vlan, case-insensitive)' },
          { name: 'result', in: 'query', schema: { type: 'string' }, description: 'Exact broker result word (case-insensitive)' },
          { name: 'ticket', in: 'query', schema: { type: 'string' }, description: 'Exact ticket reference (case-insensitive)' },
        ],
        responses: { '200': { description: '{ events, unreadable }' } },
      },
    },
    '/api/configure/history/export': {
      get: {
        summary: 'CSV export of broker audit events',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'kind', in: 'query', schema: { type: 'string' } },
          { name: 'result', in: 'query', schema: { type: 'string' } },
          { name: 'ticket', in: 'query', schema: { type: 'string' }, description: 'Exact ticket reference (case-insensitive)' },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/notifications/deliveries': {
      get: {
        summary: 'Live notification delivery attempt log (no payload bodies)',
        parameters: [
          {
            name: 'result',
            in: 'query',
            schema: { type: 'string', enum: ['delivered', 'failed', 'demo'] },
            description: 'Outcome filter; unknown values ignored',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on endpoint / title / error / eventKind / fingerprint / result / httpCode / test (Loop 116)',
          },
        ],
        responses: { '200': { description: '{ demoMode, entries[] }' } },
      },
    },
    '/api/notifications/deliveries/export': {
      get: {
        summary: 'CSV of notification delivery outcomes (no payload bodies or secrets)',
        parameters: [
          {
            name: 'result',
            in: 'query',
            schema: { type: 'string', enum: ['delivered', 'failed', 'demo'] },
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on endpoint / title / error / eventKind / fingerprint / result / httpCode / test (Loop 116)',
          },
        ],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/notifications/outbox/export': {
      get: {
        summary:
          'CSV of webhook demo-outbox summaries (event metadata only; never payload bodies, URLs, or HMAC secrets)',
        parameters: [
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on endpoint / title / eventKind / fingerprint / plane / device / site / sev / id — never payload bodies (Loop 119)',
          },
        ],
        responses: { '200': { description: 'text/csv notification-outbox.csv' } },
      },
    },
    '/api/notifications/report/export': {
      get: {
        summary:
          'CSV of fleet-report demo outbox metadata (subject/recipients/at only; never email text/html bodies)',
        parameters: [
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on subject / recipients / id — never email text/html bodies (Loop 119)',
          },
        ],
        responses: { '200': { description: 'text/csv fleet-report-outbox.csv' } },
      },
    },
    '/api/notifications/ssl-hosts': {
      get: {
        summary: 'SSL certificate watch list (probe outcomes; no PEMs)',
        parameters: [
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on host / port / probe error / notAfter / ok|fail (Loop 116)',
          },
        ],
        responses: { '200': { description: '{ hosts[] }' } },
      },
    },
    '/api/notifications/ssl-hosts/export': {
      get: {
        summary:
          'CSV of SSL certificate watch list + last probe outcome (no PEMs or private keys)',
        parameters: [
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on host / port / probe error / notAfter / ok|fail (Loop 116)',
          },
        ],
        responses: { '200': { description: 'text/csv ssl-hosts.csv' } },
      },
    },
    '/api/diagnostics/history/export': {
      get: {
        summary:
          'CSV of reviewed diagnostics audit history (target always redacted; optional device/plane/state/q filters)',
        parameters: [
          {
            name: 'device',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact device name or serial (case-insensitive)',
          },
          { name: 'plane', in: 'query', schema: { type: 'string' }, description: 'Exact plane label' },
          {
            name: 'state',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact audit state (succeeded/failed/cancelled/…)',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Case-insensitive substring on id / device / serial / plane / operation / state',
          },
        ],
        responses: { '200': { description: 'text/csv diagnostics-history.csv' } },
      },
    },
    '/api/metrics/export': {
      get: {
        summary:
          'CSV of metrics-history samples or anomaly flags (counts only; optional part=series|anomalies)',
        parameters: [
          {
            name: 'part',
            in: 'query',
            schema: { type: 'string', enum: ['series', 'anomalies'] },
            description: 'series (default) flattens plane/device samples; anomalies exports flag rows',
          },
        ],
        responses: {
          '200': { description: 'text/csv metrics-series.csv or metrics-anomalies.csv' },
          '400': { description: 'Unknown part' },
        },
      },
    },
    '/api/systems/{plane}/health': {
      get: {
        summary: 'Per-plane health drill-down (calls/events, no secrets)',
        parameters: [{ name: 'plane', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'linked, health, recentCalls, recentEvents' }, '404': { description: 'unknown plane' } },
      },
    },
    '/api/debug/runtime': {
      get: {
        summary: 'Operator runtime diagnostics (no secrets)',
        responses: {
          '200': {
            description:
              'process, portal, planes, poller, notifier, integrity{devices,doubleClaimed,unclaimed} counts only',
          },
        },
      },
    },
    '/api/debug/runtime/export': {
      get: {
        summary:
          'CSV connector/plane integrity summary (reconcile counts + plane link/health; optional filter=; no secrets)',
        parameters: [
          {
            name: 'filter',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['linked', 'unlinked', 'healthy', 'degraded', 'stale'],
            },
            description:
              'Same plane slice as Systems Runtime debug ?rtFilter=; integrity tallies always included',
          },
        ],
        responses: {
          '200': { description: 'text/csv connector-integrity.csv' },
          '400': { description: 'Unknown filter' },
        },
      },
    },
    '/api/sse/objects/{kind}/export': {
      get: {
        summary:
          'CSV of one SSE object kind from the poller cache (summary fields only; optional q= filter; no raw/secrets)',
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'text/csv sse-<kind>.csv' },
          '404': { description: 'Unknown kind' },
          '409': { description: 'SSE plane not linked' },
        },
      },
    },
    '/api/tickets': {
      get: {
        summary: 'Operator ticket queue (raised + demo base when applicable)',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Optional page size (attaches page envelope)' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Offset cursor from prior page.nextCursor' },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive match on id/title/site/owner/reporter/state/planes' },
          { name: 'pri', in: 'query', schema: { type: 'string', enum: ['P1', 'P2', 'P3'] }, description: 'Exact priority filter' },
          {
            name: 'state',
            in: 'query',
            schema: { type: 'string', enum: ['open', 'in progress', 'waiting', 'resolved', 'openish'] },
            description: "Exact state, or openish (anything except resolved)",
          },
          {
            name: 'site',
            in: 'query',
            schema: { type: 'string' },
            description: 'Exact siteName or siteId (case-insensitive)',
          },
        ],
        responses: {
          '200': { description: 'Envelope with tickets[]; optional page {total,limit,cursor,nextCursor}' },
          '400': { description: 'Invalid limit/cursor/pri/state' },
        },
      },
    },
    '/api/licenses': {
      get: {
        summary: 'Licence subscriptions, renewals, orphans, Mist usages',
        responses: { '200': { description: 'Envelope with stats, subscriptions, renewals, orphans' } },
      },
    },
    '/api/greenlake/inventory': {
      get: {
        summary: 'Cached GreenLake workspace inventory (members, locations, role grants)',
        responses: {
          '200': { description: 'Inventory + canWrite' },
          '409': { description: 'GreenLake not linked' },
        },
      },
    },
    '/api/greenlake/export': {
      get: {
        summary:
          'CSV of one GreenLake workspace section (cached; optional q/status via shared queryString; no secrets)',
        parameters: [
          {
            name: 'part',
            in: 'query',
            schema: { type: 'string', enum: ['users', 'locations', 'roles'] },
            description: 'users (default), locations, or roles',
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string' },
            description: 'Substring filter over identity/status fields for the selected part',
          },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string' },
            description:
              'Exact user status (case-insensitive; e.g. VERIFIED). Only applied when part=users; ignored for locations/roles.',
          },
        ],
        responses: {
          '200': { description: 'text/csv' },
          '400': { description: "part must be 'users', 'locations', or 'roles'" },
          '409': { description: 'GreenLake not linked' },
        },
      },
    },
    '/api/openapi.json': {
      get: { summary: 'This catalog', responses: { '200': { description: 'OpenAPI document' } } },
    },
  },
} as const;

openapiRouter.get(
  '/openapi.json',
  h((_req, res) => {
    res.json(SPEC);
  }),
);
