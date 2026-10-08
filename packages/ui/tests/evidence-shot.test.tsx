// Evidence shot and location shot from props alone (spec 02 R2.2): a screenshot URL or Blob, its viewport, device
// pixel ratio and scroll, a crop rect and the Strokes. The crop's rect is in the screenshot's pixels and the Strokes in
// CSS px, so the overlay's viewBox is the rect scaled down by the screenshot's real width over its viewport (ADR 0013):
// `dpr` until the full image loads, then the image's own width. No Dexie, no messaging, no chrome global.
import type { EventOf } from '@inkup/core/timeline';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceShot, LocationShot, type ShotGeometry, shotViewBox } from '../src';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = (dpr: number): ShotGeometry => ({ viewport: { width: 1280, height: 720 }, dpr, scroll: { x: 0, y: 400 } });
const stroke = (id: string, color?: string) =>
  ({
    stroke_id: id,
    points: [
      { x: 100, y: 500, t: 0 },
      { x: 140, y: 520, t: 16 },
      { x: 180, y: 510, t: 32 },
    ],
    ...(color ? { color } : {}),
  }) as unknown as EventOf<'stroke'>;
const rect = { x: 200, y: 100, width: 400, height: 200 };

/** The viewBox the review page drew before the move (extensions/web/src/components/evidence-shot.tsx at 8146d3f). */
function preMove(shot: ShotGeometry, crop: { rect: typeof rect } | undefined, fullWidth: number | null): string {
  const { width, height } = shot.viewport;
  const scale = crop ? (fullWidth ?? width * shot.dpr) / width : 1;
  return crop
    ? [crop.rect.x, crop.rect.y, crop.rect.width, crop.rect.height].map((n) => n / scale).join(' ')
    : `0 0 ${width} ${height}`;
}

const overlay = () => screen.getByTestId('stroke-overlay');

describe('shotViewBox', () => {
  it.each([
    [1, undefined, null],
    [2, undefined, null],
    [1, { rect }, null],
    [2, { rect }, null],
    [1, { rect }, 2560],
    [2, { rect }, 2560],
    [3, { rect }, null],
  ] as const)('at DPR %i with crop %o and a %s px image matches the pre-move drawing', (dpr, crop, full) => {
    expect(shotViewBox(at(dpr), crop, full)).toBe(preMove(at(dpr), crop, full));
  });
});

