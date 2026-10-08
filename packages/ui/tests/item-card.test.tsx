// The item card from props alone (R1.2): the Draft face as the side panel shows it (drafting, pinned, discarded, by
// click or voice) and the processed Change face (pinned, vetted, In work, Done, Won't fix, Needs info), with their
// tones and the test ids the e2e suites locate them by. Pin and Discard reach the caller once, with the item's id, and
// wait for the caller's promise. No chrome global, no Dexie and no messaging module: jsdom and props only.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChangeCardItem,
  DiscardUndo,
  type DraftCardItem,
  HostIndicator,
  ItemCard,
  RESOLUTION_STYLE,
  SessionRow,
  TONE,
  VETTING_STYLE,
} from '../src';

afterEach(cleanup);

const draft: DraftCardItem = {
  draft_id: 'd1',
  title: 'Make the heading say what the page is for',
  category: 'copy',
  locations: [
    { role: 'subject', element: "button 'Get started'", selector: 'a.cta', annotation: 1 },
    { role: 'destination', element: 'site header', selector: null, annotation: null },
  ],
};

const item: ChangeCardItem = {
  id: 'item_0001',
  title: 'Shorten the hero heading',
  category: 'copy',
  intent: 'Make the heading say what the page is for.',
  pinned: false,
};

function renderDraft(over: Partial<Parameters<typeof ItemCard>[0] & { variant: 'draft' }> = {}) {
  const onPin = vi.fn();
  const onDiscard = vi.fn();
  render(
    <ol>
      <ItemCard variant="draft" draft={draft} state="shown" onPin={onPin} onDiscard={onDiscard} {...over} />
    </ol>,
  );
  return { onPin, onDiscard, card: screen.getByTestId('draft-card') };
}

