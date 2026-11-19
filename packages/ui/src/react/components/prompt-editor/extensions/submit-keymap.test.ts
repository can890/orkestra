import type { Editor } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';
import { buildSubmitKeymap } from './submit-keymap';

describe('buildSubmitKeymap', () => {
  it('scrolls the new selection into view after inserting a hard break', () => {
    const run = vi.fn(() => true);
    const chain = {
      setHardBreak: vi.fn(() => chain),
      scrollIntoView: vi.fn(() => chain),
      run,
    };
    const extension = buildSubmitKeymap({ getShortcut: () => 'enter', onSubmit: vi.fn() });
    const shortcuts = extension.config.addKeyboardShortcuts?.call({} as never);

    const handled = shortcuts?.['Shift-Enter']({
      editor: { chain: () => chain } as unknown as Editor,
    });

    expect(handled).toBe(true);
    expect(chain.setHardBreak).toHaveBeenCalledOnce();
    expect(chain.scrollIntoView).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('routes Alt+Enter to onAltSubmit and leaves the key alone when it declines', () => {
    const onAltSubmit = vi.fn(() => true);
    const withHandler = buildSubmitKeymap({
      getShortcut: () => 'enter',
      onSubmit: vi.fn(),
      onAltSubmit,
    });
    const shortcuts = withHandler.config.addKeyboardShortcuts?.call({} as never);
    expect(shortcuts?.['Alt-Enter']({ editor: {} as Editor })).toBe(true);
    expect(onAltSubmit).toHaveBeenCalledOnce();

    const without = buildSubmitKeymap({ getShortcut: () => 'enter', onSubmit: vi.fn() });
    const none = without.config.addKeyboardShortcuts?.call({} as never);
    expect(none?.['Alt-Enter']({ editor: {} as Editor })).toBe(false);
  });
});
