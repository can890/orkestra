/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PromptEditorProps } from '../prompt-editor/types';

const editorProps: { current: PromptEditorProps | null } = { current: null };

vi.mock('../prompt-editor/prompt-editor', () => ({
  PromptEditor: React.forwardRef<unknown, PromptEditorProps>(function MockPromptEditor(props, ref) {
    editorProps.current = props;
    React.useLayoutEffect(() => {
      const handle = { getText: () => 'son durum ne?' };
      if (typeof ref === 'function') ref(handle);
      else if (ref) (ref as React.MutableRefObject<unknown>).current = handle;
    });
    return <div data-testid="prompt-editor" data-placeholder={props.placeholder} />;
  }),
}));

import { ChatComposer } from './index';
import { QueuedPromptsBand } from './queued-prompts-band';

afterEach(() => {
  cleanup();
  editorProps.current = null;
});

describe('ChatComposer steering', () => {
  it('tells the user a message reaches the running agent, and keeps the old hint otherwise', () => {
    const steering = render(
      <ChatComposer isWorking steering onSubmit={() => {}} onSubmitWhileWorking={() => {}} />
    );
    expect(editorProps.current?.placeholder).toBe(
      'Çalışırken araya gir — ajan mesajını hemen görür (Alt+Enter: sıraya ekle)'
    );
    expect(steering.getByRole('button', { name: 'Çalışan ajana gönder' })).toBeTruthy();
    steering.unmount();

    const plain = render(
      <ChatComposer isWorking onSubmit={() => {}} onSubmitWhileWorking={() => {}} />
    );
    expect(editorProps.current?.placeholder).toBe('Yeni bir mesaj yazın');
    expect(plain.getByRole('button', { name: 'Mesajı sıraya ekle' })).toBeTruthy();
  });

  it('routes the primary action to onSubmitWhileWorking and Alt+Enter to onQueueWhileWorking', () => {
    const onSubmitWhileWorking = vi.fn();
    const onQueueWhileWorking = vi.fn();
    const { getByRole } = render(
      <ChatComposer
        isWorking
        steering
        onSubmit={() => {}}
        onSubmitWhileWorking={onSubmitWhileWorking}
        onQueueWhileWorking={onQueueWhileWorking}
      />
    );

    fireEvent.click(getByRole('button', { name: 'Çalışan ajana gönder' }));
    expect(onSubmitWhileWorking).toHaveBeenCalledWith('son durum ne?');
    expect(onQueueWhileWorking).not.toHaveBeenCalled();

    editorProps.current?.onAltSubmit?.('sonra bak');
    expect(onQueueWhileWorking).toHaveBeenCalledWith('sonra bak');
    expect(onSubmitWhileWorking).toHaveBeenCalledTimes(1);
  });

  it('says a question is answered on the side, and keeps Alt+Enter for queueing', () => {
    const onQueueWhileWorking = vi.fn();
    const { getByRole } = render(
      <ChatComposer
        isWorking
        sideAnswer
        onSubmit={() => {}}
        onSubmitWhileWorking={() => {}}
        onQueueWhileWorking={onQueueWhileWorking}
      />
    );
    expect(editorProps.current?.placeholder).toBe(
      'Çalışırken soru sor — ajan çalışmaya devam eder (Alt+Enter: sıraya ekle)'
    );
    expect(getByRole('button', { name: 'Yan soru sor' })).toBeTruthy();
    editorProps.current?.onAltSubmit?.('sonra');
    expect(onQueueWhileWorking).toHaveBeenCalledWith('sonra');
  });

  it('offers Alt+Enter only while working with steering', () => {
    const onQueueWhileWorking = vi.fn();
    render(<ChatComposer steering onSubmit={() => {}} onQueueWhileWorking={onQueueWhileWorking} />);
    expect(editorProps.current?.onAltSubmit).toBeUndefined();
    cleanup();
    render(
      <ChatComposer
        isWorking
        onSubmit={() => {}}
        onSubmitWhileWorking={() => {}}
        onQueueWhileWorking={onQueueWhileWorking}
      />
    );
    expect(editorProps.current?.onAltSubmit).toBeUndefined();
  });
});

describe('QueuedPromptsBand send now', () => {
  const prompts = [{ id: 'p1', text: 'sonra bak' }];

  it('says it cancels the turn by default and that the agent sees it when steering', () => {
    const base = {
      prompts,
      onEdit: () => {},
      onDelete: () => {},
      onReorder: () => {},
      onSendNow: vi.fn(),
    };
    const cancelling = render(<QueuedPromptsBand {...base} />);
    expect(cancelling.getByTitle('Send now - cancels the active turn')).toBeTruthy();
    cancelling.unmount();

    const steering = render(<QueuedPromptsBand {...base} sendNowSteers />);
    const button = steering.getByTitle('Send now - the agent sees it in the active turn');
    fireEvent.click(button);
    expect(base.onSendNow).toHaveBeenCalledWith('p1');
  });
});
