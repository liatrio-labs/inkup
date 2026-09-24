// The real host binary (host/, built by `pnpm host:build`, which `pnpm test:e2e` runs) as a child process: `inkup serve --data-dir <dir>
// --auto-approve-pairing`. It prints its address as the first stdout line; port 0 picks a free one, and a restart
// passes the old port so the paired extension finds it again.
//
// In network mode (ADR 0006) it listens on every interface and prints each pairing code for another machine as a
// `pairing code: NNNNNN` line; the tests reach it on this machine's LAN address, which the host counts as remote.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type Worker } from '@playwright/test';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// CARGO_TARGET_DIR (honoured by `pnpm host:build`) lets several checkouts share one host build.
export const HOST_BIN = join(
  resolve(ROOT, 'host', process.env.CARGO_TARGET_DIR ?? 'target'),
  'debug',
  process.platform === 'win32' ? 'inkup.exe' : 'inkup',
);

export class HostProcess {
  /** The pairing codes printed so far (network mode), oldest first. */
  readonly codes: string[] = [];

  private constructor(
    private readonly child: ChildProcess,
    readonly url: string,
    readonly port: number,
    readonly dataDir: string,
  ) {}

  /** `network`: listen on the LAN too, claiming `<mdnsName>.local` rather than the real `inkup.local`. */
  static async start(
    dataDir: string,
    port = 0,
    { network }: { network?: { mdnsName: string } } = {},
  ): Promise<HostProcess> {
    const args = ['serve', '--data-dir', dataDir, '--port', String(port), '--auto-approve-pairing'];
    if (network) args.push('--network', '--print-pairing-codes', '--mdns-name', network.mdnsName);
    const child = spawn(HOST_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'warn' },
    });
    const stderr: string[] = [];
    child.stderr!.on('data', (d: Buffer) => stderr.push(d.toString()));
    const lines = createInterface({ input: child.stdout! });
    const line = await new Promise<string>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`host did not start: ${stderr.join('')}`)), 15_000);
      child.once('exit', (code) => rej(new Error(`host exited ${code}: ${stderr.join('')}`)));
      lines.once('line', (l) => {
        clearTimeout(timer);
        res(l);
      });
    });
    const url = line.match(/http:\/\/\S+/)?.[0];
    if (!url) throw new Error(`unexpected first line from the host: ${line}`);
    const host = new HostProcess(child, url, Number(new URL(url).port), dataDir);
    lines.on('line', (l) => {
      const code = /^pairing code: (\d{6})$/.exec(l)?.[1];
      if (code) host.codes.push(code);
    });
    return host;
  }

  /** The next pairing code the host prints after `seen` codes. */
  async nextCode(seen: number): Promise<string> {
    await expect
      .poll(() => this.codes.length, { message: 'the host prints a pairing code', timeout: 15_000 })
      .toBeGreaterThan(seen);
    return this.codes[seen]!;
  }

  /** `inkup token create`: an agent token, made on the host's data dir. */
  createAgentToken(name: string): string {
    return execFileSync(HOST_BIN, ['token', 'create', '--name', name, '--data-dir', this.dataDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** Kills the process outright (no graceful shutdown), as a crash would. */
  async kill(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((r) => this.child.once('exit', r));
    this.child.kill('SIGKILL');
    await exited;
  }

  /** GET on the read API with the pairing token. */
  async get<T>(path: string, token: string): Promise<T> {
    const res = await fetch(`${this.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  /** POST JSON with the pairing token; the answer's status and body. */
  async post<T>(path: string, token: string, body: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
  }

  async blob(id: string, token: string): Promise<{ status: number; type: string | null; bytes: number }> {
    const res = await fetch(`${this.url}/blobs/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      bytes: res.ok ? (await res.arrayBuffer()).byteLength : 0,
    };
  }
}

/** This machine's first LAN IPv4 address: a connection to it reaches the host as from another machine. */
export function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? [])
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
  }
  return null;
}

export function tempDataDir(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'var-host-'));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/**
 * Pairs the extension with `host` through Settings, as a reviewer would (the host auto-approves). Returns the options
 * page and the token the extension stored.
 */
export async function pairThroughOptions(
  sw: Worker,
  openExtensionPage: (path: string) => Promise<Page>,
  host: HostProcess,
): Promise<{ options: Page; token: string }> {
  await sw.evaluate((url) => chrome.storage.local.set({ hostUrl: url }), host.url);
  const options = await openExtensionPage('options.html');
  await options.getByTestId('host-other-address').click();
  await expect(options.getByTestId('host-url')).toHaveValue(host.url);
  await options.getByTestId('host-pair').click();
  await expect(options.getByTestId('host-status')).toHaveAttribute('data-state', 'connected');
  const token = await sw.evaluate(
    async () => ((await chrome.storage.local.get('hostPairing')).hostPairing as { token: string }).token,
  );
  return { options, token };
}
