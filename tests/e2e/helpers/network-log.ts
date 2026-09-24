// Every network request and console message from every Chromium target: the extension's service worker, its
// offscreen document, extension pages (side panel, options, review) and web pages with the content script, plus
// their workers and frames. Used by the privacy proof (tests/e2e/privacy.spec.ts, PRD P0-15).
//
// Playwright's own request events miss the service worker and the offscreen document, so this connects a second
// DevTools client over --remote-debugging-port, auto-attaches to every target (pausing each new one until its
// Network domain is on), and records Network.requestWillBeSent and Network.webSocketCreated. Requests the browser
// process makes for itself (component updates and the like) have no target and are not the extension's.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ObservedRequest {
  url: string;
  kind: 'http' | 'websocket';
  target: { type: string; url: string };
  at: number;
}

export interface ObservedConsole {
  text: string;
  target: { type: string; url: string };
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/** A command's reply: `result` is the method's own return value. */
interface CdpReply<R = Record<string, unknown>> {
  id: number;
  result: R;
}

/** The events this log reads; the browser sends others too, which fall through. */
type CdpEvent = { id?: undefined; sessionId?: string } & (
  | {
      method: 'Target.attachedToTarget';
      params: { sessionId: string; targetInfo: TargetInfo; waitingForDebugger: boolean };
    }
  | { method: 'Target.targetInfoChanged'; params: { targetInfo: TargetInfo } }
  | { method: 'Network.requestWillBeSent'; params: { requestId: string; request: { url: string } } }
  | { method: 'Network.webSocketCreated'; params: { requestId: string; url: string } }
  | {
      method: 'Runtime.consoleAPICalled';
      params: { args?: { value?: unknown; description?: string; preview?: unknown }[] };
    }
  | { method: 'Runtime.exceptionThrown'; params: { exceptionDetails: unknown } }
  | { method: 'Log.entryAdded'; params: { entry: { text: string; url?: string } } }
);

export class NetworkLog {
  readonly requests: ObservedRequest[] = [];
  readonly console: ObservedConsole[] = [];
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, (v: unknown) => void>();
  private sessions = new Map<string, TargetInfo>();
  private attaching = new Set<string>();
  /** A target can be attached more than once (auto-attach and an explicit attach): count each request once. */
  private seen = new Set<string>();

  private constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (m) => this.onMessage(JSON.parse(String(m.data)));
  }

  /** Connects to the browser through the DevToolsActivePort file Chromium writes into its profile. */
  static async attach(userDataDir: string): Promise<NetworkLog> {
    const file = join(userDataDir, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
    const [port, path] = readFileSync(file, 'utf8').trim().split('\n');
    const log = new NetworkLog(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((resolve, reject) => {
      log.ws.onopen = () => resolve();
      log.ws.onerror = (e) => reject(e);
    });
    await log.send('Target.setDiscoverTargets', { discover: true });
    await log.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // Targets that existed before this client connected (the service worker, open pages).
    const { targetInfos } = (await log.send('Target.getTargets')).result as { targetInfos: TargetInfo[] };
    for (const t of targetInfos) await log.attachTo(t);
    return log;
  }

  send<R = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<CdpReply<R>> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (v: unknown) => void);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** The session of the first attached target matching `pred`, e.g. the offscreen document. */
  sessionFor(pred: (t: { type: string; url: string }) => boolean): string | null {
    for (const [id, t] of this.sessions) if (pred(t)) return id;
    return null;
  }

  targets(): { type: string; url: string }[] {
    return [...this.sessions.values()].map(({ type, url }) => ({ type, url }));
  }

  /** Runs `expression` in the target's main world (e.g. a fetch from the offscreen document). */
  async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const r = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  }

  close(): void {
    this.ws.close();
  }

  private async attachTo(t: TargetInfo) {
    if (t.type === 'browser' || t.type === 'tab' || this.attaching.has(t.targetId)) return;
    if ([...this.sessions.values()].some((s) => s.targetId === t.targetId)) return;
    this.attaching.add(t.targetId);
    await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  }

  private async init(sessionId: string, info: TargetInfo, waiting: boolean) {
    this.sessions.set(sessionId, info);
    await Promise.all([
      this.send('Network.enable', {}, sessionId),
      this.send('Runtime.enable', {}, sessionId),
      this.send('Log.enable', {}, sessionId),
      // Dedicated workers and out-of-process frames of this target.
      this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId),
    ]);
    if (waiting) await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  private first(target: TargetInfo | undefined, id: string): boolean {
    const key = `${target?.targetId ?? '?'}|${id}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private onMessage(d: CdpReply | CdpEvent) {
    if (d.id !== undefined) {
      this.pending.get(d.id)?.(d);
      this.pending.delete(d.id);
      return;
    }
    const target = d.sessionId ? this.sessions.get(d.sessionId) : undefined;
    const where = target ? { type: target.type, url: target.url } : { type: 'unknown', url: '' };
    switch (d.method) {
      case 'Target.attachedToTarget':
        void this.init(d.params.sessionId, d.params.targetInfo, d.params.waitingForDebugger);
        break;
      case 'Target.targetInfoChanged': {
        for (const [, t] of this.sessions)
          if (t.targetId === d.params.targetInfo.targetId) t.url = d.params.targetInfo.url;
        break;
      }
      case 'Network.requestWillBeSent':
        if (this.first(target, `r${d.params.requestId}`))
          this.requests.push({ url: d.params.request.url, kind: 'http', target: where, at: Date.now() });
        break;
      case 'Network.webSocketCreated':
        if (this.first(target, `w${d.params.requestId}`))
          this.requests.push({ url: d.params.url, kind: 'websocket', target: where, at: Date.now() });
        break;
      case 'Runtime.consoleAPICalled':
        this.console.push({
          text: (d.params.args ?? []).map((a) => a.value ?? a.description ?? JSON.stringify(a.preview ?? '')).join(' '),
          target: where,
        });
        break;
      case 'Runtime.exceptionThrown':
        this.console.push({ text: JSON.stringify(d.params.exceptionDetails), target: where });
        break;
      case 'Log.entryAdded':
        this.console.push({ text: `${d.params.entry.text} ${d.params.entry.url ?? ''}`, target: where });
        break;
      default:
        break;
    }
  }
}

/** Requests that left the machine for somewhere other than `allowedOrigins` (extension, data and blob URLs are local). */
export function outsiders(requests: readonly ObservedRequest[], allowedOrigins: readonly string[]): ObservedRequest[] {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).host));
  return requests.filter((r) => {
    const u = new URL(r.url);
    if (['chrome-extension:', 'data:', 'blob:', 'about:', 'chrome:', 'devtools:'].includes(u.protocol)) return false;
    return !allowed.has(u.host);
  });
}
