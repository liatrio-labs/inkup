// @inkup/ui: the shadcn/ui primitives both apps use, the cn helper, mountInShadow and the product components that
// take only props (ADR 0029). Add a primitive with the shadcn CLI from packages/ui (components.json), then export it
// here.

// The toast call for the package's Toaster: one sonner store, whichever copy an app resolves.
export { toast } from 'sonner';
export * from './comment-box';
export * from './components/alert';
export * from './components/alert-dialog';
export * from './components/badge';
export * from './components/button';
export * from './components/card';
export * from './components/checkbox';
export * from './components/collapsible';
export * from './components/dialog';
export * from './components/input';
export * from './components/label';
export * from './components/native-select';
export * from './components/radio-group';
export * from './components/scroll-area';
export * from './components/skeleton';
export * from './components/sonner';
export * from './components/switch';
export * from './components/table';
export * from './components/tabs';
export * from './components/textarea';
export * from './components/tooltip';
export * from './highlight';
export { cn } from './lib/utils';
export { mountInShadow, toShadowCss } from './mount-in-shadow';
export * from './product';
export * from './toolbar';
export * from './toolbar-state';
