// Reads where an element comes from, in the page's MAIN world (E4). In order, the first that knows wins, and later
// ones fill a missing file:
// 1. React: the element's fiber. React 16-18 dev builds record `_debugSource` {fileName, lineNumber} (from the JSX
//    source transform); React 19 dropped it, but its `_debugStack` owner stack names the file and line where the
//    element was created. Components come from the `_debugOwner` chain (the components that rendered it), else the
//    fiber's parents.
// 2. Vue: `__vueParentComponent.type.__file` (Vue 3 dev) or `__vue__.$options.__file` (Vue 2), with the parent chain.
// 3. Attributes a build plugin adds: `data-source-file` (+ `data-line` / `data-source-line`), `data-nextjs-path`,
//    on the element or its nearest ancestor that has one.
// Production builds strip all of this; minified component names are left out.
import { normalizeSourcePath } from '@inkup/core/source-path';
import type { SourceInfo } from './protocol';

const MAX_COMPONENTS = 8;
const MAX_DEPTH = 40;

// The framework internals this reads: untyped, version-dependent, and any field may be missing.
interface Fiber {
  type?: unknown;
  return?: Fiber | null;
  _debugSource?: { fileName?: string; lineNumber?: unknown } | null;
  _debugStack?: { stack?: unknown } | null;
  _debugOwner?: Fiber | null;
  owner?: Fiber | null;
}
interface VueComponent {
  name?: unknown;
  __name?: unknown;
  __file?: string;
}
interface VueInstance {
  type?: VueComponent;
  parent?: VueInstance | null;
}
interface Vue2Instance {
  $options?: VueComponent;
  $parent?: Vue2Instance | null;
}
interface VueNode {
  __vueParentComponent?: VueInstance;
  __vue__?: Vue2Instance;
}

/** `Button`, `PricingCard`, not the `Xe` or `t$` a minifier leaves. */
export function isReadableComponentName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Z][A-Za-z0-9_]{2,}$/.test(name) && /[a-z]/.test(name);
}

function reactName(type: unknown): string | null {
  if (!type) return null;
  if (typeof type === 'function') return (type as { displayName?: string }).displayName ?? type.name ?? null;
  if (typeof type === 'object') {
    const t = type as { displayName?: unknown; render?: unknown; type?: unknown; name?: unknown };
    if (typeof t.displayName === 'string') return t.displayName;
    if (t.render) return reactName(t.render); // forwardRef
    if (t.type) return reactName(t.type); // memo
    if (typeof t.name === 'string') return t.name; // a server component's ReactComponentInfo
  }
  return null;
}

function reactFiber(el: Element): Fiber | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  return key ? (el as unknown as Record<string, Fiber>)[key]! : null;
}

/** Stack-frame locations that are library code, not the app's. */
const LIBRARY_FRAME =
  /\/node_modules\/|\/\.vite\/deps\/|\/vendor\/|react(-dom)?[.-](development|production)|\/react-dom[-.]|\/@react-refresh|\/_next\/static\/chunks\/(framework|main|webpack)/;

/** The first app frame of a stack, as {file, line}: Chrome's `at fn (url:line:col)` and Firefox's `fn@url:line:col`. */
export function firstAppFrame(stack: string): { file: string; line: number } | null {
  for (const raw of stack.split('\n')) {
    let s = raw.trim();
    if (!s) continue;
    if (s.startsWith('at ')) {
      s = s.slice(3);
      const paren = /\((.*)\)$/.exec(s);
      if (paren) s = paren[1]!;
    } else if (s.includes('@')) {
      s = s.slice(s.indexOf('@') + 1);
    } else if (!/:\d+:\d+$/.test(s)) {
      continue; // the message line
    }
    const m = /^(.*):(\d+):(\d+)$/.exec(s);
    if (!m || LIBRARY_FRAME.test(m[1]!)) continue;
    return { file: m[1]!, line: Number(m[2]) };
  }
  return null;
}

