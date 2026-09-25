// A dot on the toolbar icon that says where the Session data goes: green when a paired Host is connected, blue when the
// extension works on its own (no Host paired; everything works locally), amber while a paired Host is unreachable
// (captures queue in the outbox and sync when it is back). The dot is drawn into the icon itself (setIcon with
// ImageData), in the bottom-right corner with a light ring so it reads on light and dark toolbars. The action badge
// is not used: browsers size it for text, so even blank it covers most of the icon.
// A development build draws the icon over construction stripes first (src/lib/dev-stripes.ts), so the dot sits on
// top of both.

import { RELEASE_BUILD, stripedIcon } from '@/lib/dev-stripes';
import { hostStatus, iconDev, iconDot } from '@/session-state';
import type { HostStatus } from '@/settings';

export type HostDotState = 'connected' | 'local' | 'offline';
export type HostDot = { state: HostDotState; color: string; title: string };

export const HOST_DOT_COLORS: Record<HostDotState, string> = {
  connected: '#16a34a',
  local: '#2563eb',
  offline: '#d97706',
};

/** The icon sizes the dot is drawn at: the toolbar's 1x and 2x. */
const SIZES = [16, 32] as const;

export function hostDot(status: HostStatus): HostDot {
  switch (status.state) {
    case 'connected':
      return { state: 'connected', color: HOST_DOT_COLORS.connected, title: 'InkUp: connected to the Host' };
    case 'unpaired':
      return { state: 'local', color: HOST_DOT_COLORS.local, title: 'InkUp: local only (no Host paired)' };
    case 'pairing':
    case 'connecting':
      return { state: 'offline', color: HOST_DOT_COLORS.offline, title: 'InkUp: connecting to the Host' };
    case 'offline':
      return {
        state: 'offline',
        color: HOST_DOT_COLORS.offline,
        title: 'InkUp: Host offline, captures will sync when it is back',
      };
  }
}

/** Where the dot sits on an icon of `size` px: a circle in the bottom-right corner, about a third of the icon wide, ring included. */
export function dotGeometry(size: number): { cx: number; cy: number; r: number; ring: number } {
  const r = Math.round(size * 0.13 * 2) / 2;
  const ring = Math.max(1, Math.round(size / 16));
  const inset = r + ring;
  return { cx: size - inset, cy: size - inset, r, ring };
}

async function iconBitmap(size: number): Promise<ImageBitmap> {
  const res = await fetch(chrome.runtime.getURL(`/icon/${size}.png`));
  return createImageBitmap(await res.blob());
}

/** The 2D context calls paintIcon makes, so a test can record them. */
export type IconContext = Pick<
  OffscreenCanvasRenderingContext2D,
  'drawImage' | 'getImageData' | 'createImageData' | 'putImageData' | 'beginPath' | 'arc' | 'fill' | 'fillStyle'
>;

/** Paints one toolbar icon: the stripes (development builds only), then the icon, then the dot. */
export function paintIcon(ctx: IconContext, icon: CanvasImageSource, size: number, dot: HostDot, dev: boolean): void {
  ctx.drawImage(icon, 0, 0, size, size);
  if (dev) {
    const striped = ctx.createImageData(size, size);
    striped.data.set(stripedIcon(ctx.getImageData(0, 0, size, size), size).data);
    ctx.putImageData(striped, 0, 0);
  }
  const { cx, cy, r, ring } = dotGeometry(size);
  ctx.beginPath();
  ctx.arc(cx, cy, r + ring, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = dot.color;
  ctx.fill();
}

async function drawIcon(dot: HostDot): Promise<Record<string, ImageData>> {
  const out: Record<string, ImageData> = {};
  for (const size of SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    paintIcon(ctx, await iconBitmap(size), size, dot, !RELEASE_BUILD);
    out[String(size)] = ctx.getImageData(0, 0, size, size);
  }
  return out;
}

async function show(status: HostStatus): Promise<void> {
  const dot = hostDot(status);
  await chrome.action.setTitle({ title: dot.title });
  // Without OffscreenCanvas (an older browser) the icon stays plain; the title still says where data goes.
  if (typeof OffscreenCanvas === 'undefined') return;
  await chrome.action.setIcon({ imageData: await drawIcon(dot) });
  await iconDot.setValue(dot.state);
  await iconDev.setValue(!RELEASE_BUILD);
}

export function initHostDot(): void {
  // An earlier build drew the dot as a blank badge; clear it.
  void chrome.action.setBadgeText({ text: '' });
  const draw = (s: HostStatus) => void show(s).catch((err: unknown) => console.warn('[InkUp] toolbar icon dot', err));
  void hostStatus.getValue().then(draw);
  hostStatus.watch(draw);
}
