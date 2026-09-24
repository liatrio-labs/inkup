import { describe, expect, it } from 'vitest';
import { targetMode } from '../src/target';

const OWN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describe('what a Session can do on a URL (U5)', () => {
  it('web pages and local files get the drawing overlay', () => {
    expect(targetMode('https://example.com/a', OWN)).toBe('page');
    expect(targetMode('http://localhost:4401/pricing.html', OWN)).toBe('page');
    expect(targetMode('file:///tmp/x.html', OWN)).toBe('page');
  });

  it('our own review, Sessions, options and onboarding pages get the overlay, mounted by the page itself', () => {
    for (const p of ['review.html?session=1', 'sessions.html', 'options.html', 'onboarding.html'])
      expect(targetMode(`${OWN}/${p}`, OWN)).toBe('own_page');
  });

  it('our side panel and offscreen document are never a target', () => {
    expect(targetMode(`${OWN}/sidepanel.html`, OWN)).toBe('not_a_target');
    expect(targetMode(`${OWN}/offscreen.html`, OWN)).toBe('not_a_target');
  });

  it("other extensions' pages, chrome:// pages and the Web Store get a Session with no overlay", () => {
    expect(targetMode('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/options.html', OWN)).toBe('no_overlay');
    expect(targetMode('chrome://extensions/', OWN)).toBe('no_overlay');
    expect(targetMode('chrome://newtab/', OWN)).toBe('no_overlay');
    expect(targetMode('https://chromewebstore.google.com/detail/x', OWN)).toBe('no_overlay');
    expect(targetMode('about:blank', OWN)).toBe('no_overlay');
  });

  it('a tab with no URL, devtools or view-source is not a target', () => {
    expect(targetMode(undefined, OWN)).toBe('not_a_target');
    expect(targetMode('', OWN)).toBe('not_a_target');
    expect(targetMode('devtools://devtools/bundled/inspector.html', OWN)).toBe('not_a_target');
    expect(targetMode('view-source:https://example.com', OWN)).toBe('not_a_target');
  });
});
