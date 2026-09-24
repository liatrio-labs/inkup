// A minimal client for Firefox's Remote Debugging Protocol (the one about:debugging uses). Playwright cannot open or
// script moz-extension:// pages in Firefox (docs/browsers.md "Testing"), so the Firefox e2e installs the add-on and
// scripts its pages through RDP, and drives the web pages under review with Playwright as usual.
import { connect, type Socket } from 'node:net';

type Packet = Record<string, unknown> & { from?: string; type?: string; error?: string; message?: string };

export class Rdp {
  private buf = Buffer.alloc(0);
  /** Replies arrive in request order per actor. */
  private pending = new Map<string, { resolve: (p: Packet) => void; reject: (e: Error) => void }[]>();
  private listeners = new Set<(p: Packet) => void>();
  private recent: Packet[] = [];
  /** Evaluation results by resultID, kept until claimed: closing a tab can send more than `recent` holds. */
  private results = new Map<string, Packet>();
  private resultWaiters = new Map<string, (p: Packet) => void>();
  private readonly sock: Socket;
  private constructor(sock: Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => this.onData(d));
  }

  static async connect(port: number, timeoutMs = 20_000): Promise<Rdp> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        const sock = await new Promise<Socket>((resolve, reject) => {
          const s = connect(port, '127.0.0.1', () => resolve(s));
          s.once('error', reject);
        });
        const rdp = new Rdp(sock);
        await rdp.next((p) => p.from === 'root' && 'applicationType' in p);
        return rdp;
      } catch (e) {
        if (Date.now() > until) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const colon = this.buf.indexOf(':');
      if (colon < 0) return;
      const len = Number(this.buf.subarray(0, colon).toString());
      if (this.buf.length < colon + 1 + len) return;
      const packet = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + len).toString()) as Packet;
      this.buf = this.buf.subarray(colon + 1 + len);
      if (packet.type === 'evaluationResult' && typeof packet.resultID === 'string') {
        const waiter = this.resultWaiters.get(packet.resultID);
        if (waiter) {
          this.resultWaiters.delete(packet.resultID);
          waiter(packet);
        } else this.results.set(packet.resultID, packet);
        continue;
      }
      // Events carry a `type`; replies do not (or carry the error). Recent packets are kept for next(): an event can
      // arrive in the same chunk as the reply that lets the caller know what to wait for.
      this.recent.push(packet);
      if (this.recent.length > 200) this.recent.shift();
      for (const l of [...this.listeners]) l(packet);
      if (packet.type && !packet.error) continue;
      const q = this.pending.get(packet.from ?? '');
      const waiter = q?.shift();
      if (!waiter) continue;
      if (packet.error) waiter.reject(new Error(`${packet.error}: ${packet.message ?? ''}`));
      else waiter.resolve(packet);
    }
  }

  request(to: string, type: string, args: Record<string, unknown> = {}): Promise<Packet> {
    return new Promise((resolve, reject) => {
      const q = this.pending.get(to) ?? [];
      q.push({ resolve, reject });
      this.pending.set(to, q);
      const s = JSON.stringify({ to, type, ...args });
      this.sock.write(`${Buffer.byteLength(s)}:${s}`);
    });
  }

  /** The first event matching `pred`, from the recent ones or the next to arrive. */
  next(pred: (p: Packet) => boolean, timeoutMs = 30_000): Promise<Packet> {
    const i = this.recent.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.recent.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        reject(new Error('RDP: timed out waiting for a packet'));
      }, timeoutMs);
      const l = (p: Packet) => {
        if (!pred(p)) return;
        this.recent.splice(this.recent.indexOf(p), 1);
        clearTimeout(timer);
        this.listeners.delete(l);
        resolve(p);
      };
      this.listeners.add(l);
    });
  }

  /** The `evaluationResult` event of an `evaluateJSAsync` call, which may have arrived before its reply was read. */
  evaluationResult(resultID: string, timeoutMs = 30_000): Promise<Packet> {
    const got = this.results.get(resultID);
    if (got) {
      this.results.delete(resultID);
      return Promise.resolve(got);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resultWaiters.delete(resultID);
        reject(new Error(`RDP: no evaluation result ${resultID}`));
      }, timeoutMs);
      this.resultWaiters.set(resultID, (p) => {
        clearTimeout(timer);
        resolve(p);
      });
    });
  }

  /** A primitive value from an evaluation result grip; long strings are fetched whole. Objects come back as null. */
  async grip(g: unknown): Promise<unknown> {
    if (g === null || typeof g !== 'object') return g;
    const o = g as { type?: string; actor?: string; length?: number };
    if (o.type === 'longString' && o.actor)
      return (await this.request(o.actor, 'substring', { start: 0, end: o.length })).substring;
    return null;
  }

  close() {
    this.sock.end();
  }
}
