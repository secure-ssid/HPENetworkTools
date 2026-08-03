import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface McpLaunchConfigInput {
  endpoint: string;
  authToken: string | null;
  /** Test-only parent directory. Production uses the OS temporary directory. */
  baseDir?: string;
}

export interface McpLaunchConfig {
  path: string;
  directory: string;
  dispose(): Promise<void>;
}

export interface McpLaunchConfigDependencies {
  mkdtemp?: (prefix: string) => Promise<string>;
  writeFile?: (path: string, data: string, options: { encoding: BufferEncoding; mode: number }) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  rm?: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
}

function centralMcpConfig(input: McpLaunchConfigInput): object {
  const server: Record<string, unknown> = { type: 'streamable-http', url: input.endpoint };
  if (input.authToken) server.headers = { Authorization: `Bearer ${input.authToken}` };
  return { mcpServers: { centralmcp: server } };
}

/**
 * Creates the only MCP configuration a native provider may receive. It is
 * owner-readable only and deliberately disposable: callers must dispose it in
 * a finally block around each provider invocation.
 */
export async function createMcpLaunchConfig(
  input: McpLaunchConfigInput,
  dependencies: McpLaunchConfigDependencies = {},
): Promise<McpLaunchConfig> {
  const mkdtemp = dependencies.mkdtemp ?? fs.mkdtemp;
  const writeFile = dependencies.writeFile ?? fs.writeFile;
  const unlink = dependencies.unlink ?? fs.unlink;
  const rm = dependencies.rm ?? fs.rm;
  const directory = await mkdtemp(join(input.baseDir ?? tmpdir(), 'hpe-centralmcp-'));
  const path = join(directory, 'centralmcp.json');
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // The directory removal below is still required when unlink fails.
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  try {
    await writeFile(path, JSON.stringify(centralMcpConfig(input)), { encoding: 'utf8', mode: 0o600 });
    return { path, directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
