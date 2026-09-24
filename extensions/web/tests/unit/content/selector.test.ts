import { beforeEach, describe, expect, it } from 'vitest';
import { resolveSelector, selectorFor, structuralPath } from '@/content/selector';
import { snapshotElement } from '@/content/snapshot';

const $ = (sel: string) => document.querySelector(sel)!;
const resolves = (el: Element) => {
  const sel = selectorFor(el);
  expect(document.querySelectorAll(sel)).toHaveLength(1);
  expect(document.querySelector(sel)).toBe(el);
  return sel;
};

describe('selectorFor', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <header class="site-header"><nav aria-label="Main"><a href="/">Home</a><a href="/docs.html">Docs</a></nav></header>
      <main>
        <section class="hero"><div class="card hero-card"><p>Start</p><button class="cta" type="button">Get started</button></div></section>
        <section class="plans">
          <div class="card" id="plan-basic"><h2>Basic</h2></div>
          <div class="card css-1x2y3z Card_root__a1b2c"><h2>Pro</h2></div>
          <div class="p-4 flex hover:bg-blue-500 w-[12px]" data-testid="promo"><span class="text-sm font-bold">Promo</span></div>
          <div class="p-4 flex"><span class="text-sm">Other</span></div>
          <button id="radix-:r3:">Menu</button>
          <button id="ember1234">More</button>
        </section>
      </main>`;
  });

  it('prefers a meaningful class over a bare tag: button.cta', () => {
    expect(resolves($('button.cta'))).toBe('button.cta');
  });

  it('prefers data-testid, then a unique human id', () => {
    expect(resolves($('[data-testid="promo"]'))).toBe('[data-testid="promo"]');
    expect(resolves($('#plan-basic'))).toBe('#plan-basic');
  });

  it('never uses hashed CSS-in-JS / CSS-module classes or Tailwind utilities', () => {
    const pro = document.querySelectorAll('.plans .card')[1]!;
    const sel = resolves(pro);
    expect(sel).not.toMatch(/css-1x2y3z|Card_root__a1b2c/);
    const other = document.querySelectorAll('.plans .p-4')[1]!.querySelector('span')!;
    expect(resolves(other)).not.toMatch(/\.p-4|\.flex|\.text-sm/);
  });

  it('never uses generated ids', () => {
    expect(resolves(document.querySelectorAll('.plans button')[0]!)).not.toContain('radix');
    expect(resolves(document.querySelectorAll('.plans button')[1]!)).not.toContain('ember1234');
  });

  it('uses whitelisted attributes such as href', () => {
    expect(resolves($('a[href="/docs.html"]'))).toMatch(/href|nth-of-type/);
  });

  it('structural fallback is always unique', () => {
    const el = document.querySelectorAll('.plans h2')[1]!;
    const sel = structuralPath(el);
    expect(sel.startsWith('html > body > main')).toBe(true);
    expect(document.querySelector(sel)).toBe(el);
  });
});

describe('selectorFor: test attributes and shadow roots (E2)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <button class="cta" data-test="buy">Buy</button>
        <button class="cta" data-cy="cart" data-qa="ignored">Cart</button>
        <button class="cta" data-qa="help">Help</button>
        <button class="cta" data-testid="dup" data-test="dup-test">One</button>
        <button class="cta" data-testid="dup">Two</button>
        <promo-card id="promo"></promo-card>
        <promo-card></promo-card>
      </main>`;
    for (const host of document.querySelectorAll('promo-card')) {
      host.attachShadow({
        mode: 'open',
      }).innerHTML = `<div class="body"><p>Deal</p><button class="go" data-testid="go">Go</button><span class="note">Note</span></div>`;
    }
  });

  it('uses data-test, data-cy and data-qa like data-testid, in that order', () => {
    const [buy, cart, help] = document.querySelectorAll('main > button');
    expect(selectorFor(buy!)).toBe('[data-test="buy"]');
    expect(selectorFor(cart!)).toBe('[data-cy="cart"]');
    expect(selectorFor(help!)).toBe('[data-qa="help"]');
  });

  it('skips a test attribute that is not unique for the next one', () => {
    const one = document.querySelectorAll('[data-testid="dup"]')[0]!;
    expect(selectorFor(one)).toBe('[data-test="dup-test"]');
  });

  it("joins a shadow host's selector to one inside its shadow root, and resolves it back", () => {
    const [first, second] = [...document.querySelectorAll('promo-card')].map((h) => h.shadowRoot!);
    const go = first!.querySelector('button')!;
    expect(selectorFor(go)).toBe('#promo >>> [data-testid="go"]');
    expect(resolveSelector(selectorFor(go))).toBe(go);
    const note = second!.querySelector('.note')!;
    const sel = selectorFor(note);
    expect(sel).toMatch(/^.+ >>> .+$/);
    expect(sel.split(' >>> ')[0]).not.toBe('#promo');
    expect(resolveSelector(sel)).toBe(note);
  });

  it('resolveSelector gives null for a selector that names nothing or is invalid', () => {
    expect(resolveSelector('#nope >>> button')).toBeNull();
    expect(resolveSelector('main >>> button')).toBeNull();
    expect(resolveSelector('[[')).toBeNull();
  });

  it('snapshotElement describes a picked element inside a shadow root, its depth counted through the host', () => {
    const go = document.querySelector('#promo')!.shadowRoot!.querySelector('button')!;
    expect(snapshotElement(go)).toMatchObject({
      key: 'e0',
      parent: null,
      tag: 'button',
      selector: '#promo >>> [data-testid="go"]',
      testid: 'go',
      depth: 5,
      stroke_hit: false,
    });
    expect(snapshotElement(document.querySelector('[data-cy="cart"]')!).testid).toBe('cart');
  });
});
