// ts-ebml calls Node's global `Buffer` at run time. Extension contexts have none, so this installs the `buffer`
// package's implementation. Import it before ts-ebml.
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: unknown };
g.Buffer ??= Buffer;
