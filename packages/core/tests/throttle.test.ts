import { describe, expect, it } from 'vitest';
import { createScreenshotThrottle } from '../src/throttle';

describe('screenshot throttle', () => {
  it('captures, then reuses inside 500ms, then captures again', () => {
    const t = createScreenshotThrottle();
    expect(t.decide(1000)).toEqual({ action: 'capture' });
    t.record(1000, 's1');
    expect(t.decide(1499)).toEqual({ action: 'reuse', id: 's1' });
    expect(t.decide(1500)).toEqual({ action: 'capture' });
  });

  it('defers or drops inside the window depending on the trigger', () => {
    const t = createScreenshotThrottle();
    t.record(1000, 's1');
    expect(t.decide(1200, 'defer')).toEqual({ action: 'wait', ms: 300 });
    expect(t.decide(1200, 'drop')).toEqual({ action: 'drop' });
    expect(t.decide(1500, 'drop')).toEqual({ action: 'capture' });
  });

  it('a capture that stored nothing still spends the window: reuse waits instead (Chrome counts every call)', () => {
    const t = createScreenshotThrottle();
    t.record(1000, null);
    expect(t.decide(1200)).toEqual({ action: 'wait', ms: 300 });
    expect(t.decide(1200, 'drop')).toEqual({ action: 'drop' });
    expect(t.decide(1500)).toEqual({ action: 'capture' });
  });
});
