/**
 * Keymap extension:
 *  - Configured shortcut → submit.
 *    When a suggestion popup is active the suggestion plugin intercepts Enter
 *    first (returning `true`) so this handler only fires when no popup is open.
 *  - Shift+Enter → insert a hard break in every mode.
 *  - Unconfigured Enter shortcuts fall through to StarterKit.
 */

import { Extension } from '@tiptap/core';
import type { PromptSubmitShortcut } from '../types';

interface SubmitKeymapOptions {
  getShortcut: () => PromptSubmitShortcut;
  onSubmit: () => void;
  onAcceptGhostSuggestion?: () => boolean;
}

export function buildSubmitKeymap({
  getShortcut,
  onSubmit,
  onAcceptGhostSuggestion,
}: SubmitKeymapOptions): Extension {
  const submit = (shortcut: PromptSubmitShortcut) => {
    if (getShortcut() !== shortcut) return false;
    onSubmit();
    return true;
  };

  return Extension.create({
    name: 'submitKeymap',
    addKeyboardShortcuts() {
      return {
        Enter: () => submit('enter'),

        'Mod-Enter': () => submit('mod-enter'),

        'Shift-Enter': ({ editor }) => editor.chain().setHardBreak().scrollIntoView().run(),

        Tab: () => onAcceptGhostSuggestion?.() ?? false,

        // ⌘⇧V / Ctrl+Shift+V: biçimlendirme veya görsel eklemeden saf düz metin yapıştır.
        'Mod-Shift-v': ({ editor }) => {
          if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return false;
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (!text) return;
              const normalized = text.replace(/\r\n/g, '\n');
              const lines = normalized.split('\n');
              const content: Array<{ type: string; text?: string }> = [];
              lines.forEach((line, idx) => {
                if (idx > 0) content.push({ type: 'hardBreak' });
                if (line.length > 0) content.push({ type: 'text', text: line });
              });
              if (content.length > 0) {
                editor.chain().focus().insertContent(content).run();
              }
            })
            .catch(() => undefined);
          return true;
        },
      };
    },
  });
}