describe('EvidenceShot', () => {
  it('draws nothing until the image and the screenshot event are there', () => {
    const { rerender } = render(<EvidenceShot id="shot-a" src={null} shot={at(1)} strokes={[]} />);
    expect(screen.queryByTestId('evidence-shot')).toBeNull();
    rerender(<EvidenceShot id="shot-a" src="blob:shot-a" shot={undefined} strokes={[]} />);
    expect(screen.queryByTestId('evidence-shot')).toBeNull();
    rerender(<EvidenceShot id="shot-a" src="blob:shot-a" shot={at(1)} strokes={[]} />);
    expect(screen.getByTestId('evidence-shot')).toBeTruthy();
  });

  it('shows the whole screenshot over its viewport, with each Stroke and its halo', () => {
    render(
      <EvidenceShot id="shot-a" src="blob:shot-a" shot={at(2)} strokes={[stroke('s1', '#1f6feb'), stroke('s2')]} />,
    );
    const fig = screen.getByTestId('evidence-shot');
    expect(fig.dataset.screenshotId).toBe('shot-a');
    expect(fig.dataset.crop).toBeUndefined();
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:shot-a');
    expect(screen.getByRole('img').getAttribute('alt')).toBe('Screenshot of the page when the Annotation closed');
    expect(overlay().getAttribute('viewBox')).toBe('0 0 1280 720');
    expect(overlay().getAttribute('aria-hidden')).toBe('true');
    const inked = overlay().querySelector('[data-stroke-id="s1"]')!;
    expect(inked.tagName).toBe('g');
    expect(inked.getAttribute('data-color')).toBe('#1f6feb');
    expect(inked.querySelectorAll('path')).toHaveLength(2);
    expect(inked.querySelectorAll('path')[1]?.getAttribute('fill')).toBe('#1f6feb');
    // A Stroke from before v14 has no colour and keeps the old orange.
    expect(overlay().querySelector('path[data-stroke-id="s2"]')?.getAttribute('fill')).toBe('rgb(234 88 12 / 0.75)');
  });

  it.each([
    [1, '200 100 400 200'],
    [2, '100 50 200 100'],
  ])('crops a rect at DPR %i to the viewBox %s, showing the crop image', (dpr, viewBox) => {
    render(
      <EvidenceShot
        id="shot-a"
        src="blob:shot-a"
        shot={at(dpr)}
        strokes={[stroke('s1', '#1f6feb')]}
        crop={{ id: 'shot-a.crop', src: 'blob:crop', rect }}
        alt="The picked element, cropped from the screenshot"
        testId="annotation-screenshot"
      />,
    );
    const fig = screen.getByTestId('annotation-screenshot');
    expect(fig.dataset.crop).toBe('shot-a.crop');
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:crop');
    expect(overlay().getAttribute('viewBox')).toBe(viewBox);
    expect(overlay().getAttribute('viewBox')).toBe(preMove(at(dpr), { rect }, null));
  });

  it("waits for the crop's own image, and then scales by the full image's real width", async () => {
    const loads: (() => void)[] = [];
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 2560;
        onload: (() => void) | null = null;
        set src(_: string) {
          loads.push(() => this.onload?.());
        }
      },
    );
    const { rerender } = render(
      <EvidenceShot id="shot-a" src="blob:shot-a" shot={at(1)} strokes={[]} crop={{ id: 'c', src: null, rect }} />,
    );
    expect(screen.queryByTestId('evidence-shot')).toBeNull();
    rerender(
      <EvidenceShot id="shot-a" src="blob:shot-a" shot={at(1)} strokes={[]} crop={{ id: 'c', src: 'blob:c', rect }} />,
    );
    // DPR 1 says the image is 1280 px wide until it loads; it is 2560, so the rect halves.
    expect(overlay().getAttribute('viewBox')).toBe('200 100 400 200');
    await act(async () => {
      for (const load of loads) load();
    });
    expect(overlay().getAttribute('viewBox')).toBe('100 50 200 100');
    expect(overlay().getAttribute('viewBox')).toBe(preMove(at(1), { rect }, 2560));
  });

  describe('from a Blob', () => {
    const { createObjectURL, revokeObjectURL } = URL;
    beforeEach(() => {
      let n = 0;
      URL.createObjectURL = vi.fn(() => `blob:made-${++n}`);
      URL.revokeObjectURL = vi.fn();
    });
    afterEach(() => {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    });

    it('makes an object URL for the image and revokes it when it goes', () => {
      const { unmount } = render(
        <EvidenceShot id="shot-a" src={new Blob(['png'], { type: 'image/png' })} shot={at(1)} strokes={[]} />,
      );
      expect(screen.getByRole('img').getAttribute('src')).toBe('blob:made-1');
      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:made-1');
    });
  });
});

describe('LocationShot', () => {
  it('opens the shot full size in a dialog named for the Location, and closes on Escape', async () => {
    render(
      <LocationShot
        id="shot-a"
        src="blob:shot-a"
        shot={at(2)}
        strokes={[stroke('s1', '#1f6feb')]}
        location={{ url: '/pricing.html', annotation: 2 }}
        label="Subject: button 'Get started'"
      />,
    );
    const open = screen.getByRole('button', { name: "Enlarge the screenshot of Subject: button 'Get started'" });
    expect(open.dataset.testid).toBe('location-shot-open');
    expect(screen.getByTestId('evidence-shot').dataset.screenshotId).toBe('shot-a');
    fireEvent.click(open);
    const dialog = await screen.findByTestId('location-shot-dialog');
    expect(screen.getByRole('dialog', { name: "Subject: button 'Get started'" })).toBe(dialog);
    expect(dialog.textContent).toContain('/pricing.html · Annotation #2');
    expect(screen.getByTestId('evidence-shot-large').dataset.screenshotId).toBe('shot-a');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByTestId('location-shot-dialog')).toBeNull();
  });

  it('says nothing of an Annotation when the Location cites none', async () => {
    render(
      <LocationShot
        id="shot-b"
        src="blob:shot-b"
        shot={at(1)}
        strokes={[]}
        location={{ url: '/pricing.html', annotation: null }}
        label="Destination: site header"
      />,
    );
    fireEvent.click(screen.getByTestId('location-shot-open'));
    const dialog = await screen.findByTestId('location-shot-dialog');
    expect(dialog.textContent).toContain('/pricing.html');
    expect(dialog.textContent).not.toContain('Annotation');
  });

  it('has no chrome global here', () => {
    expect((globalThis as { chrome?: unknown }).chrome).toBeUndefined();
  });
});
