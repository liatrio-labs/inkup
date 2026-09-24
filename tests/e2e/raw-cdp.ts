// Kept from Slice 0 for later hidden-page tests (e.g. Slice 4 panel video). Minimal Chrome DevTools Protocol client for
// what Playwright cannot do: Playwright keeps every page it attaches to "visible", so a hidden-document test must drive Chromium itself.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

/** A command's reply: `result` is the method's own return value. */
export interface CdpReply<R = Record<string, unknown>> {
  id: number;
  result: R;
}

export class CdpSession {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, (v: unknown) => void>();
  readonly ready: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id) this.pending.get(d.id)?.(d);
    };
    this.ready = new Promise((r) => (this.ws.onopen = () => r()));
  }
  send<R = Record<string, unknown>>(method: string, params: object = {}): Promise<CdpReply<R>> {
    const id = ++this.seq;
    return new Promise((r) => {
      this.pending.set(id, r as (v: unknown) => void);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T>(expression: string, userGesture = false): Promise<T> {
    const res = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value as T;
  }
  close() {
    this.ws.close();
  }
}

export class RawChromium {
  private constructor(
    private proc: ChildProcess,
    private port: number,
    private dir: string,
  ) {}

  static async launch(args: string[], port = 9300 + Math.floor(Math.random() * 500)): Promise<RawChromium> {
    const dir = mkdtempSync(join(tmpdir(), 'raw-cdp-'));
    // --no-sandbox as Playwright passes it by default (chromiumSandbox: false): Ubuntu 23.10+ (the CI runners)
    // blocks the unprivileged user namespaces Chromium's sandbox needs, and it then aborts at startup.
    const proc = spawn(
      chromium.executablePath(),
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${dir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        ...(process.env.HEADED ? [] : ['--headless']),
        ...args,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    const raw = new RawChromium(proc, port, dir);
    // Up to 30 s: a loaded machine can take that long to start Chromium.
    for (let i = 0; i < 300 && proc.exitCode === null; i++) {
      try {
        await raw.targets();
        return raw;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    raw.close();
    throw new Error(`Chromium did not expose CDP (exit ${proc.exitCode ?? 'none'}):\n${stderr}`);
  }

  async targets(): Promise<CdpTarget[]> {
    return (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json() as Promise<CdpTarget[]>;
  }

  /** Browser-level session (e.g. for the Extensions domain). */
  async browserSession(): Promise<CdpSession> {
    const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const s = new CdpSession(webSocketDebuggerUrl);
    await s.ready;
    return s;
  }

  async waitForTarget(pred: (t: CdpTarget) => boolean, timeoutMs = 10_000): Promise<CdpSession> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const t = (await this.targets()).find(pred);
      if (t) {
        const s = new CdpSession(t.webSocketDebuggerUrl);
        await s.ready;
        return s;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('target not found');
  }

  async extensionServiceWorker(name: string, timeoutMs = 10_000): Promise<{ session: CdpSession; target: CdpTarget }> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      for (const target of (await this.targets()).filter((t) => t.type === 'service_worker')) {
        const session = new CdpSession(target.webSocketDebuggerUrl);
        await session.ready;
        // A worker that is still starting (or is not an extension's) has no `chrome` yet: skip it and poll again.
        const found = await session
          .evaluate<string>('globalThis.chrome?.runtime?.getManifest?.().name ?? null')
          .catch(() => null);
        if (found === name) return { session, target };
        session.close();
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no service worker for extension "${name}"`);
  }

  close() {
    this.proc.kill();
    // Chromium keeps writing its profile for a moment after the kill: retry ENOTEMPTY instead of failing the test.
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
