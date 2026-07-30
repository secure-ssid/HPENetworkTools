/**
 * server/src/services/lifecycle.ts — shutdown and crash handling.
 *
 * This process holds things that do not clean themselves up: SSH sessions to
 * production switches, append-only audit files mid-write, and a poll loop
 * making vendor calls. Before this module the process had no SIGTERM handler,
 * no SIGINT handler beyond Node's default, and no unhandled-rejection or
 * uncaught-exception handling at all — a deploy restart or a stray Ctrl-C tore
 * all of it down mid-flight.
 *
 * Three positions worth stating, because each could reasonably go the other
 * way:
 *
 * **A crash is fatal, not survivable.** An uncaught exception or unhandled
 * rejection leaves the process in a state nobody reasoned about. A server that
 * brokers configuration writes to production network equipment must not keep
 * accepting them from there; the honest move is to say what happened, shut
 * down what can be shut down, and exit non-zero so a supervisor restarts into
 * a known state. Swallowing it would buy uptime by hiding the reason.
 *
 * **Shutdown reports what it could not close.** Each step is awaited
 * individually and a step that throws or hangs is named on stderr. A teardown
 * that prints "shutdown complete" while an SSH session is still open would be
 * the same class of lie the rest of this codebase works to avoid.
 *
 * **A second signal stops waiting.** An operator pressing Ctrl-C twice means
 * it. The second one exits immediately rather than politely queueing behind a
 * step that is evidently stuck.
 */

export interface ShutdownStep {
  /** Named in the log, including when it fails — so pick something diagnosable. */
  name: string;
  run: () => void | Promise<void>;
}

export interface LifecycleOptions {
  steps: ShutdownStep[];
  /** How long the whole teardown may take before we stop waiting for it. */
  timeoutMs?: number;
  /** Seams for tests; default to the real process. */
  exit?: (code: number) => void;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  on?: (event: string, handler: (...args: never[]) => void) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Run every step, giving each its own chance to fail.
 *
 * Deliberately not Promise.all: one step rejecting must not abandon the
 * others. An SSH session left open because the HTTP server's close threw is a
 * live shell on a production switch belonging to nobody.
 *
 * Returns the names of the steps that did not complete cleanly.
 */
export async function runShutdownSteps(
  steps: ShutdownStep[],
  error: (msg: string) => void = (m) => console.error(m),
): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failed.push(step.name);
      error(`shutdown step '${step.name}' failed: ${(err as Error).message}`);
    }
  }
  return failed;
}

/**
 * Install signal and crash handlers.
 *
 * Returns the shutdown function so a caller (or a test) can invoke it directly
 * without raising a signal.
 */
export function installLifecycle(opts: LifecycleOptions): (reason: string, code?: number) => Promise<void> {
  const {
    steps,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    exit = (code: number) => process.exit(code),
    log = (m: string) => console.log(m),
    error = (m: string) => console.error(m),
    on = (event, handler) => process.on(event, handler as (...args: unknown[]) => void),
  } = opts;

  let shuttingDown = false;

  async function shutdown(reason: string, code = 0): Promise<void> {
    if (shuttingDown) {
      // Already tearing down and asked again: the operator is telling us the
      // polite path is taking too long. Believe them.
      error(`second ${reason} during shutdown — exiting now`);
      exit(code === 0 ? 1 : code);
      return;
    }
    shuttingDown = true;
    log(`shutting down (${reason})`);

    let timedOut = false;
    const guard = setTimeout(() => {
      timedOut = true;
      error(`shutdown did not finish within ${Math.round(timeoutMs / 1000)}s — exiting anyway`);
      exit(code === 0 ? 1 : code);
    }, timeoutMs);
    // A pending timer must not be the reason the process stays alive.
    guard.unref?.();

    const failed = await runShutdownSteps(steps, error);
    clearTimeout(guard);
    if (timedOut) return;

    if (failed.length > 0) {
      error(`shutdown finished with ${failed.length} step(s) incomplete: ${failed.join(', ')}`);
      exit(code === 0 ? 1 : code);
      return;
    }
    log('shutdown complete');
    exit(code);
  }

  on('SIGTERM', () => void shutdown('SIGTERM'));
  on('SIGINT', () => void shutdown('SIGINT'));

  on('uncaughtException', ((err: Error) => {
    error(`FATAL uncaught exception: ${err?.stack ?? String(err)}`);
    void shutdown('uncaught exception', 1);
  }) as never);

  on('unhandledRejection', ((reason: unknown) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    error(`FATAL unhandled promise rejection: ${detail}`);
    void shutdown('unhandled rejection', 1);
  }) as never);

  return shutdown;
}
