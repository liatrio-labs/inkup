// The Object Select highlight as the extension renders it: through the overlay host's React root (mountSurfaces),
// driven through its handle. The box follows the rectangle it is given, the chip reads `tag.class · W×H` (two classes
// at most, sizes rounded), it sits above the box or below it at the top of the viewport, it wears the palette it is
// told to and the pick's red pen edge, it never takes a pointer event, and the label (not the outline) can leave for a
// screenshot.
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { highlightLabel, type MountedHighlight, mountHighlight } from '../src/highlight';
import shadowCss from '../src/styles/shadow.css?inline';
import { mountSurfaces, type Surfaces } from '../src/toolbar';

let container: HTMLElement;
let surfaces: Surfaces;
let highlight: MountedHighlight;
let target: HTMLElement;

const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);
const outline = () => screen.getByTestId('object-select-highlight');
const label = () => screen.getByTestId('object-select-label');

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  surfaces = mountSurfaces(container);
  highlight = mountHighlight(surfaces);
  target = document.createElement('a');
  target.className = 'cta big extra';
  document.body.append(target);
});
afterEach(() => {
  surfaces.unmount();
  container.remove();
  target.remove();
  cleanup();
});

describe('Highlight', () => {
  it('draws nothing until it is given a rectangle, and again after hide', () => {
    expect(screen.queryByTestId('object-select-highlight')).toBeNull();
    highlight.show({ el: target, rect: rect(10, 40, 100, 30) });
    expect(outline()).toBeTruthy();
    highlight.hide();
    expect(screen.queryByTestId('object-select-highlight')).toBeNull();
    expect(screen.queryByTestId('object-select-label')).toBeNull();
  });

  it('follows a changing rectangle: hover, parent navigation and scroll each move the box', () => {
    highlight.show({ el: target, rect: rect(10, 40, 100, 30) });
    expect(outline().style).toMatchObject({ left: '10px', top: '40px', width: '100px', height: '30px' });
    // Scrolled 25px: the same element, higher in the viewport.
    highlight.show({ el: target, rect: rect(10, 15, 100, 30) });
    expect(outline().style).toMatchObject({ left: '10px', top: '15px', width: '100px', height: '30px' });
    // ↑ to a bigger parent.
    highlight.show({ el: document.body, rect: rect(0, 0, 640, 480) });
    expect(outline().style).toMatchObject({ left: '0px', top: '0px', width: '640px', height: '480px' });
    expect(screen.getAllByTestId('object-select-highlight')).toHaveLength(1);
  });

  it('labels the element as tag.class · W×H: two classes at most, sizes rounded', () => {
    highlight.show({ el: target, rect: rect(10, 40, 100.4, 29.6) });
    expect(label().textContent).toBe('a.cta.big · 100×30');
    highlight.show({ el: document.body, rect: rect(0, 0, 640, 480) });
    expect(label().textContent).toBe('body · 640×480');
    expect(highlightLabel(target, { width: 1.5, height: 0.4 })).toBe('a.cta.big · 2×0');
  });

  it('puts the label 22px above the box, or 4px below it when the box is at the top of the viewport', () => {
    highlight.show({ el: target, rect: rect(-5, 100, 100, 30) });
    expect(label().style).toMatchObject({ left: '0px', top: '78px' });
    highlight.show({ el: target, rect: rect(20, 10, 100, 30) });
    expect(label().style).toMatchObject({ left: '20px', top: '44px' });
  });

  it('wears the theme it is told to (dark over a light page by default) and the pen edge once picked', () => {
    highlight.show({ el: target, rect: rect(10, 40, 100, 30) });
    expect(outline().dataset.theme).toBe('dark');
    expect(outline().hasAttribute('data-picked')).toBe(false);
    highlight.show({ el: target, rect: rect(10, 40, 100, 30), theme: 'light', picked: true });
    expect(outline().dataset.theme).toBe('light');
    expect(label().dataset.theme).toBe('light');
    expect(outline().hasAttribute('data-picked')).toBe(true);
    expect(outline().className).toContain('data-[picked]:border-pen');
  });

  it('never takes a pointer event', () => {
    highlight.show({ el: target, rect: rect(10, 40, 100, 30) });
    expect(outline().className).toContain('pointer-events-none');
    expect(label().className).toContain('pointer-events-none');
    expect(outline().className).not.toContain('pointer-events-auto');
  });

  it('keeps the outline but takes the label out of a screenshot, and puts it back', () => {
    highlight.show({ el: target, rect: rect(10, 40, 100, 30) });
    highlight.hideLabelForCapture(true);
    expect(label().style.visibility).toBe('hidden');
    expect(outline().style.visibility).toBe('');
    // A move while captured keeps it hidden.
    highlight.show({ el: target, rect: rect(10, 20, 100, 30) });
    expect(label().style.visibility).toBe('hidden');
    highlight.hideLabelForCapture(false);
    expect(label().style.visibility).toBe('');
  });

  it('is removed from the root on destroy', () => {
    highlight.show({ el: target, rect: rect(10, 40, 100, 30) });
    highlight.destroy();
    expect(screen.queryByTestId('object-select-highlight')).toBeNull();
  });
});

describe('the shadow sheet', () => {
  it('compiles the utilities the highlight uses, and gives its palettes the pen and the content tint', () => {
    for (const utility of ['border-paper', 'bg-box-content', 'rounded-tag', 'font-mono', 'bg-paper', 'text-ink'])
      expect(shadowCss, utility).toContain(`.${utility}`);
    // The pick's weight and pen edge are state variants of the outline.
    expect(shadowCss).toContain(String.raw`data-\[picked\]\:border-3`);
    expect(shadowCss).toContain(String.raw`data-\[picked\]\:border-pen`);
    expect(shadowCss).toContain('data-picked');
    expect(shadowCss).toMatch(/\[data-island\]\[data-theme="light"\]\s*\{[^}]*--pen:\s*#e5484d/);
    expect(shadowCss).toMatch(/\[data-island\]\[data-theme="dark"\]\s*\{[^}]*--pen:\s*#ff6b70/);
  });
});
