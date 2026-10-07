// The capture surfaces' toolbar (ADR 0011): the floating Toolbar and its ViewportControl, the one React root an
// overlay host renders its surfaces into, and the position and paint helpers they share with the page side.
export { nextPaint } from './paint';
export { clampPosition, defaultPosition, EDGE_MARGIN, type Pos, type Size } from './position';
export { mountSurfaces, type Surfaces } from './surfaces';
export { Toolbar, type ToolbarHandle, type ToolbarProps } from './toolbar';
export { ViewportControl, type ViewportControlProps } from './viewport-control';
