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

describe('ItemCard, Change face at review time', () => {
  const full: ChangeCardItem = {
    ...item,
    pinned: true,
    source: 'page_api',
    vetting: { verdict: 'corrected', reason: 'The circle is around the link.' },
    ambiguity: 'The reviewer said both "bigger" and "smaller".',
    transcript: 'this heading is too long',
    agent_prompt: 'On /pricing.html shorten h1.hero. See screenshots/s1.png.',
    locations: [
      {
        role: 'subject',
        element: 'hero heading',
        selector: 'h1.hero',
        url: '/pricing.html',
        screenshot: 's1',
        annotation: 1,
      },
      {
        role: 'destination',
        element: 'site header',
        selector: null,
        url: '/pricing.html',
        screenshot: null,
        annotation: null,
      },
    ],
  };

  function renderReview(over: Partial<Parameters<typeof ItemCard>[0] & { variant: 'change' }> = {}) {
    const calls = {
      onSelect: vi.fn(),
      onPick: vi.fn(),
      onEdit: vi.fn(async () => {}),
      onSplit: vi.fn(),
      onDelete: vi.fn(),
      renderShot: vi.fn((_l: unknown, label: string) => (
        <button type="button" aria-label={`Enlarge the screenshot of ${label}`} data-testid="location-shot-open" />
      )),
    };
    const handleRef = vi.fn();
    render(
      <ol>
        <ItemCard
          variant="change"
          item={full}
          handleRef={handleRef}
          selected={false}
          picked={false}
          actions={
            <button type="button" data-testid="send-to-tracker">
              Send to tracker
            </button>
          }
          {...calls}
          {...over}
        />
      </ol>,
    );
    return { ...calls, handleRef, card: screen.getByTestId('change-item') };
  }

  /** The card's controls in document order, by accessible name. */
  const controls = (card: HTMLElement) =>
    [...card.querySelectorAll('button, [role="checkbox"], summary')].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent,
    );

  it('keeps the review page order: handle, checkbox, Location shots, Copy, the caller actions, Edit, Split, Delete, Agent prompt', () => {
    const { card, handleRef } = renderReview();
    expect(controls(card)).toEqual([
      `Drag to reorder: ${item.title}`,
      `Select for merge: ${item.title}`,
      'Enlarge the screenshot of Subject: hero heading',
      'Enlarge the screenshot of Destination: site header',
      'Copy agent prompt',
      'Send to tracker',
      'Edit',
      'Split',
      'Delete',
      'Agent prompt',
    ]);
    expect(handleRef).toHaveBeenCalledWith(screen.getByTestId('drag-handle'));
  });

  it('shows the pills in order: check me, Category, pinned, the merge state, vetting, page API', () => {
    const { card } = renderReview({ lowConfidence: true, combine: 'running' });
    const pills = [...card.querySelectorAll('[data-testid]')]
      .map((e) => (e as HTMLElement).dataset.testid)
      .filter((id) =>
        ['check-me', 'item-category', 'item-pinned', 'item-combining', 'vetting', 'item-source'].includes(id!),
      );
    expect(pills).toEqual(['check-me', 'item-category', 'item-pinned', 'item-combining', 'vetting', 'item-source']);
    expect(screen.getByRole('status').textContent).toBe('Combining…');
    expect(screen.getByTestId('item-source').textContent).toBe('page API');
  });

  it('low confidence: the pen border on the card and the "check me" pill in its tone, with no colour fade', () => {
    const { card } = renderReview({ lowConfidence: true });
    for (const c of TONE.unsureCard.split(' '))
      expect(card.querySelector('[data-slot="card"]')?.className).toContain(c);
    const chip = screen.getByTestId('check-me');
    expect(chip.textContent).toBe('check me');
    for (const c of TONE.unsureChip.split(' ')) expect(chip.className).toContain(c);
    expect(chip.className).toContain('transition-none');
    expect(screen.getByTestId('vetting').className).toContain('transition-none');
  });

  it('the item without low confidence has neither', () => {
    const { card } = renderReview();
    expect(screen.queryByTestId('check-me')).toBeNull();
    expect(card.querySelector('[data-slot="card"]')?.className).not.toContain('border-pen');
  });

  it('shows the ambiguity, each Location with its selector in pen-ink and its shot, and the transcript', () => {
    const { renderShot } = renderReview();
    expect(screen.getByTestId('ambiguity').textContent).toBe(full.ambiguity);
    const rows = screen.getAllByTestId('item-location');
    expect(rows.map((r) => [r.dataset.role, r.querySelector('p')?.textContent])).toEqual([
      ['subject', 'Subject: hero heading h1.hero on /pricing.html · Annotation #1'],
      ['destination', 'Destination: site header on /pricing.html'],
    ]);
    expect(rows[0]!.querySelector('code')?.className).toContain('text-pen-ink');
    expect(renderShot.mock.calls.map(([l, label]) => [(l as { role: string }).role, label])).toEqual([
      ['subject', 'Subject: hero heading'],
      ['destination', 'Destination: site header'],
    ]);
    expect(screen.getByText('“this heading is too long”')).toBeTruthy();
    expect(screen.getByTestId('agent-prompt').textContent).toBe(full.agent_prompt);
  });

  it('selects on a click on the card, and not on a click on its controls', () => {
    const { card, onSelect, onPick, onSplit, onDelete } = renderReview();
    fireEvent.click(screen.getByTestId('item-title'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('select-item'));
    fireEvent.click(screen.getByTestId('split-item'));
    fireEvent.click(screen.getByTestId('delete-item'));
    fireEvent.click(screen.getByTestId('send-to-tracker'));
    fireEvent.click(card.querySelector('summary')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('the select-for-merge checkbox is a checkbox with its state, and the selected card has the ring', () => {
    const { card } = renderReview({ picked: true, selected: true });
    const box = screen.getByRole('checkbox', { name: `Select for merge: ${item.title}` });
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.dataset.testid).toBe('select-item');
    expect(card.dataset.selected).toBe('true');
    expect(card.querySelector('[data-slot="card"]')?.className).toContain('ring-primary');
  });

  it('edits title and Category in place, sends only what changed, and selects the card', async () => {
    const { onEdit, onSelect } = renderReview();
    fireEvent.click(screen.getByTestId('edit-item'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('edit-item')).toBeNull();
    expect(screen.queryByTestId('item-title')).toBeNull();
    const title = screen.getByTestId('edit-title') as HTMLInputElement;
    expect(title.value).toBe(item.title);
    expect(screen.getByRole('combobox', { name: 'Category' }).dataset.testid).toBe('edit-category');
    fireEvent.change(title, { target: { value: '  Shorter hero heading ' } });
    fireEvent.change(screen.getByTestId('edit-category'), { target: { value: 'layout' } });
    expect(screen.getByText('The agent prompt is not rewritten; check it still matches after an edit.')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId('save-item')));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({ title: 'Shorter hero heading', category: 'layout' });
    expect(screen.getByTestId('item-title')).toBeTruthy();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('Save waits for a title, Cancel and an unchanged Save log nothing', async () => {
    const { onEdit } = renderReview();
    fireEvent.click(screen.getByTestId('edit-item'));
    fireEvent.change(screen.getByTestId('edit-title'), { target: { value: ' ' } });
    expect(screen.getByTestId('save-item')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('item-title').textContent).toBe(item.title);
    fireEvent.click(screen.getByTestId('edit-item'));
    await act(async () => fireEvent.click(screen.getByTestId('save-item')));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-item')).toBeTruthy();
  });

  it('a merge kept as it was says so, and Combine with AI retries without selecting', () => {
    const onRetry = vi.fn();
    const { onSelect } = renderReview({ combine: { error: 'No key.', onRetry } });
    expect(screen.getByTestId('item-combined-plain').textContent).toBe('Combined without AI');
    expect(screen.getByTestId('item-combined-plain').title).toBe('No key.');
    fireEvent.click(screen.getByTestId('item-combine-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Copy agent prompt copies the prompt and says Copied, or Copy failed', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      renderReview();
      await act(async () => fireEvent.click(screen.getByTestId('copy-prompt')));
      expect(writeText).toHaveBeenCalledWith(full.agent_prompt);
      expect(screen.getByTestId('copy-prompt').textContent).toBe('Copied');
      writeText.mockRejectedValueOnce(new Error('denied'));
      await act(async () => fireEvent.click(screen.getByTestId('copy-prompt')));
      expect(screen.getByTestId('copy-prompt').textContent).toBe('Copy failed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the Resolution box in its tone with who said it', () => {
    renderReview({ resolution: { status: 'needs_info', by: 'An agent · just now', note: 'Which heading?' } });
    const box = screen.getByTestId('item-resolution');
    for (const c of RESOLUTION_STYLE.needs_info.split(' ')) expect(box.className).toContain(c);
    expect(screen.getByTestId('item-resolution-by').textContent).toBe('An agent · just now');
    expect(screen.getByTestId('change-item').dataset.status).toBe('needs_info');
  });

  it('the dragged card fades', () => {
    const { card } = renderReview({ dragging: true });
    expect(card.className).toContain('opacity-60');
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
