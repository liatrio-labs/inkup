// The running browser's adapters, picked at build time (`wxt build -b <browser>` sets import.meta.env).
import { chromePlatform } from './chrome';
import { firefoxPlatform } from './firefox';
import { safariPlatform } from './safari';
import type { Platform } from './types';

export type { Platform, PlatformCapabilities, SurfacePort } from './types';

export const platform: Platform = import.meta.env.SAFARI
  ? safariPlatform
  : import.meta.env.FIREFOX
    ? firefoxPlatform
    : chromePlatform;
