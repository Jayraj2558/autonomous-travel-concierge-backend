/**
 * Server-test support — every suite gets an API without the developer having to
 * start one by hand, and never touches a server it did not start.
 *
 *   1. `API_BASE` set            → test exactly that server, never spawn
 *   2. a dev API on :4000 alive  → use it
 *   3. otherwise                 → boot a private instance on a free port, stop it after
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..', '..');

/**
 * @param {object} [options]
 * @returns {Promise<{ base: string, spawned: import('node:child_process').ChildProcess | null, reused: boolean }>}
 */
export async function ensureApi({ devPort = 4000, timeoutMs = 25000 } = {}) {
  if (process.env.API_BASE) {
    return { base: process.env.API_BASE.replace(/\/$/, ''), spawned: null, reused: true };
  }

  const devBase = `http://127.0.0.1:${devPort}`;
  if (await healthy(devBase)) return { base: devBase, spawned: null, reused: true };

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.env.VERBOSE && process.stdout.write(`[api] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stdout.write(`[api:err] ${chunk}`));

  const kill = () => !child.killed && child.kill('SIGKILL');
  process.once('exit', kill);
  process.once('SIGINT', () => {
    kill();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    kill();
    process.exit(143);
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(base)) return { base, spawned: child, reused: false };
    await sleep(250);
  }

  kill();
  throw new Error(`The API did not become healthy on ${base} within ${timeoutMs} ms`);
}

export async function stopApi(handle) {
  const child = handle && typeof handle.kill === 'function' ? handle : handle?.spawned;
  if (!child) return;
  child.kill('SIGTERM');
  await sleep(400);
  child.kill('SIGKILL');
}

async function healthy(base) {
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
