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
});
