/**
 * downloadApiCsv — blob download helper (no body logging).
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../api/core', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args) as Promise<Response>,
}));

import { downloadApiCsv } from './downloadApiCsv';

describe('downloadApiCsv', () => {
  const click = vi.fn();
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createElementSpy: any;

  beforeEach(() => {
    apiFetch.mockReset();
    click.mockReset();
    createObjectURL = vi.fn(() => 'blob:mock');
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag === 'a') {
        return { href: '', download: '', click } as unknown as HTMLAnchorElement;
      }
      return document.createElement(tag);
    }) as typeof document.createElement);
  });

  afterEach(() => {
    createElementSpy.mockRestore();
  });

  it('downloads blob with Content-Disposition filename', async () => {
    const blob = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
    apiFetch.mockResolvedValue(
      new Response(blob, {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="tickets.csv"',
        },
      }),
    );
    const result = await downloadApiCsv('/api/tickets/export', 'fallback.csv');
    expect(result).toEqual({ ok: true });
    expect(apiFetch).toHaveBeenCalledWith('/api/tickets/export');
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    const anchor = createElementSpy.mock.results[0]?.value as HTMLAnchorElement;
    expect(anchor.download).toBe('tickets.csv');
  });

  it('prefers RFC 5987 filename* over plain filename (Loop 103)', async () => {
    const blob = new Blob(['a'], { type: 'text/csv' });
    apiFetch.mockResolvedValue(
      new Response(blob, {
        status: 200,
        headers: {
          'content-disposition':
            "attachment; filename=\"plain.csv\"; filename*=UTF-8''utf8-name.csv",
        },
      }),
    );
    const result = await downloadApiCsv('/api/tickets/export', 'fallback.csv');
    expect(result.ok).toBe(true);
    const anchor = createElementSpy.mock.results[0]?.value as HTMLAnchorElement;
    expect(anchor.download).toBe('utf8-name.csv');
  });

  it('uses fallback name when disposition missing', async () => {
    apiFetch.mockResolvedValue(new Response(new Blob(['x']), { status: 200 }));
    const result = await downloadApiCsv('/api/alerts/export', 'alerts-queue.csv');
    expect(result.ok).toBe(true);
    const anchor = createElementSpy.mock.results[0]?.value as HTMLAnchorElement;
    expect(anchor.download).toBe('alerts-queue.csv');
  });

  it('returns error on non-OK without throwing', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    const result = await downloadApiCsv('/api/tickets/export', 'tickets.csv');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
    expect(click).not.toHaveBeenCalled();
  });

  it('returns error on network failure', async () => {
    apiFetch.mockRejectedValue(new Error('offline'));
    const result = await downloadApiCsv('/api/tickets/export', 'tickets.csv');
    expect(result).toEqual({ ok: false, error: 'offline' });
  });
});
