// One React root per overlay host (ADR 0011): every in-page surface renders into it by key, so the toolbar today and
// the comment box, draw note and highlight next share one root, one stylesheet and one shadow host. The root lives in
// its own `display: contents` element in the container, beside the drawing canvas, which stays outside React.
import { createElement, Fragment, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

export interface Surfaces {
  /** Renders `node` under `key` (replacing what was there), or removes it with null. Synchronous: the DOM is current on return. */
  set(key: string, node: ReactNode | null): void;
  /** Unmounts the root and removes its element. */
  unmount(): void;
}

export function mountSurfaces(container: Element): Surfaces {
  const el = container.ownerDocument.createElement('div');
  el.setAttribute('data-surfaces', '');
  el.style.display = 'contents';
  container.append(el);
  const root = createRoot(el);
  const nodes = new Map<string, ReactNode>();
  let mounted = true;
  // Synchronous, as the DOM surfaces were: callers place, theme and hide what they just rendered.
  const render = () =>
    flushSync(() =>
      root.render(createElement(Fragment, null, ...[...nodes].map(([key, n]) => createElement(Fragment, { key }, n)))),
    );
  return {
    set(key, node) {
      if (!mounted) return;
      if (node === null) nodes.delete(key);
      else nodes.set(key, node);
      render();
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      nodes.clear();
      root.unmount();
      el.remove();
    },
  };
}
