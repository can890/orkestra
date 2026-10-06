import type { PromptEditorRef } from '@orkestra/ui/react/components';
import { Button, toast, Tooltip } from '@orkestra/ui/react/primitives';
import { LoaderCircle, Mic, MicOff, Square } from 'lucide-react';
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import {
  dictationLabel,
  formatElapsed,
  isDictationShortcut,
  transcriptInsertion,
} from '@core/features/voice/browser/dictation-machine';
import { useDictation } from '@core/features/voice/browser/use-dictation';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';

// Sohbet kutusu araç çubuğundaki mikrofon düğmesi. Tıklama ya da Mod+Shift+Space kaydı
// başlatır/durdurur; Esc kaydı iptal eder. Yazıya dökülen metin imleç konumuna eklenir.

const isMac = detectPlatformContext().os === 'mac';
const SHORTCUT_LABEL = isMac ? '⌘⇧Space' : 'Ctrl+Shift+Space';

export type DictationButtonProps = {
  editorApiRef: RefObject<PromptEditorRef | null>;
  /** Kısayolun dinlendiği kapsayıcı (sohbet kutusu yuvası). */
  shortcutScope: HTMLElement | null;
  disabled?: boolean;
};

/** Metni imlece ekler; insertText verilen öğe düz metin olarak eklenir (ardından bir boşluk). */
export function insertTranscriptAtCursor(editor: PromptEditorRef, transcript: string): void {
  const { from } = editor.getSelection();
  const insertion = transcriptInsertion(editor.getText().slice(0, from), transcript);
  if (!insertion) return;
  editor.insertMention({
    id: `dictation-${Date.now()}`,
    label: insertion,
    kind: 'custom',
    insertText: insertion,
  });
}

function openVoiceSettings(): void {
  getNavigation().navigate(settingsViewDef({ tab: 'voice' }));
}

export function DictationButton({ editorApiRef, shortcutScope, disabled }: DictationButtonProps) {
  const handleTranscript = useCallback(
    (text: string) => {
      const editor = editorApiRef.current;
      if (!editor) return;
      insertTranscriptAtCursor(editor, text);
      editor.focus();
    },
    [editorApiRef]
  );
  const handleError = useCallback((message: string, needsSettings: boolean) => {
    toast.error('Sesle yazma başarısız', {
      description: message,
      action: needsSettings ? { label: 'Ses ayarları', onClick: openVoiceSettings } : undefined,
    });
  }, []);
  const { state, toggle, cancel } = useDictation({
    onTranscript: handleTranscript,
    onError: handleError,
  });

  // Kayıt süresini düzenli aralıkla güncelle.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.kind !== 'recording') return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [state.kind]);

  useEffect(() => {
    if (!shortcutScope) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isDictationShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled || state.kind === 'recording') toggle();
        return;
      }
      if (event.key === 'Escape' && (state.kind === 'recording' || state.kind === 'requesting')) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    shortcutScope.addEventListener('keydown', onKeyDown, { capture: true });
    return () => shortcutScope.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [shortcutScope, toggle, cancel, disabled, state.kind]);

  const recording = state.kind === 'recording';
  const busy = state.kind === 'requesting' || state.kind === 'transcribing';
  const label = dictationLabel(state);

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            variant="ghost"
            size="xs"
            icon={!recording}
            tone={recording ? 'destructive' : undefined}
            onClick={toggle}
            disabled={(disabled && !recording) || state.kind === 'transcribing'}
            aria-label={label}
            aria-pressed={recording}
            data-dictation-state={state.kind}
          >
            {recording ? (
              <>
                <Square className="animate-pulse" aria-hidden />
                <span className="text-xs tabular-nums">{formatElapsed(now - state.startedAt)}</span>
              </>
            ) : busy ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : state.kind === 'error' ? (
              <MicOff aria-hidden />
            ) : (
              <Mic aria-hidden />
            )}
          </Button>
        }
      />
      <Tooltip.Content>
        {state.kind === 'idle' ? `${label} (${SHORTCUT_LABEL})` : label}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
