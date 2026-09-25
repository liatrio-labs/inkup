// The service worker's state in storage.session (@wxt-dev/storage): it lasts while the browser runs and survives a
// restarted service worker. Only the service worker and extension pages import this module. WXT reads an item as
// soon as it is defined, and Firefox gives content scripts and extension frames inside a page no storage.session, so
// defining these where src/settings.ts is imported threw on every page (#31). The types stay in src/settings.ts.
import { storage } from '@wxt-dev/storage';
import type { ActiveSession, FrameHostLayout, HostStatus, TabViewport } from './settings';

export const activeSession = storage.defineItem<ActiveSession | null>('session:activeSession', { fallback: null });
/**
 * Tabs that show the page's floating toolbar (src/content/toolbar.ts): the toolbar icon toggles a tab in and out, and
 * the shortcut or a toolbar Start adds it.
 */
export const toolbarTabs = storage.defineItem<number[]>('session:toolbarTabs', { fallback: [] });
export const tabViewports = storage.defineItem<Record<string, TabViewport>>('session:tabViewports', { fallback: {} });
export const frameHostLayouts = storage.defineItem<Record<string, FrameHostLayout>>('session:frameHostLayouts', {
  fallback: {},
});
/** Last error the service worker wants the panel to show (e.g. the microphone failed mid-Session). */
export const panelNotice = storage.defineItem<string | null>('session:panelNotice', { fallback: null });
export const hostStatus = storage.defineItem<HostStatus>('session:hostStatus', { fallback: { state: 'unpaired' } });
/** The dot last drawn on the toolbar icon (src/background/host-dot.ts); the icon itself cannot be read back. */
export const iconDot = storage.defineItem<'connected' | 'local' | 'offline' | null>('session:iconDot', {
  fallback: null,
});
/** Whether that icon has the development stripes (src/lib/dev-stripes.ts): true in every build but a release. */
export const iconDev = storage.defineItem<boolean | null>('session:iconDev', { fallback: null });

/**
 * What the paired Host can do right now, from its `welcome` (packages/protocol KNOWN_CAPABILITIES). The one gate for
 * every host feature: a feature whose capability is missing is absent as a whole. Empty while unpaired or offline.
 */
export async function hostCapabilities(): Promise<ReadonlySet<string>> {
  const status = await hostStatus.getValue();
  return new Set(status.state === 'connected' ? status.capabilities : []);
}
