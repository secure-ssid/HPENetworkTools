/**
 * web/src/api/client.ts — typed API layer, one function per screen endpoint.
 *
 * Every getter tries the backend first (`/api/...`) and, when the backend is
 * unreachable (network error — e.g. the server simply isn't running yet),
 * falls back to the shared fixtures so the UI is fully functional in demo
 * mode. Responses carry `dataSource: 'live' | 'demo'` so screens can say so.
 * The detail getters (site/device) go further: an ANSWERED non-OK is live
 * data saying "not in the cache", not an absent backend — it returns the
 * honest null-profile shape instead of substituting fixtures.
 * The on-demand per-object reads (getClientDetail / getSiteTopology, and the
 * `detail`/`topology` blocks the screen envelopes carry) have their own rules —
 * see "THREE STATES, PRESERVED ACROSS THIS BOUNDARY" below.
 */


/**
 * This module is a barrel. The implementation moved into the sibling modules
 * listed below, split by what each group of calls talks to. The rules that
 * make the layer trustworthy — when a fallback to fixtures is allowed and when
 * it is a lie — now live in exactly one place, ./core.
 *
 * The barrel stays because 46 files import from '../api/client', and renaming
 * 46 call sites to move code that did not otherwise change is churn. New code
 * should import from the specific module.
 */

export * from './core';
export * from './screens';
export * from './configure';
export * from './webhooks';
export * from './systems';
export * from './sse';
export * from './inventory';
export * from './chat';
export * from './tickets';
export * from './silences';
export * from './actions';
export * from './terminal';
export * from './settings';
export * from './greenlake';
export * from './metrics';
export * from './visualReferences';
export * from './recommendations';
