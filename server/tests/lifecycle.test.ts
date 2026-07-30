/**
 * server/tests/lifecycle.test.ts — shutdown must be honest about what it left
 * behind.
 *
 * The failure mode worth testing for is not "shutdown works" — it is shutdown
 * printing a clean exit while an SSH session to a production switch is still
 * open, or one failing step abandoning the ones after it.
 */

import { describe, expect, it, vi } from 'vitest';
import { installLifecycle, runShutdownSteps, type ShutdownStep } from '../src/services/lifecycle';

type Handlers = Record<string, (arg?: unknown) => void>;

function harness(steps: ShutdownStep[], timeoutMs = 1000) {
  const handlers: Handlers = {};
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const shutdown = installLifecycle({
    steps,
    timeoutMs,
    exit: (c) => exits.push(c),
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    on: (event, handler) => {
      handlers[event] = handler as (arg?: unknown) => void;
    },
  });
  return { handlers, logs, errors, exits, shutdown };
}

describe('runShutdownSteps', () => {
  it('runs every step even when an earlier one throws', async () => {
    // Promise.all would abandon the rest. An SSH session left open because the
    // HTTP close threw is a live shell belonging to nobody.
    const ran: string[] = [];
    const failed = await runShutdownSteps(
      [
        { name: 'first', run: () => { ran.push('first'); throw new Error('nope'); } },
        { name: 'second', run: () => { ran.push('second'); } },
        { name: 'third', run: async () => { ran.push('third'); } },
      ],
      () => {},
    );
    expect(ran).toEqual(['first', 'second', 'third']);
    expect(failed).toEqual(['first']);
  });

  it('reports nothing failed when nothing failed', async () => {
    expect(await runShutdownSteps([{ name: 'a', run: () => {} }], () => {})).toEqual([]);
  });
});

describe('installLifecycle', () => {
  it('runs the steps in order and exits zero', async () => {
    const order: string[] = [];
    const h = harness([
      { name: 'poller', run: () => { order.push('poller'); } },
      { name: 'shells', run: () => { order.push('shells'); } },
      { name: 'http', run: () => { order.push('http'); } },
    ]);
    await h.shutdown('test');
    expect(order).toEqual(['poller', 'shells', 'http']);
    expect(h.logs).toContain('shutdown complete');
    expect(h.exits).toEqual([0]);
  });

  it('never claims a clean shutdown when a step failed', async () => {
    const h = harness([
      { name: 'poller', run: () => {} },
      { name: 'terminal sessions', run: () => { throw new Error('socket stuck'); } },
    ]);
    await h.shutdown('test');
    expect(h.logs).not.toContain('shutdown complete');
    expect(h.errors.some((e) => e.includes('terminal sessions'))).toBe(true);
    expect(h.exits).toEqual([1]);
  });

  it('exits non-zero when a crash shutdown had a failing step, not the crash code twice', async () => {
    const h = harness([{ name: 'http', run: () => { throw new Error('x'); } }]);
    await h.shutdown('uncaught exception', 1);
    expect(h.exits).toEqual([1]);
  });

  it('SIGTERM and SIGINT both trigger shutdown', async () => {
    const ran: string[] = [];
    const h = harness([{ name: 'a', run: () => { ran.push('a'); } }]);
    h.handlers.SIGTERM();
    await vi.waitFor(() => expect(h.exits).toEqual([0]));
    expect(ran).toEqual(['a']);
  });

  it('a second signal stops waiting and exits immediately', async () => {
    let release: () => void = () => {};
    const h = harness([{ name: 'slow', run: () => new Promise<void>((r) => (release = r)) }]);
    void h.shutdown('SIGINT');
    await Promise.resolve();
    await h.shutdown('SIGINT');
    expect(h.errors.some((e) => e.includes('second SIGINT'))).toBe(true);
    expect(h.exits).toEqual([1]);
    release();
  });

  it('stops waiting after the timeout and says so rather than hanging', async () => {
    const h = harness([{ name: 'hung', run: () => new Promise<void>(() => {}) }], 20);
    void h.shutdown('SIGTERM');
    await vi.waitFor(() => expect(h.errors.some((e) => e.includes('did not finish'))).toBe(true));
    expect(h.exits).toEqual([1]);
    // And it must not later announce a clean finish behind the operator's back.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.logs).not.toContain('shutdown complete');
  });

  it('treats an uncaught exception as fatal, naming it, and exits non-zero', async () => {
    // The process state is unknown after this. A server that brokers writes to
    // production switches must not keep accepting them from there.
    const ran: string[] = [];
    const h = harness([{ name: 'a', run: () => { ran.push('a'); } }]);
    h.handlers.uncaughtException(new Error('boom'));
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(h.errors.some((e) => e.includes('FATAL uncaught exception') && e.includes('boom'))).toBe(true);
    expect(ran).toEqual(['a']); // still torn down cleanly on the way out
  });

  it('treats an unhandled rejection as fatal too, including a non-Error reason', async () => {
    const h = harness([{ name: 'a', run: () => {} }]);
    h.handlers.unhandledRejection('just a string');
    await vi.waitFor(() => expect(h.exits).toEqual([1]));
    expect(h.errors.some((e) => e.includes('FATAL unhandled promise rejection') && e.includes('just a string'))).toBe(true);
  });
});
