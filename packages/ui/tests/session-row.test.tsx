// The session row from props alone (R1.2): the date, length, Change Item counts in their Resolution tones and the size,
// the compact panel row, the review link (a caller's render prop, or onOpen on a button), and delete only after the
// inline confirmation. Accessible names and test ids as the e2e suites locate them.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESOLUTION_TEXT, SessionRow, type SessionRowSummary } from '../src/product';

afterEach(cleanup);

const session: SessionRowSummary = {
  id: 's1',
  name: 'Pricing page',
  start_url: 'https://app.example/pricing',
  started_at: '2026-09-20T10:00:00.000Z',
  duration_ms: 65_000,
  items: null,
  bytes: 1_500_000,
};

function renderRow(props: Partial<Parameters<typeof SessionRow>[0]> = {}) {
  const onDelete = vi.fn();
  const onOpen = vi.fn();
  render(
    <ul>
      <SessionRow session={session} recording={false} onDelete={onDelete} onOpen={onOpen} {...props} />
    </ul>,
  );
  return { onDelete, onOpen, row: screen.getByTestId('session-row') };
}

describe('SessionRow', () => {
  it('shows the name, date, length, "not processed" and size, keyed by the Session id', () => {
    const { row } = renderRow();
    expect(row.dataset.session).toBe('s1');
    expect(within(row).getByTitle(session.start_url).textContent).toBe('Pricing page');
    const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(session.started_at),
    );
    expect(screen.getByTestId('session-date').textContent).toBe(date);
    expect(screen.getByTestId('session-length').textContent).toBe('01:05');
    expect(screen.getByTestId('session-items').textContent).toBe('not processed');
    expect(screen.getByTestId('session-size').textContent).toBe('1.5 MB');
  });

  it('says "recording" or "interrupted" for a Session with no length, and holds delete while it records', () => {
    renderRow({ session: { ...session, duration_ms: null }, recording: true });
    expect(screen.getByTestId('session-length').textContent).toBe('recording');
    const del = screen.getByTestId('delete-session');
    expect(del).toHaveProperty('disabled', true);
    expect(del.title).toBe('Stop the Session first');
    cleanup();
    renderRow({ session: { ...session, duration_ms: null } });
    expect(screen.getByTestId('session-length').textContent).toBe('interrupted');
  });

  it('counts Change Items, then by Resolution in their tones once an agent has acted', () => {
    renderRow({ session: { ...session, items: { total: 1, open: 1, in_progress: 0, done: 0, needs_info: 0 } } });
    expect(screen.getByTestId('session-items').textContent).toBe('1 Change Item');
    cleanup();
    renderRow({ session: { ...session, items: { total: 7, open: 3, in_progress: 1, done: 2, needs_info: 1 } } });
    const counts = screen.getByTestId('session-items');
    expect(counts.textContent).toBe('7 Change Items: 3 open · 1 in work · 2 done · 1 needs info');
    expect(counts.dataset).toMatchObject({ total: '7', open: '3', inProgress: '1', done: '2', needsInfo: '1' });
    const hue = (text: string) => within(counts).getByText(text).className;
    expect(hue('1 in work')).toBe(RESOLUTION_TEXT.in_progress);
    expect(hue('2 done')).toBe(RESOLUTION_TEXT.resolved);
    expect(hue('1 needs info')).toBe(RESOLUTION_TEXT.needs_info);
  });

  it('compact: the origin on its own line and no size', () => {
    renderRow({ compact: true, originLabel: 'app.example' });
    expect(screen.getByText('app.example')).toBeTruthy();
    expect(screen.queryByTestId('session-size')).toBeNull();
  });

  it('calls onOpen with the Session id from "Open review"', () => {
    const { onOpen } = renderRow();
    const open = screen.getByTestId('open-review');
    expect(open.textContent).toBe('Open review');
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('s1');
  });

  it("renders the caller's review link instead, with the row's test id and words", () => {
    renderRow({
      renderReviewLink: ({ sessionId, ...link }) => <a href={`/review.html?session=${sessionId}`} {...link} />,
    });
    const open = screen.getByTestId('open-review');
    expect(open.tagName).toBe('A');
    expect(open.getAttribute('href')).toBe('/review.html?session=s1');
    expect(open.textContent).toBe('Open review');
  });

  it('deletes only after "Confirm delete", once, and Cancel backs out', async () => {
    let finish: () => void = () => {};
    const onDelete = vi.fn(() => new Promise<void>((r) => (finish = r)));
    renderRow({ onDelete });
    fireEvent.click(screen.getByTestId('delete-session'));
    expect(onDelete).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: 'Confirm delete' });
    expect(group.textContent).toContain('Delete this Session and its recordings? This cannot be undone.');
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Delete', 'Cancel']);
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Confirm delete' })).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('delete-session'));
    fireEvent.click(screen.getByTestId('confirm-delete'));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith('s1');
    // Both buttons wait while the delete runs, so a second click cannot start another.
    expect(screen.getByTestId('confirm-delete')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTestId('confirm-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it('words the compact confirmation shorter', () => {
    renderRow({ compact: true });
    fireEvent.click(screen.getByTestId('delete-session'));
    expect(screen.getByRole('group', { name: 'Confirm delete' }).textContent).toContain(
      'Delete it and its recordings? This cannot be undone.',
    );
  });
});