function readReact(el: Element): SourceInfo | null {
  const fiber = reactFiber(el);
  if (!fiber) return null;
  let file: string | undefined;
  let line: number | undefined;
  // React <= 18: the nearest fiber with a JSX source.
  for (let f: Fiber | null | undefined = fiber, d = 0; f && d < MAX_DEPTH && !file; f = f.return, d++) {
    const src = f._debugSource;
    if (src?.fileName) {
      file = normalizeSourcePath(src.fileName) ?? undefined;
      line = typeof src.lineNumber === 'number' ? src.lineNumber : undefined;
    }
  }
  // React 19: where the element was created, from its owner stack.
  if (!file) {
    try {
      const stack = fiber._debugStack?.stack;
      const frame = typeof stack === 'string' ? firstAppFrame(stack) : null;
      if (frame) {
        file = normalizeSourcePath(frame.file) ?? undefined;
        line = file ? frame.line : undefined;
      }
    } catch {
      /* a page that broke Error.stack */
    }
  }
  const names: string[] = [];
  const push = (n: string | null) => {
    if (isReadableComponentName(n) && names.at(-1) !== n) names.push(n);
  };
  if (fiber._debugOwner !== undefined) {
    for (
      let o: Fiber | null | undefined = fiber._debugOwner, d = 0;
      o && d < MAX_DEPTH && names.length < MAX_COMPONENTS;
      o = o._debugOwner ?? o.owner ?? null, d++
    )
      push(reactName(o.type ?? o));
  }
  if (names.length === 0) {
    // No owners (a production build keeps no _debugOwner): the component fibers above the element.
    for (
      let f: Fiber | null | undefined = fiber.return, d = 0;
      f && d < MAX_DEPTH && names.length < MAX_COMPONENTS;
      f = f.return, d++
    ) {
      if (typeof f.type !== 'string') push(reactName(f.type));
    }
  }
  return file || names.length ? { ...(file ? { file } : {}), ...(line ? { line } : {}), components: names } : null;
}

function vueName(type: VueComponent | undefined): string | null {
  const n = type?.name ?? type?.__name ?? null;
  return typeof n === 'string' && /^[A-Za-z][\w-]{2,}$/.test(n) ? n : null;
}

function readVue(el: Element): SourceInfo | null {
  for (let e: Element | null = el, d = 0; e && d < MAX_DEPTH; e = e.parentElement, d++) {
    const node = e as unknown as VueNode;
    const instance = node.__vueParentComponent;
    if (instance) {
      const names: string[] = [];
      let file: string | undefined;
      for (let i: VueInstance | null = instance, k = 0; i && k < MAX_DEPTH; i = i.parent ?? null, k++) {
        file ??= normalizeSourcePath(i.type?.__file) ?? undefined;
        const n = vueName(i.type);
        if (n && names.length < MAX_COMPONENTS) names.push(n);
      }
      return file || names.length ? { ...(file ? { file } : {}), components: names } : null;
    }
    const vm = node.__vue__;
    if (vm) {
      const names: string[] = [];
      let file: string | undefined;
      for (let v: Vue2Instance | null = vm, k = 0; v && k < MAX_DEPTH; v = v.$parent ?? null, k++) {
        file ??= normalizeSourcePath(v.$options?.__file) ?? undefined;
        const n = vueName(v.$options);
        if (n && names.length < MAX_COMPONENTS) names.push(n);
      }
      return file || names.length ? { ...(file ? { file } : {}), components: names } : null;
    }
  }
  return null;
}

/** `path`, `path:12` or `path:12:3`. */
function splitLine(value: string): { file: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(value);
  return m ? { file: m[1]!, line: Number(m[2]) } : { file: value };
}

function readAttributes(el: Element): SourceInfo | null {
  const host = el.closest('[data-source-file],[data-nextjs-path]');
  if (!host) return null;
  const raw = host.getAttribute('data-source-file') ?? host.getAttribute('data-nextjs-path') ?? '';
  const { file: path, line: inline } = splitLine(raw);
  const file = normalizeSourcePath(path);
  if (!file) return null;
  const attr = Number(host.getAttribute('data-line') ?? host.getAttribute('data-source-line'));
  const line = Number.isInteger(attr) && attr > 0 ? attr : inline;
  return { file, ...(line ? { line } : {}), components: [] };
}

export function readSource(el: Element): SourceInfo | null {
  const found = [readReact, readVue, readAttributes].map((read) => {
    try {
      return read(el);
    } catch {
      return null;
    }
  });
  const first = found.find((s) => s !== null);
  if (!first) return null;
  if (first.file) return first;
  const withFile = found.find((s) => s?.file);
  return withFile ? { ...first, file: withFile.file, ...(withFile.line ? { line: withFile.line } : {}) } : first;
}
