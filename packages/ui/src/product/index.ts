// The product components (spec 02, R1.2): what the extension's pages and the desktop app both show, drawn from props
// and callbacks alone. The apps supply the data (the extension from Dexie and its storage items) and the actions (its
// messaging). Nothing here imports Dexie, messaging, storage, WXT or an extension module (tests/product-boundary.test.ts).
export * from './discard-undo';
export * from './host-indicator';
export * from './item-card';
export * from './resolution-style';
export * from './session-row';
export * from './tone';
export * from './vetting-style';