describe('ItemCard, Draft face', () => {
  it('shows the title, Category, Location names and no state while drafting', () => {
    const { card } = renderDraft();
    expect(card.dataset.draftId).toBe('d1');
    expect(card.dataset.state).toBe('shown');
    expect(screen.getByTestId('draft-title').textContent).toBe(draft.title);
    expect(screen.getByTestId('draft-category').textContent).toBe('copy');
    expect(screen.getAllByTestId('draft-location').map((l) => [l.dataset.role, l.textContent])).toEqual([
      ['subject', "Subject: button 'Get started' (#1)"],
      ['destination', 'Destination: site header'],
    ]);
    expect(screen.getByTestId('draft-state').textContent).toBe('');
    expect(screen.getByTestId('draft-pin').textContent).toBe('Pin');
    expect(screen.getByTestId('draft-pin').getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the accessible names in order: Discard, then Pin', () => {
    const { card } = renderDraft();
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Discard', 'Pin']);
  });

  it('calls onPin once with the draft id, and holds both buttons while the promise runs', async () => {
    let finish: () => void = () => {};
    const onPin = vi.fn(() => new Promise<void>((r) => (finish = r)));
    renderDraft({ onPin });
    fireEvent.click(screen.getByTestId('draft-pin'));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith('d1');
    expect(screen.getByTestId('draft-pin')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('draft-discard')).toHaveProperty('disabled', true);
    await act(async () => finish());
    expect(screen.getByTestId('draft-discard')).toHaveProperty('disabled', false);
  });

  it('calls onDiscard once with the draft id', async () => {
    const { onDiscard, onPin } = renderDraft();
    await act(async () => fireEvent.click(screen.getByTestId('draft-discard')));
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith('d1');
    expect(onPin).not.toHaveBeenCalled();
  });

  it('pinned: the ink border, "Pinned by voice", and Pin pressed and spent', () => {
    const { card } = renderDraft({ state: 'pinned', source: 'voice' });
    expect(card.dataset.state).toBe('pinned');
    expect(card.querySelector('[data-slot="card"]')?.className).toContain('border-primary');
    expect(screen.getByTestId('draft-state').textContent).toBe('Pinned by voice');
    const pin = screen.getByTestId('draft-pin');
    expect(pin.textContent).toBe('Pinned');
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(pin).toHaveProperty('disabled', true);
    expect(screen.getByTestId('draft-discard')).toHaveProperty('disabled', false);
  });

  it('discarded by a click: faded, struck through, Discard spent', () => {
    const { card } = renderDraft({ state: 'discarded', source: 'click' });
    expect(card.querySelector('[data-slot="card"]')?.className).toContain('opacity-50');
    expect(screen.getByTestId('draft-title').className).toContain('line-through');
    expect(screen.getByTestId('draft-state').textContent).toBe('Discarded');
    expect(screen.getByTestId('draft-discard')).toHaveProperty('disabled', true);
  });

  it('disabled while the Session stops', () => {
    renderDraft({ disabled: true });
    expect(screen.getByTestId('draft-pin')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('draft-discard')).toHaveProperty('disabled', true);
  });
});

describe('ItemCard, Change face', () => {
  const renderChange = (props: Partial<Parameters<typeof ItemCard>[0] & { variant: 'change' }> = {}) =>
    render(
      <ul>
        <ItemCard variant="change" item={item} {...props} />
      </ul>,
    );

  it('processed: title, intent and Category, no pinned marker and no Resolution', () => {
    renderChange();
    const card = screen.getByTestId('change-item');
    expect(card.dataset.itemId).toBe('item_0001');
    expect(card.dataset.status).toBe('open');
    expect(screen.getByTestId('item-title').textContent).toBe(item.title);
    expect(screen.getByTestId('item-intent').textContent).toBe(item.intent);
    expect(screen.getByTestId('item-category').textContent).toBe('copy');
    expect(screen.queryByTestId('item-pinned')).toBeNull();
    expect(screen.queryByTestId('item-resolution')).toBeNull();
  });

  it('pinned: the pinned marker after the Category', () => {
    renderChange({ item: { ...item, pinned: true } });
    expect(screen.getByTestId('change-item').dataset.pinned).toBe('true');
    const marker = screen.getByTestId('item-pinned');
    expect(marker.textContent).toBe('pinned');
    expect(marker.title).toBe('Pinned as a Draft Item during the Session');
  });

  it.each([
    ['in_progress', 'In work'],
    ['resolved', 'Done'],
    ['wont_fix', "Won't fix"],
    ['needs_info', 'Needs info'],
  ] as const)('a %s Resolution reads "%s" in its tone, with who and the note', (status, label) => {
    renderChange({ resolution: { status, by: 'inkup-e2e · just now', note: 'Which heading?' } });
    const box = screen.getByTestId('item-resolution');
    expect(box.dataset.status).toBe(status);
    for (const c of RESOLUTION_STYLE[status].split(' ')) expect(box.className).toContain(c);
    expect(screen.getByTestId('item-resolution-label').textContent).toBe(label);
    expect(screen.getByTestId('item-resolution-by').textContent).toBe('inkup-e2e · just now');
    expect(screen.getByTestId('item-resolution-note').textContent).toBe('Which heading?');
    expect(screen.getByTestId('change-item').dataset.status).toBe(status);
  });

  it.each([
    ['confirmed', 'Checked'],
    ['corrected', 'Corrected: The circle is around the link.'],
    ['unverified', 'Unverified: The circle is around the link.'],
  ] as const)('vetting %s reads "%s" in its tone', (verdict, text) => {
    renderChange({ item: { ...item, vetting: { verdict, reason: 'The circle is around the link.' } } });
    const badge = screen.getByTestId('vetting');
    expect(badge.dataset.verdict).toBe(verdict);
    expect(badge.textContent).toBe(text);
    for (const c of VETTING_STYLE[verdict].split(' ')) expect(badge.className).toContain(c);
  });

  it('puts the caller badges, evidence and actions in their slots, and their callbacks fire', () => {
    const onCopy = vi.fn();
    renderChange({
      badges: <span data-testid="check-me">check me</span>,
      evidence: <p data-testid="item-location">Subject: the heading</p>,
      actions: (
        <button type="button" onClick={onCopy} data-testid="copy-prompt">
          Copy agent prompt
        </button>
      ),
    });
    const card = screen.getByTestId('change-item');
    expect(within(card).getByTestId('check-me').textContent).toBe('check me');
    expect(within(card).getByTestId('item-location').textContent).toBe('Subject: the heading');
    fireEvent.click(screen.getByTestId('copy-prompt'));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});

describe('the product components without an extension runtime', () => {
  it('has no chrome global here', () => {
    expect((globalThis as { chrome?: unknown }).chrome).toBeUndefined();
  });

  it('renders the session row, item card, discard-undo and host indicator from props', () => {
    const now = Date.now();
    render(
      <div>
        <ul>
          <SessionRow
            session={{
              id: 's1',
              name: 'Pricing page',
              start_url: 'https://app.example/pricing',
              started_at: '2026-09-20T10:00:00.000Z',
              duration_ms: 5000,
              items: null,
              bytes: 2048,
            }}
            recording={false}
            onDelete={() => {}}
          />
        </ul>
        <ol>
          <ItemCard variant="draft" draft={draft} state="pinned" onPin={() => {}} onDiscard={() => {}} />
        </ol>
        <DiscardUndo pending={[{ session_id: 's2', deadline: now + 4000 }]} now={now} onUndo={() => {}} />
        <HostIndicator status={{ state: 'connected' }} waiting={0} network={false} />
      </div>,
    );
    expect(screen.getByTestId('session-row')).toBeTruthy();
    expect(screen.getByTestId('draft-card')).toBeTruthy();
    expect(screen.getByTestId('discard-undo').textContent).toContain('Session discarded');
    expect(screen.getByTestId('host-indicator').textContent).toBe('Host connected');
  });
});

describe('DiscardUndo', () => {
  it('counts down each pending discard, undoes through onUndo, and says the error', () => {
    const onUndo = vi.fn();
    const now = 1_000_000;
    const { rerender } = render(
      <DiscardUndo
        pending={[
          { session_id: 's1', deadline: now + 4200 },
          { session_id: 'gone', deadline: now - 1 },
        ]}
        now={now}
        onUndo={onUndo}
      />,
    );
    const strips = screen.getAllByRole('status');
    expect(strips).toHaveLength(1);
    expect(strips[0]?.textContent).toBe('Session discarded · 5 sUndo');
    fireEvent.click(screen.getByTestId('undo-discard'));
    expect(onUndo).toHaveBeenCalledExactlyOnceWith('s1');
    rerender(
      <DiscardUndo pending={[]} now={now} error="Too late: the Session was already discarded." onUndo={onUndo} />,
    );
    expect(screen.getByTestId('discard-undo').textContent).toBe('Too late: the Session was already discarded.');
    rerender(<DiscardUndo pending={[]} now={now} onUndo={onUndo} />);
    expect(screen.queryByTestId('discard-undo')).toBeNull();
  });
});

describe('HostIndicator', () => {
  it.each([
    [{ state: 'connected' } as const, 0, false, 'Host connected', TONE.okDot, ''],
    [
      { state: 'offline', error: 'refused', retry: true } as const,
      3,
      true,
      'Host offline, will sync (3)',
      TONE.restDot,
      'refused · Unencrypted network hub',
    ],
    [
      { state: 'offline', error: 'bad token', retry: false } as const,
      0,
      false,
      'Host: pair again in Settings',
      TONE.restDot,
      'bad token',
    ],
    [{ state: 'connecting' } as const, 0, false, 'Host offline, will sync', TONE.restDot, ''],
  ])('%o with %i waiting reads its label', (status, waiting, network, label, dot, title) => {
    render(<HostIndicator status={status} waiting={waiting} network={network} />);
    const el = screen.getByTestId('host-indicator');
    expect(el.textContent).toBe(label);
    expect(el.dataset.state).toBe(status.state);
    expect(el.getAttribute('title') ?? '').toBe(title);
    expect(el.querySelector('[aria-hidden]')?.className).toContain(dot);
  });
});
