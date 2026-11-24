import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatDraftInjection,
  registerActiveChatDraftHandler,
} from '@core/features/conversations/api/browser/active-chat-draft-bus';
import { AppChatDropOverlay } from '@renderer/app/app-chat-drop-overlay';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function imageTransfer(name = 'photo.png'): DataTransfer {
  const transfer = new DataTransfer();
  transfer.items.add(new File(['png-bytes'], name, { type: 'image/png', lastModified: 1 }));
  return transfer;
}

describe('AppChatDropOverlay', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<AppChatDropOverlay />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('forwards unclaimed window dragover/drop files to the active chat once and hides the overlay', async () => {
    const received: ChatDraftInjection[] = [];
    const unregister = registerActiveChatDraftHandler('conv-1', (payload) => {
      received.push(payload);
    });

    try {
      await act(async () => {
        window.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            dataTransfer: imageTransfer(),
          })
        );
      });
      expect(document.body.textContent).toContain('Aktif sohbete eklemek için bırakın');

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: imageTransfer('dropped.png'),
      });
      await act(async () => {
        window.dispatchEvent(dropEvent);
      });

      expect(dropEvent.defaultPrevented).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]?.files?.map((file) => file.name)).toEqual(['dropped.png']);
      expect(document.body.textContent).not.toContain('Aktif sohbete eklemek için bırakın');
    } finally {
      unregister();
    }
  });

  it('ignores drops already claimed with preventDefault by an inner drop zone', async () => {
    const handler = vi.fn();
    const unregister = registerActiveChatDraftHandler('conv-2', handler);
    const inner = document.createElement('div');
    document.body.appendChild(inner);
    const onInnerDrop = (event: DragEvent) => {
      event.preventDefault();
    };
    inner.addEventListener('drop', onInnerDrop);

    try {
      await act(async () => {
        inner.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: imageTransfer('claimed.png'),
          })
        );
      });

      expect(handler).not.toHaveBeenCalled();
    } finally {
      inner.removeEventListener('drop', onInnerDrop);
      inner.remove();
      unregister();
    }
  });

  it('injects pasted clipboard images outside inputs/dialogs, and skips inputs or open dialogs', async () => {
    const received: ChatDraftInjection[] = [];
    const unregister = registerActiveChatDraftHandler('conv-3', (payload) => {
      received.push(payload);
    });
    const plain = document.createElement('div');
    const input = document.createElement('input');
    document.body.append(plain, input);

    try {
      await act(async () => {
        plain.dispatchEvent(
          new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: imageTransfer('outside-paste.png'),
          })
        );
      });
      expect(received).toHaveLength(1);
      expect(received[0]?.files?.map((file) => file.name)).toEqual(['outside-paste.png']);

      await act(async () => {
        input.dispatchEvent(
          new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: imageTransfer('inside-input.png'),
          })
        );
      });
      expect(received).toHaveLength(1);

      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      document.body.appendChild(dialog);
      try {
        await act(async () => {
          plain.dispatchEvent(
            new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: imageTransfer('dialog-open.png'),
            })
          );
        });
        expect(received).toHaveLength(1);
      } finally {
        dialog.remove();
      }
    } finally {
      plain.remove();
      input.remove();
      unregister();
    }
  });
});
