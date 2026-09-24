// An agent's side of the host's /mcp, as little of MCP over Streamable HTTP as the e2e needs: initialize, then
// tools/call. A reply arrives as JSON or as a server-sent event stream; either way it is the JSON-RPC response with
// the request's id. An agent on another machine (network mode, ADR 0006) sends its agent token.
const PROTOCOL = '2025-06-18';

export interface ToolResult {
  isError?: boolean;
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
}

export class McpClient {
  private nextId = 1;
  private constructor(
    private readonly url: string,
    private readonly session: string | null,
    private readonly token: string | null,
  ) {}

  static async connect(hostUrl: string, token: string | null = null): Promise<McpClient> {
    const url = `${hostUrl}/mcp`;
    const init = await McpClient.post(url, null, token, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'inkup-e2e', version: '1' } },
    });
    const client = new McpClient(url, init.headers.get('mcp-session-id'), token);
    await McpClient.reply(init, 0);
    await McpClient.post(url, client.session, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    return client;
  }

  /** A tool's result; `json()` reads a text answer. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const id = this.nextId++;
    const res = await McpClient.post(this.url, this.session, this.token, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const reply = (await McpClient.reply(res, id)) as { result?: ToolResult; error?: { message: string } };
    if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
    return reply.result!;
  }

  async json<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.call(name, args);
    const text = result.content.find((c) => c.type === 'text');
    if (result.isError || !text || text.type !== 'text')
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    return JSON.parse(text.text) as T;
  }

  private static async post(
    url: string,
    session: string | null,
    token: string | null,
    body: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
    };
    if (session) headers['mcp-session-id'] = session;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`POST /mcp: ${res.status} ${await res.text()}`);
    return res;
  }

  private static async reply(res: Response, id: number): Promise<unknown> {
    const text = await res.text();
    if (!res.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(text);
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      const message = JSON.parse(data) as { id?: number };
      if (message.id === id) return message;
    }
    throw new Error(`no reply to request ${id} in: ${text}`);
  }
}
