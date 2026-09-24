// E5: the page API round trip between the MAIN-world bridge (`window.__inkup`) and the isolated overlay, over
// the DOM (both worlds share it; here both run in one happy-dom window). The service worker is a stub.
import { describe, expect, it, vi } from 'vitest';
import { servePageApi } from '@/bridge/page-api';
import { PAGE_API_STATE } from '@/bridge/protocol';
import { serveSourceProbes } from '@/bridge/serve';
import { connectPageApi, type PageApiRequest, type PageApiResult, readNote } from '@/content/page-api';

type Api = {
  help(): string;
  status(): Promise<unknown>;
  annotate(selector: string, options: unknown): Promise<unknown>;
  list(): Promise<unknown>;
};
const api = () => (window as unknown as { __inkup?: Api }).__inkup;

servePageApi(window);
serveSourceProbes();
const send = vi.fn(
  async (req: PageApiRequest): Promise<PageApiResult> => ({
    ok: true,
    result: req.method === 'annotate' ? { annotation: 1, selector: req.input.selector } : { recording: true },
  }),
);
const link = connectPageApi(send, () => document.getElementById('overlay-host'));

describe('window.__inkup', () => {
  it('exists only while the overlay says this tab records a Session', () => {
    expect(api()).toBeUndefined();
    link.setEnabled(true);
    expect(typeof api()!.annotate).toBe('function');
    expect(api()!.help()).toContain('annotate(selector');
    link.setEnabled(false);
    expect(api()).toBeUndefined();
    expect('__inkup' in window).toBe(false);
  });

  it('annotate reads the element and asks the service worker', async () => {
    link.setEnabled(true);
    document.body.innerHTML =
      '<button id="cta" style="color: red">Get started</button><div id="overlay-host"><i id="ours"></i></div>';
    send.mockClear();
    await expect(
      api()!.annotate('#cta', {
        comment: 'Make it purple',
        styleChanges: { color: 'purple' },
        textChange: 'Start free',
      }),
    ).resolves.toEqual({ annotation: 1, selector: '#cta' });
    const req = send.mock.calls[0]![0];
    expect(req.method).toBe('annotate');
    if (req.method !== 'annotate') return;
    expect(req.input.note).toEqual({ comment: 'Make it purple' });
    // The changes, in the style_edit shape.
    expect(req.input.edit).toEqual({
      changes: { color: { from: 'red', to: 'purple' } },
      text: { from: 'Get started', to: 'Start free' },
    });
    expect(req.input.snapshots.map((s) => s.tag)).toContain('button');
    expect(req.input.page.url).toBe(location.href);
    link.setEnabled(false);
  });

  it('rejects bad calls on the page before the service worker hears of them', async () => {
    link.setEnabled(true);
    document.body.innerHTML = '<button id="cta">Go</button><div id="overlay-host"><i id="ours"></i></div>';
    send.mockClear();
    await expect(api()!.annotate('#nope', { comment: 'x' })).rejects.toThrow('no element matches "#nope"');
    await expect(api()!.annotate('[[', { comment: 'x' })).rejects.toThrow('not a valid CSS selector');
    await expect(api()!.annotate('#ours', { comment: 'x' })).rejects.toThrow('belongs to the review extension');
    await expect(api()!.annotate('#cta', { comment: '  ' })).rejects.toThrow('comment must be a non-empty string');
    expect(send).not.toHaveBeenCalled();
    link.setEnabled(false);
  });

  it('a page that turns the global on itself gets only errors: the overlay is not enabled', async () => {
    document.dispatchEvent(new CustomEvent(PAGE_API_STATE, { detail: JSON.stringify({ enabled: true }) }));
    send.mockClear();
    await expect(api()!.status()).rejects.toThrow('no Session is recording this tab');
    expect(send).not.toHaveBeenCalled();
    document.dispatchEvent(new CustomEvent(PAGE_API_STATE, { detail: JSON.stringify({ enabled: false }) }));
  });
});

describe('readNote', () => {
  it('keeps a given `from`, kebab-cases properties and caps the count', () => {
    document.body.innerHTML = '<p>Hello   there</p>';
    const el = document.body.firstElementChild!;
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`--v${i}`, `${i}`]));
    const { note, edit } = readNote(el, {
      comment: 'c',
      styleChanges: { backgroundColor: { from: 'white', to: 'black' }, ...many },
      textChange: { to: 'Hi' },
    });
    expect(note).toEqual({ comment: 'c' });
    expect(edit!.changes['background-color']).toEqual({ from: 'white', to: 'black' });
    expect(Object.keys(edit!.changes)).toHaveLength(20);
    expect(edit!.text).toEqual({ from: 'Hello there', to: 'Hi' });
    // A comment alone asks for no edit.
    expect(readNote(el, { comment: 'c' })).toEqual({ note: { comment: 'c' } });
    expect(() => readNote(el, { comment: 'c', styleChanges: { color: 3 } })).toThrow(
      'styleChanges.color must be a string',
    );
    expect(() => readNote(el, 'nope')).toThrow('options must be an object');
  });
});
