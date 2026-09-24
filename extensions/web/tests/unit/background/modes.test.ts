import { describe, expect, it } from 'vitest';
import { type Modes, modesOf, nextModes } from '@/background/modes';

const idle: Modes = { draw_mode: false, select_mode: null };
const drawing: Modes = { draw_mode: true, select_mode: null };
const objects: Modes = { draw_mode: false, select_mode: 'object' };
const text: Modes = { draw_mode: false, select_mode: 'text' };

describe('page modes', () => {
  it('turns each mode on from none', () => {
    expect(nextModes(idle, { draw: true })).toEqual(drawing);
    expect(nextModes(idle, { select: 'object' })).toEqual(objects);
    expect(nextModes(idle, { select: 'text' })).toEqual(text);
  });

  it('keeps at most one mode on: turning one on turns the other off', () => {
    expect(nextModes(drawing, { select: 'object' })).toEqual(objects);
    expect(nextModes(drawing, { select: 'text' })).toEqual(text);
    expect(nextModes(objects, { draw: true })).toEqual(drawing);
    expect(nextModes(text, { draw: true })).toEqual(drawing);
    expect(nextModes(objects, { select: 'text' })).toEqual(text);
    expect(nextModes(text, { select: 'object' })).toEqual(objects);
  });

  it('turning a mode off leaves the others as they are', () => {
    expect(nextModes(objects, { draw: false })).toEqual(objects);
    expect(nextModes(drawing, { select: null })).toEqual(drawing);
    expect(nextModes(text, { select: null })).toEqual(idle);
    expect(nextModes(drawing, { draw: false })).toEqual(idle);
  });

  it('Esc turns every mode off', () => {
    for (const m of [idle, drawing, objects, text]) expect(nextModes(m, 'none')).toEqual(idle);
  });

  it('reads a Session from before select_mode as no select mode', () => {
    expect(modesOf({ draw_mode: true })).toEqual(drawing);
  });
});
