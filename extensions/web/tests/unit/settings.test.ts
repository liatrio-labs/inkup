// Processing settings: every saved shape reads as per-role provider, model and effort.
import { describe, expect, it } from 'vitest';
import { normalizeProcessingSettings } from '@/settings';

describe('normalizeProcessingSettings', () => {
  it('reads nothing saved as the Anthropic defaults, with no effort', () => {
    expect(normalizeProcessingSettings(undefined)).toEqual({
      process: { provider: 'anthropic', model: 'claude-sonnet-5' },
      draft: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      merge: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    });
  });

  it('reads the shape saved before the Gateway (Anthropic model ids, mergeModel maybe absent)', () => {
    expect(normalizeProcessingSettings({ processModel: 'claude-opus-5-5', draftModel: ' claude-sonnet-5 ' })).toEqual({
      process: { provider: 'anthropic', model: 'claude-opus-5-5' },
      draft: { provider: 'anthropic', model: 'claude-sonnet-5' },
      merge: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    });
    expect(normalizeProcessingSettings({ processModel: '', draftModel: 'x', mergeModel: 'm' }).merge.model).toBe('m');
  });

  it('keeps per-role providers and efforts, drops unknown values, and fills blank models per provider', () => {
    expect(
      normalizeProcessingSettings({
        process: { provider: 'gateway', model: 'google/gemini-3.1-pro-preview', effort: 'high' },
        draft: { provider: 'gateway', model: '  ' },
        // biome-ignore lint/suspicious/noExplicitAny: a value from an older or hand-edited storage
        merge: { provider: 'openai' as any, model: 'claude-haiku-4-5', effort: 'extreme' as any },
      }),
    ).toEqual({
      process: { provider: 'gateway', model: 'google/gemini-3.1-pro-preview', effort: 'high' },
      draft: { provider: 'gateway', model: 'anthropic/claude-haiku-4.5' },
      merge: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
  });
});
