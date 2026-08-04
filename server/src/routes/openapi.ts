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
        summary: 'Unified device inventory',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'Optional page size (max 500). Omit for full list.',
            schema: { type: 'integer' },
          },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Substring filter across identity fields' },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Envelope with devices[]; optional page {total,limit,cursor,nextCursor}' },
          '304': { description: 'Not modified (If-None-Match)' },
        },
      },
    },
    '/api/clients/export': {
      get: {
        summary: 'CSV export of client sessions (optional q/plane filters)',
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/sites/export': {
      get: {
        summary: 'CSV export of sites (optional q filter)',
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/devices/export': {
      get: {
        summary: 'CSV export of device inventory (optional q/plane filters)',
        responses: { '200': { description: 'text/csv' } },
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
        summary: 'Unified client sessions',
        parameters: [
          { name: 'mac', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Envelope with clients[]; optional page' },
          '304': { description: 'Not modified' },
        },
      },
    },
    '/api/sites': {
      get: {
        summary: 'Merged site inventory',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' }, '304': { description: 'Not modified' } },
      },
    },
    '/api/auth-events': {
      get: {
        summary: 'RADIUS / policy auth events',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Filter events only; stats stay full-feed' },
          { name: 'plane', in: 'query', schema: { type: 'string' } },
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
        summary: 'CSV of auth events (optional q/plane; no secrets)',
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/tickets/export': {
      get: {
        summary: 'CSV of ticket queue (no note bodies)',
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/uxi/export': {
      get: {
        summary: 'CSV of UXI sensors',
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/alerts/export': {
      get: {
        summary: 'CSV of active alert groups (latest + count; no silence payloads)',
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/compliance/export': {
      get: {
        summary: 'CSV of compliance findings (no full diff body)',
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/licenses/export': {
      get: {
        summary: 'CSV of licence subscription rows',
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/alerts': {
      get: {
        summary: 'Alert queue with groups',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Pages groups[] when set' },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
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
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'severity', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
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
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'severity', in: 'query', schema: { type: 'string' } },
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
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: '{ events, unreadable }' } },
      },
    },
    '/api/configure/history/export': {
      get: {
        summary: 'CSV export of broker audit events',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/notifications/deliveries': {
      get: {
        summary: 'Live notification delivery attempt log (no payload bodies)',
        responses: { '200': { description: '{ demoMode, entries[] }' } },
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
        responses: { '200': { description: 'process, portal, planes, poller, notifier' } },
      },
    },
    '/api/debug/runtime/export': {
      get: {
        summary: 'CSV of plane link/health facts (no secrets or note text)',
        responses: { '200': { description: 'text/csv' } },
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
