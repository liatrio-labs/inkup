import { anthropicKey, gatewayKey, type ModelRole, normalizeProcessingSettings, processingSettings } from '@/settings';
import { useStorageItem } from './use-storage-item';

/** Whether a model role's provider has a saved key, kept live; `undefined` until storage was read. */
export function useRoleHasKey(role: ModelRole): boolean | undefined {
  const settings = useStorageItem(processingSettings);
  const anthropic = useStorageItem(anthropicKey);
  const gateway = useStorageItem(gatewayKey);
  if (settings === undefined) return undefined;
  const key = normalizeProcessingSettings(settings)[role].provider === 'gateway' ? gateway : anthropic;
  return key === undefined ? undefined : !!key.trim();
}
