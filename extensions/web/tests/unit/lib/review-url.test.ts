import { describe, expect, it } from 'vitest';
import { isReviewOf, reviewPath } from '@/lib/review-url';

const origin = 'chrome-extension://abc';

describe('isReviewOf', () => {
  const at = (path: string) => `${origin}${path}`;

  it('matches the review page of that Session', () => {
    expect(isReviewOf(at(reviewPath('s1')), 's1', origin)).toBe(true);
  });

  it('takes the origin with a trailing slash, as getURL gives it', () => {
    expect(isReviewOf(at(reviewPath('s1')), 's1', `${origin}/`)).toBe(true);
  });

  it('ignores the hash and other parameters', () => {
    expect(isReviewOf(at('/review.html?session=s1#t=12'), 's1', origin)).toBe(true);
    expect(isReviewOf(at('/review.html?item=3&session=s1'), 's1', origin)).toBe(true);
  });

  it('decodes the session parameter', () => {
    expect(isReviewOf(at(reviewPath('a b/c')), 'a b/c', origin)).toBe(true);
  });

  it('does not match another Session, page or extension', () => {
    expect(isReviewOf(at(reviewPath('s2')), 's1', origin)).toBe(false);
    expect(isReviewOf(at(reviewPath('s10')), 's1', origin)).toBe(false);
    expect(isReviewOf(at('/review.html'), 's1', origin)).toBe(false);
    expect(isReviewOf(at('/sessions.html?session=s1'), 's1', origin)).toBe(false);
    expect(isReviewOf(`chrome-extension://other${reviewPath('s1')}`, 's1', origin)).toBe(false);
    expect(isReviewOf(`https://example.com${reviewPath('s1')}`, 's1', origin)).toBe(false);
  });

  it('does not match a tab whose url it cannot see', () => {
    expect(isReviewOf(undefined, 's1', origin)).toBe(false);
    expect(isReviewOf('', 's1', origin)).toBe(false);
  });

  it('works with moz-extension origins', () => {
    const moz = 'moz-extension://1234-5678';
    expect(isReviewOf(`${moz}${reviewPath('s1')}`, 's1', moz)).toBe(true);
  });
});
