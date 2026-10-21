// The example compose is what an operator copies. ADR 0030 ends TLS at a reverse proxy and does not
// advertise the Host's HTTP listen address, so publishing 47823 on every interface would send bearer
// tokens in cleartext. Comments are not publishes: a warning in one must not count as a mapping.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = resolve(import.meta.dirname, '../../docker/host-compose.example.yml');

/** Port specs from uncommented `ports:` lists. A full-line comment is not a published port. */
function publishedPortSpecs(yaml: string): string[] {
  const specs: string[] = [];
  let inPorts = false;
  for (const line of yaml.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^\s+ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    if (inPorts && /^\s+- /.test(line)) {
      specs.push(
        line
          .replace(/^\s+- /, '')
          .trim()
          .replace(/^["']|["']$/g, ''),
      );
      continue;
    }
    inPorts = false;
  }
  return specs;
}

/** Where a compose short syntax port listens. No address means every interface (0.0.0.0). */
function hostBind(spec: string): { address: string | null; containerPort: string } {
  const parts = spec.replace(/\/(tcp|udp)$/, '').split(':');
  if (parts.length === 1) return { address: null, containerPort: parts[0] };
  if (parts.length === 2) return { address: null, containerPort: parts[1] };
  if (parts.length === 3) return { address: parts[0], containerPort: parts[2] };
  throw new Error(`cannot read port spec ${spec}`);
}

describe('host compose example', () => {
  it('publishes the Host HTTP port on loopback only', () => {
    const http = publishedPortSpecs(readFileSync(COMPOSE, 'utf8'))
      .map(hostBind)
      .filter((port) => port.containerPort === '47823');
    expect(http).toEqual([{ address: '127.0.0.1', containerPort: '47823' }]);
  });

  it('treats a bare host port, and 0.0.0.0, as every interface', () => {
    expect(hostBind('47823:47823')).toEqual({ address: null, containerPort: '47823' });
    expect(hostBind('0.0.0.0:47823:47823')).toEqual({ address: '0.0.0.0', containerPort: '47823' });
    expect(hostBind('127.0.0.1:47823:47823')).toEqual({ address: '127.0.0.1', containerPort: '47823' });
  });

  it('does not count a port that is only in a comment', () => {
    const yaml = [
      'services:',
      '  host:',
      '    ports:',
      '      - "127.0.0.1:47823:47823"',
      '    # - "47823:47823"',
      '',
    ].join('\n');
    expect(publishedPortSpecs(yaml).map(hostBind)).toEqual([{ address: '127.0.0.1', containerPort: '47823' }]);
  });
});
