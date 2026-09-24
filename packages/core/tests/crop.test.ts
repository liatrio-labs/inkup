import { describe, expect, it } from 'vitest';
import { CROP_PADDING_CSS_PX, cropBlobId, cropRect } from '../src/crop';

const shot = (dpr = 1, scroll = { x: 0, y: 0 }) => ({
  scroll,
  viewport: { width: 1280, height: 720 },
  image: { width: 1280 * dpr, height: 720 * dpr },
});

describe('cropRect', () => {
  it('the element box plus 16 CSS px on every side, at dpr 1', () => {
    expect(cropRect({ x: 100, y: 200, width: 120, height: 40 }, shot())).toEqual({
      x: 84,
      y: 184,
      width: 152,
      height: 72,
    });
    expect(CROP_PADDING_CSS_PX).toBe(16);
  });

  it('scales to the image pixels (dpr 2), measured from the image', () => {
    expect(cropRect({ x: 100, y: 200, width: 120, height: 40 }, shot(2))).toEqual({
      x: 168,
      y: 368,
      width: 304,
      height: 144,
    });
  });

  it('uses the scroll the screenshot was taken at: bbox is in page coordinates', () => {
    expect(cropRect({ x: 100, y: 1200, width: 120, height: 40 }, shot(1, { x: 0, y: 1000 }))).toEqual({
      x: 84,
      y: 184,
      width: 152,
      height: 72,
    });
  });

  it('clips to the viewport', () => {
    expect(cropRect({ x: 1250, y: -10, width: 100, height: 50 }, shot())).toEqual({
      x: 1234,
      y: 0,
      width: 46,
      height: 56,
    });
  });

  it('fractional boxes grow to whole pixels', () => {
    expect(cropRect({ x: 10.4, y: 20.6, width: 50.2, height: 10.1 }, shot(1.5))).toEqual({
      x: 0,
      y: 6,
      width: 115,
      height: 65,
    });
  });

  it('an image shorter than the viewport shows its top part at the width scale, not squeezed', () => {
    // An emulated 1280×720 viewport in a window whose visible area is 633 px tall.
    const short = {
      scroll: { x: 0, y: 0 },
      viewport: { width: 1280, height: 720 },
      image: { width: 1280, height: 633 },
    };
    expect(cropRect({ x: 819.5, y: 210, width: 145, height: 49 }, short)).toEqual({
      x: 803,
      y: 194,
      width: 178,
      height: 81,
    });
    expect(cropRect({ x: 100, y: 600, width: 100, height: 100 }, short)).toEqual({
      x: 84,
      y: 584,
      width: 132,
      height: 49,
    });
    expect(cropRect({ x: 100, y: 650, width: 100, height: 40 }, short)).toBeNull();
  });

  it('an element entirely off screen has no crop', () => {
    expect(cropRect({ x: 100, y: 2000, width: 120, height: 40 }, shot())).toBeNull();
    expect(
      cropRect({ x: 100, y: 100, width: 10, height: 10 }, { ...shot(), image: { width: 0, height: 0 } }),
    ).toBeNull();
  });

  it('crop ids', () => expect(cropBlobId('abc')).toBe('abc.crop'));
});
