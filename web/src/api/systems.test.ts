/**
 * web/src/api/systems.test.ts — what the portal is entitled to say after a
 * credential save.
 *
 * The save runs the plane's first poll before it answers, so every one of
 * these messages is a report of something that already happened. The one case
 * with no report is the body we could not read, and that one has to stop at
 * the save rather than guess the rest.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveSystemCredentials } from './systems';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockSaveResponse(body: unknown, ok = true) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('saveSystemCredentials reports the poll the save ran', () => {
  it('says the plane indexed only when the poll came back ok', async () => {
    mockSaveResponse({ plane: 'clearpass', indexed: 'ok' });
    const res = await saveSystemCredentials('clearpass', { host: 'cppm.example.test' });
    expect(res.ok).toBe(true);
    expect(res.indexed).toBe('ok');
    expect(res.message).toBe('credentials saved and the plane indexed');
  });

  it('reports a failed first poll as a failure, on a call that otherwise succeeded', async () => {
    mockSaveResponse({ plane: 'central', indexed: 'error' });
    const res = await saveSystemCredentials('central', { clientId: 'a', clientSecret: 'b' });
    // The HTTP call succeeded — the credentials really were stored — so this
    // is not `ok: false`. But the plane rejected them, and a bare "saved" over
    // that is the whole failure this screen exists to surface, worded as its
    // opposite.
    expect(res.ok).toBe(true);
    expect(res.indexed).toBe('error');
    expect(res.message).toMatch(/the first poll failed/);
  });

  it('says nothing has been read yet when no poll ran at all', async () => {
    mockSaveResponse({ plane: 'classic', indexed: 'skipped' });
    const res = await saveSystemCredentials('classic', { host: 'sw-01.example.test' });
    expect(res.indexed).toBe('skipped');
    // A plane with no adapter stores its credentials and reads nothing. Left
    // to the generic wording it would be indistinguishable from one that did.
    expect(res.message).toMatch(/no poll ran/);
  });

  it('does not round a poll it stopped waiting for up to an outcome', async () => {
    mockSaveResponse({ plane: 'aos8', indexed: 'pending' });
    const res = await saveSystemCredentials('aos8', { master: '10.48.0.10:4343' });
    expect(res.indexed).toBe('pending');
    // Still running is neither indexed nor failed. The message says which of
    // the three it is and where the answer will appear, because the operator
    // is the one who decides whether to go and look.
    expect(res.message).toMatch(/still running/);
    expect(res.message).not.toMatch(/indexed|failed/);
  });

  it('claims only the save when the reply body cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected end of JSON input')),
      }),
    );
    const res = await saveSystemCredentials('clearpass', { host: 'cppm.example.test' });
    expect(res.ok).toBe(true);
    expect(res.indexed).toBeUndefined();
    expect(res.message).toBe('credentials saved');
    // No outcome is invented from a body that was never read.
    expect(res.message).not.toMatch(/index|poll/);
  });

  it('an unreadable body is not the same as a failed save', async () => {
    // Over-application guard: the caution above applies to the outcome of the
    // poll, not to whether the request succeeded. A 500 is still a failure.
    mockSaveResponse({ error: 'settings write failed' }, false);
    const res = await saveSystemCredentials('clearpass', { host: 'cppm.example.test' });
    expect(res.ok).toBe(false);
  });
});
