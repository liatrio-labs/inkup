// @vitest-environment node
// The fixture site is the representative sample data for every later proof; pin its load-bearing shapes.
import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServers, startFixtureServers } from '../../scripts/fixture-server.ts';

let servers: FixtureServers;
beforeAll(async () => {
  servers = await startFixtureServers(4501, 4502);
});
afterAll(() => servers.close());

async function load(url: string) {
  const res = await fetch(url);
  expect(res.status).toBe(200);
  const win = new Window();
  return new win.DOMParser().parseFromString(await res.text(), 'text/html') as unknown as Document;
}

describe('fixture site', () => {
  it('pricing.html has the elements later slices annotate', async () => {
    const doc = await load(`${servers.primaryOrigin}/pricing.html`);
    const nav = doc.querySelector('header nav');
    expect([...nav!.querySelectorAll('a')].map((a) => a.textContent)).toContain('Docs');
    const cta = doc.querySelector('.hero .card button.cta');
    expect(cta?.textContent).toBe('Get started');
    expect(doc.querySelectorAll('.plans .card')).toHaveLength(2);
    const frame = doc.querySelector<HTMLIFrameElement>('iframe#partner-frame');
    expect(new URL(frame!.getAttribute('src')!).origin).toBe(servers.secondOrigin);
    const link = doc.querySelector<HTMLAnchorElement>('a#second-origin-link');
    expect(new URL(link!.getAttribute('href')!).origin).toBe(servers.secondOrigin);
  });

  it('plan cards have different declared heights', async () => {
    const css = await (await fetch(`${servers.primaryOrigin}/styles.css`)).text();
    const basic = /#plan-basic\s*{\s*height:\s*(\d+)px/.exec(css)?.[1];
    const pro = /#plan-pro\s*{\s*height:\s*(\d+)px/.exec(css)?.[1];
    expect(basic).toBeDefined();
    expect(basic).not.toBe(pro);
  });

  it('serves the second origin on a different host and port', async () => {
    expect(new URL(servers.secondOrigin).hostname).not.toBe(new URL(servers.primaryOrigin).hostname);
    const doc = await load(`${servers.secondOrigin}/second/embed.html`);
    expect(doc.querySelector('button.partner-action')).not.toBeNull();
  });
});
