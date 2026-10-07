// Where the floating toolbar sits. The rules moved to @inkup/ui with the toolbar (packages/ui/src/toolbar/position.ts);
// its position is still saved in storage.local through ToolbarActions.loadPosition/savePosition (content/client.ts).
export { clampPosition, defaultPosition, EDGE_MARGIN, type Pos, type Size } from '@inkup/ui/toolbar';
