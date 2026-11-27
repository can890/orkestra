import type { AcpElicitationRequest } from '@orkestra/core/runtimes/acp/api/client';
import { Check, ChevronLeft, ChevronRight, ExternalLink, Pencil, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AcpChatStore } from './acp-chat-store';
import {
  buildElicitationContent,
  initialElicitationDraft,
  parseElicitationFields,
  type ElicitationDraft,
  type ElicitationField,
} from './elicitation-schema';

function isFieldSatisfied(field: ElicitationField, draft: ElicitationDraft): boolean {
  if (!field.required) return true;
  const val = draft.values[field.key];
  if (field.kind === 'multi-select') {
    const custom = field.customFieldKey
      ? (draft.customText[field.customFieldKey] ?? '').trim()
      : '';
    return (Array.isArray(val) && val.length > 0) || custom.length > 0;
  }
  if (field.kind === 'single-select') {
    const custom = field.customFieldKey
      ? (draft.customText[field.customFieldKey] ?? '').trim()
      : '';
    return (typeof val === 'string' && val.length > 0) || custom.length > 0;
  }
  if (field.kind === 'boolean') return true;
  return typeof val === 'string' && val.trim().length > 0;
}

function ElicitationFormCard({
  request,
  queueCount,
  onSubmit,
  onSkip,
  onCancel,
}: {
  request: AcpElicitationRequest;
  queueCount: number;
  onSubmit: (content: Record<string, string | number | boolean | string[]>) => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const fields = useMemo(() => parseElicitationFields(request), [request]);
  const [draft, setDraft] = useState<ElicitationDraft>(() => initialElicitationDraft(fields));
  const [stepIndex, setStepIndex] = useState(0);
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(initialElicitationDraft(fields));
    setStepIndex(0);
  }, [request.requestId, fields]);

  const totalSteps = Math.max(1, fields.length);
  const currentField = fields[Math.min(stepIndex, fields.length - 1)];
  const isLastStep = stepIndex >= totalSteps - 1;
  const allSatisfied = fields.every((field) => isFieldSatisfied(field, draft));
  const currentSatisfied = currentField ? isFieldSatisfied(currentField, draft) : true;

  const setSingleAndAdvance = (key: string, value: string, customKey?: string) => {
    const nextDraft: ElicitationDraft = {
      ...draft,
      values: { ...draft.values, [key]: value },
      ...(customKey ? { customText: { ...draft.customText, [customKey]: '' } } : {}),
    };
    setDraft(nextDraft);
    if (totalSteps > 1 && !isLastStep) {
      setStepIndex((i) => Math.min(totalSteps - 1, i + 1));
      return;
    }
    if (fields.every((field) => isFieldSatisfied(field, nextDraft))) {
      onSubmit(buildElicitationContent(fields, nextDraft));
    }
  };

  const toggleMulti = (key: string, value: string) => {
    setDraft((prev) => {
      const current = Array.isArray(prev.values[key]) ? (prev.values[key] as string[]) : [];
      const exists = current.includes(value);
      const next = exists ? current.filter((v) => v !== value) : [...current, value];
      return { ...prev, values: { ...prev.values, [key]: next } };
    });
  };

  const setCustom = (customKey: string, text: string, clearSingleKey?: string) => {
    setDraft((prev) => ({
      ...prev,
      ...(clearSingleKey && text.trim()
        ? { values: { ...prev.values, [clearSingleKey]: '' } }
        : {}),
      customText: { ...prev.customText, [customKey]: text },
    }));
  };

  const handleConfirm = () => {
    if (!allSatisfied) return;
    onSubmit(buildElicitationContent(fields, draft));
  };

  const handleAdvanceOrSubmit = () => {
    if (totalSteps > 1 && !isLastStep) {
      if (currentSatisfied) setStepIndex((i) => Math.min(totalSteps - 1, i + 1));
      return;
    }
    handleConfirm();
  };

  // Klavye kısayolları: 1-9 seçenek seçer, Enter devam eder/gönderir, Esc kapatır.
  useEffect(() => {
    if (request.mode === 'url') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (isTyping) return;

      if (
        currentField &&
        (currentField.kind === 'single-select' || currentField.kind === 'multi-select')
      ) {
        const digit = Number(e.key);
        if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
          const opt = currentField.options[digit - 1];
          if (opt) {
            e.preventDefault();
            if (currentField.kind === 'single-select') {
              setSingleAndAdvance(currentField.key, opt.value, currentField.customFieldKey);
            } else {
              toggleMulti(currentField.key, opt.value);
            }
            return;
          }
          if (currentField.customFieldKey && digit === currentField.options.length + 1) {
            e.preventDefault();
            customInputRef.current?.focus();
            return;
          }
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAdvanceOrSubmit();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (request.mode === 'url') {
    return (
      <div
        className="mb-2 w-full overflow-hidden rounded-2xl border border-border bg-(--em-surface-base-emphasis) p-4 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-label="Ajan sorusu"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13.5px] leading-relaxed font-medium text-foreground">
            {request.message || 'Devam etmek için aşağıdaki bağlantıyı açın.'}
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-lg p-1 text-foreground-passive transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Kapat"
          >
            <X className="size-3.5" />
          </button>
        </div>
        {request.url && (
          <a
            href={request.url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-foreground/[0.04] px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.08]"
          >
            <ExternalLink className="size-3.5 text-foreground-muted" />
            <span className="max-w-[420px] truncate">{request.url}</span>
          </a>
        )}
        <div className="mt-3.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="cursor-pointer rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-foreground-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            Atla
          </button>
          <button
            type="button"
            onClick={() => onSubmit({})}
            className="cursor-pointer rounded-lg bg-foreground px-3.5 py-1.5 text-[12px] font-medium text-background transition-opacity hover:opacity-90"
          >
            Tamamladım
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mb-2 w-full overflow-hidden rounded-2xl border border-border bg-(--em-surface-base-emphasis) shadow-[0_12px_32px_-12px_rgba(0,0,0,0.45)]"
      role="dialog"
      aria-label="Ajan sorusu"
    >
      {/* Üst başlık: doğrudan soru metni + sağda sade adım sayacı ve kapat */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5">
        <div className="min-w-0 flex-1">
          {currentField?.header && (
            <span className="mb-1 block text-[11px] font-medium tracking-[0.01em] text-foreground-passive">
              {currentField.header}
            </span>
          )}
          <p className="text-[13.5px] leading-[1.45] font-medium text-foreground">
            {currentField ? currentField.prompt : request.message}
            {currentField?.kind === 'multi-select' && (
              <span className="ml-1.5 text-[11.5px] font-normal text-foreground-passive">
                (birden fazla seçebilirsin)
              </span>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {totalSteps > 1 && (
            <div className="mr-1 flex items-center gap-0.5 rounded-lg border border-border/70 bg-foreground/[0.03] px-1 py-0.5">
              <button
                type="button"
                disabled={stepIndex === 0}
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                className="cursor-pointer rounded p-0.5 text-foreground-muted transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-default disabled:opacity-30"
                aria-label="Önceki soru"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <span className="px-1 text-[11px] font-medium tabular-nums text-foreground-muted">
                {stepIndex + 1} / {totalSteps}
              </span>
              <button
                type="button"
                disabled={isLastStep}
                onClick={() => setStepIndex((i) => Math.min(totalSteps - 1, i + 1))}
                className="cursor-pointer rounded p-0.5 text-foreground-muted transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-default disabled:opacity-30"
                aria-label="Sonraki soru"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          )}
          {queueCount > 1 && (
            <span className="mr-1 text-[11px] tabular-nums text-foreground-passive">
              1/{queueCount}
            </span>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-lg p-1 text-foreground-passive transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="İptal et"
            title="İptal et (Esc)"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Seçenekler + aynı soru altında satır içi "Diğer" yanıtı */}
      {currentField && (
        <div className="max-h-[300px] overflow-y-auto px-3 pb-2.5">
          {currentField.kind === 'single-select' && (
            <div className="space-y-1">
              {currentField.options.map((option, optIdx) => {
                const selected = draft.values[currentField.key] === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() =>
                      setSingleAndAdvance(currentField.key, option.value, currentField.customFieldKey)
                    }
                    className={
                      selected
                        ? 'flex w-full cursor-pointer items-start gap-2.5 rounded-xl border border-foreground/[0.15] bg-foreground/[0.075] px-3 py-2 text-left transition-colors'
                        : 'flex w-full cursor-pointer items-start gap-2.5 rounded-xl border border-transparent bg-transparent px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]'
                    }
                  >
                    <span
                      className={
                        selected
                          ? 'mt-[1px] flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background'
                          : 'mt-[1px] flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-[11px] font-medium text-foreground-passive'
                      }
                    >
                      {selected ? <Check className="size-3 stroke-[2.5]" /> : optIdx + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5 text-[13px] leading-[1.4] font-medium text-foreground">
                        <span>{option.label}</span>
                        {option.recommended && (
                          <span className="rounded-md bg-foreground/[0.08] px-1.5 py-0.5 text-[10.5px] font-medium text-foreground-muted">
                            Önerilen
                          </span>
                        )}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block text-[12px] leading-[1.4] text-foreground-passive">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}

              {currentField.customFieldKey && (
                <div
                  className={
                    (draft.customText[currentField.customFieldKey] ?? '').trim()
                      ? 'flex items-center gap-2.5 rounded-xl border border-foreground/[0.15] bg-foreground/[0.06] px-3 py-2 transition-colors'
                      : 'flex items-center gap-2.5 rounded-xl border border-transparent px-3 py-2 transition-colors focus-within:border-foreground/[0.15] focus-within:bg-foreground/[0.05] hover:bg-foreground/[0.04]'
                  }
                  onClick={() => customInputRef.current?.focus()}
                >
                  <span
                    className={
                      (draft.customText[currentField.customFieldKey] ?? '').trim()
                        ? 'flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground text-background'
                        : 'flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground-passive'
                    }
                  >
                    <Pencil className="size-3" />
                  </span>
                  <input
                    ref={customInputRef}
                    type="text"
                    value={draft.customText[currentField.customFieldKey] ?? ''}
                    onChange={(e) =>
                      setCustom(currentField.customFieldKey!, e.target.value, currentField.key)
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAdvanceOrSubmit();
                      }
                    }}
                    placeholder="Başka bir şey yaz…"
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-foreground-passive focus:outline-none"
                  />
                </div>
              )}
            </div>
          )}

          {currentField.kind === 'multi-select' && (
            <div className="space-y-1">
              {currentField.options.map((option) => {
                const selectedArr = Array.isArray(draft.values[currentField.key])
                  ? (draft.values[currentField.key] as string[])
                  : [];
                const checked = selectedArr.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggleMulti(currentField.key, option.value)}
                    className={
                      checked
                        ? 'flex w-full cursor-pointer items-start gap-2.5 rounded-xl border border-foreground/[0.15] bg-foreground/[0.075] px-3 py-2 text-left transition-colors'
                        : 'flex w-full cursor-pointer items-start gap-2.5 rounded-xl border border-transparent bg-transparent px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]'
                    }
                  >
                    <span
                      className={
                        checked
                          ? 'mt-[2px] flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-foreground bg-foreground text-background'
                          : 'mt-[2px] flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-foreground/25'
                      }
                    >
                      {checked && <Check className="size-3 stroke-[2.5]" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5 text-[13px] leading-[1.4] font-medium text-foreground">
                        <span>{option.label}</span>
                        {option.recommended && (
                          <span className="rounded-md bg-foreground/[0.08] px-1.5 py-0.5 text-[10.5px] font-medium text-foreground-muted">
                            Önerilen
                          </span>
                        )}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block text-[12px] leading-[1.4] text-foreground-passive">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}

              {currentField.customFieldKey && (
                <div
                  className={
                    (draft.customText[currentField.customFieldKey] ?? '').trim()
                      ? 'flex items-center gap-2.5 rounded-xl border border-foreground/[0.15] bg-foreground/[0.06] px-3 py-2 transition-colors'
                      : 'flex items-center gap-2.5 rounded-xl border border-transparent px-3 py-2 transition-colors focus-within:border-foreground/[0.15] focus-within:bg-foreground/[0.05] hover:bg-foreground/[0.04]'
                  }
                  onClick={() => customInputRef.current?.focus()}
                >
                  <span
                    className={
                      (draft.customText[currentField.customFieldKey] ?? '').trim()
                        ? 'flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-foreground text-background'
                        : 'flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-foreground/[0.06] text-foreground-passive'
                    }
                  >
                    <Pencil className="size-2.5" />
                  </span>
                  <input
                    ref={customInputRef}
                    type="text"
                    value={draft.customText[currentField.customFieldKey] ?? ''}
                    onChange={(e) => setCustom(currentField.customFieldKey!, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAdvanceOrSubmit();
                      }
                    }}
                    placeholder="Başka bir şey ekle…"
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-foreground-passive focus:outline-none"
                  />
                </div>
              )}
            </div>
          )}

          {currentField.kind === 'boolean' && (
            <button
              type="button"
              role="checkbox"
              aria-checked={Boolean(draft.values[currentField.key])}
              onClick={() =>
                setDraft((prev) => ({
                  ...prev,
                  values: { ...prev.values, [currentField.key]: !prev.values[currentField.key] },
                }))
              }
              className={
                draft.values[currentField.key]
                  ? 'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-foreground/[0.15] bg-foreground/[0.075] px-3 py-2 text-left transition-colors'
                  : 'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]'
              }
            >
              <span
                className={
                  draft.values[currentField.key]
                    ? 'flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-foreground bg-foreground text-background'
                    : 'flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-foreground/25'
                }
              >
                {draft.values[currentField.key] && <Check className="size-3 stroke-[2.5]" />}
              </span>
              <span className="text-[13px] font-medium text-foreground">
                {draft.values[currentField.key] ? 'Evet, onaylıyorum' : 'Hayır'}
              </span>
            </button>
          )}

          {currentField.kind === 'text' && (
            <input
              type={currentField.inputType === 'text' ? 'text' : 'number'}
              step={currentField.inputType === 'integer' ? '1' : 'any'}
              value={
                typeof draft.values[currentField.key] === 'string'
                  ? (draft.values[currentField.key] as string)
                  : ''
              }
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  values: { ...prev.values, [currentField.key]: e.target.value },
                }))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAdvanceOrSubmit();
                }
              }}
              placeholder={currentField.placeholder ?? 'Yanıtını yaz…'}
              className="w-full rounded-xl border border-border bg-foreground/[0.03] px-3 py-2 text-[13px] text-foreground placeholder:text-foreground-passive focus:border-foreground/30 focus:outline-none"
            />
          )}
        </div>
      )}

      {/* Alt eylem çubuğu: tekli seçimde özel metin yazılmıyorsa Devam/Gönder gizlenir */}
      {(() => {
        const singleCustomTyped =
          currentField?.kind === 'single-select' &&
          Boolean(
            currentField.customFieldKey &&
              (draft.customText[currentField.customFieldKey] ?? '').trim()
          );
        const showConfirmButton =
          currentField?.kind !== 'single-select' || singleCustomTyped;

        return (
          <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3.5 py-2">
            <button
              type="button"
              onClick={onSkip}
              className="cursor-pointer rounded-lg px-2.5 py-1 text-[12px] font-medium text-foreground-passive transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
            >
              Atla
            </button>

            <div className="flex items-center gap-1.5">
              {totalSteps > 1 && stepIndex > 0 && (
                <button
                  type="button"
                  onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                  className="cursor-pointer rounded-lg px-2.5 py-1 text-[12px] font-medium text-foreground-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  Geri
                </button>
              )}
              {showConfirmButton &&
                (totalSteps > 1 && !isLastStep ? (
                  <button
                    type="button"
                    disabled={!currentSatisfied}
                    onClick={() => setStepIndex((i) => Math.min(totalSteps - 1, i + 1))}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-foreground px-3 py-1 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    Devam
                    <ChevronRight className="size-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!allSatisfied}
                    onClick={handleConfirm}
                    className="cursor-pointer rounded-lg bg-foreground px-3.5 py-1 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    Gönder
                  </button>
                ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/**
 * Sağlayıcıların (Claude AskUserQuestion, Antigravity ask_question, Codex request_user_input,
 * MCP elicitation) gönderdiği etkileşimli seçenek/kutucuk/form sorularını sunar.
 */
export const ElicitationCard = observer(function ElicitationCard({
  store,
}: {
  store: AcpChatStore;
}) {
  const queue = store.elicitationQueue;
  const active = queue[0];
  if (!active || !store.liveActionsEnabled) return null;

  return (
    <ElicitationFormCard
      request={active}
      queueCount={queue.length}
      onSubmit={(content) => store.resolveElicitation('accept', content)}
      onSkip={() => store.resolveElicitation('decline')}
      onCancel={() => store.resolveElicitation('cancel')}
    />
  );
});
