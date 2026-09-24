// The reviewer's three page modes (E7): Draw, Object Select and Select Text. At most one is on: turning one on turns
// the others off, and Esc turns them all off. The Session holds them (draw_mode, select_mode), so the toolbar, the
// panel and the page agree after a reload or a worker restart.
import type { ActiveSession, SelectMode } from '@/settings';

export type Modes = Pick<ActiveSession, 'draw_mode'> & { select_mode: SelectMode | null };

/** Draw on or off, a select mode on (or off: null), or every mode off. */
export type ModeRequest = { draw: boolean } | { select: SelectMode | null } | 'none';

export const modesOf = (s: Pick<ActiveSession, 'draw_mode' | 'select_mode'>): Modes => ({
  draw_mode: s.draw_mode,
  select_mode: s.select_mode ?? null,
});

export function nextModes(m: Modes, request: ModeRequest): Modes {
  if (request === 'none') return { draw_mode: false, select_mode: null };
  if ('draw' in request) return { draw_mode: request.draw, select_mode: request.draw ? null : m.select_mode };
  return { draw_mode: request.select ? false : m.draw_mode, select_mode: request.select };
}
