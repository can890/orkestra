/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueuedPromptsBand } from './queued-prompts-band';

afterEach(cleanup);

describe('QueuedPromptsBand', () => {
  it('says the queued message goes out by itself and makes "send now" an explicit, labelled action', () => {
    const onSendNow = vi.fn();
    const { getByRole, getByText } = render(
      <QueuedPromptsBand
        prompts={[{ id: 'q1', text: 'sırada bekleyen' }]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
        onSendNow={onSendNow}
      />
    );
    getByText('Sent automatically when the turn ends');
    const sendNow = getByRole('button', { name: 'Send queued prompt now' });
    // Not a bare arrow that looks like the composer's send button: it stops the running turn.
    expect(sendNow.textContent).toBe('Send now');
    expect(sendNow.querySelector('svg')).toBeNull();
    expect(sendNow.getAttribute('title')).toBe('Stops the running turn and sends this message now');
    fireEvent.click(sendNow);
    expect(onSendNow).toHaveBeenCalledWith('q1');
  });

  const renderBand = (prompts: Array<{ id: string; text: string; queueReason?: string }>) =>
    render(
      <QueuedPromptsBand
        prompts={prompts}
        agentName="Grok"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
        onSendNow={vi.fn()}
      />
    );

  it.each([
    [
      'antigravity-orchestrator',
      'In Orchestrator mode Antigravity takes the message when the work is done.',
    ],
    [
      'antigravity-stream-json',
      'In this mode Antigravity takes new messages only when the work is done.',
    ],
    ['no-steering', 'Grok cannot take messages while it works; it is sent when the work is done.'],
    ['background-task', 'A background task is still running; the message is sent when it ends.'],
    [
      'awaiting-permission',
      'A permission request is open; the message is sent when the turn ends.',
    ],
    ['connecting', 'The agent is still connecting; the message is sent when the turn ends.'],
  ])('explains the %s reason in one line under the usual text', (reason, line) => {
    const { getByText } = renderBand([{ id: 'q1', text: 'x', queueReason: reason }]);
    getByText('Sent automatically when the turn ends');
    getByText(line);
  });

  it('shows nothing extra without a reason or for an unknown one, and each reason once', () => {
    const { container } = renderBand([
      { id: 'q1', text: 'a' },
      { id: 'q2', text: 'b', queueReason: 'from-a-newer-host' },
      { id: 'q3', text: 'c', queueReason: 'no-steering' },
      { id: 'q4', text: 'd', queueReason: 'no-steering' },
    ]);
    const text = container.textContent ?? '';
    expect(text.match(/cannot take messages/g)).toHaveLength(1);
    expect(text).not.toMatch(/from-a-newer-host/);
  });
});
