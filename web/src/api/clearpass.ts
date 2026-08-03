/**
 * ClearPass reviewed direct writes — endpoint register/update and local-user
 * create/update, all under /api/clearpass/*.
 *
 * The same reviewed pattern as the SSID direct apply (api/configure.ts):
 * every mutation requires an explicit `reviewConfirmed: true` (the drawer's
 * review checkbox is the only caller), the server validates → applies →
 * verifies → audits one line per attempt, and a refused or failed WRITE
 * answers 200 with the honest ClearPassWriteResult — only request/gating
 * problems come back non-OK. Local-user passwords are write-only: they go
 * out in the request body and are never in anything the server answers.
 */

import { noteResponseStatus, serverMessage, type ApiResult } from './core';
import type {
  ClearPassEndpointRegisterForm,
  ClearPassEndpointUpdateForm,
  ClearPassLocalUserCreateForm,
  ClearPassLocalUserUpdateForm,
  ClearPassWriteResult,
} from '@hpe/shared';

/** POST/PUT twin of core.ts's postForResult (which is POST-only): the
 *  server's own {error} message on non-OK, `offline: true` on a network
 *  failure so the screen can say the backend dropped instead of the plane. */
async function mutate<T>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<ApiResult<T>> {
  try {
    const r = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return (await r.json()) as T;
    noteResponseStatus(r.status);
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`) };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

/** POST /api/clearpass/endpoints — register one MAC with its attributes. */
export async function registerClearPassEndpoint(
  form: ClearPassEndpointRegisterForm,
  reviewConfirmed: boolean,
): Promise<ApiResult<ClearPassWriteResult>> {
  return mutate<ClearPassWriteResult>('/api/clearpass/endpoints', 'POST', { form, reviewConfirmed });
}

/** PUT /api/clearpass/endpoints/:id — status and/or the operator note. */
export async function updateClearPassEndpoint(
  id: string,
  form: ClearPassEndpointUpdateForm,
  reviewConfirmed: boolean,
): Promise<ApiResult<ClearPassWriteResult>> {
  return mutate<ClearPassWriteResult>(`/api/clearpass/endpoints/${encodeURIComponent(id)}`, 'PUT', {
    form,
    reviewConfirmed,
  });
}

/** POST /api/clearpass/local-users — create one local account. The form's
 *  password is write-only and appears in nothing the server answers. */
export async function createClearPassLocalUser(
  form: ClearPassLocalUserCreateForm,
  reviewConfirmed: boolean,
): Promise<ApiResult<ClearPassWriteResult>> {
  return mutate<ClearPassWriteResult>('/api/clearpass/local-users', 'POST', { form, reviewConfirmed });
}

/** PUT /api/clearpass/local-users/:id — any subset of the mutable fields;
 *  an absent password leaves the current one alone. */
export async function updateClearPassLocalUser(
  id: string,
  form: ClearPassLocalUserUpdateForm,
  reviewConfirmed: boolean,
): Promise<ApiResult<ClearPassWriteResult>> {
  return mutate<ClearPassWriteResult>(`/api/clearpass/local-users/${encodeURIComponent(id)}`, 'PUT', {
    form,
    reviewConfirmed,
  });
}
