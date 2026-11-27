import type { AcpElicitationRequest } from '@orkestra/core/runtimes/acp/api/client';
import { Check, ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
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
    const custom = field.customFieldKey ? (draft.customText[field.customFieldKey] ?? '').trim() : '';
    return (Array.isArray(val) && val.length > 0) || custom.length > 0;
  }
  if (field.kind === 'single-select') {
    const custom = field.customFieldKey ? (draft.customText[field.customFieldKey] ?? '').trim() : '';
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

  useEffect(() => {
    setDraft(initialElicitationDraft(fields));
    setStepIndex(0);
  }, [request.requestId, fields]);

  if (request.mode === 'url') {
    return (
      <div
        className="mb-2 w-full overflow-hidden rounded-2xl border border-[#e6dfd4] bg-[#faf8f4]/96 p-4 shadow-[0_8px_28px_-14px_rgba(28,25,23,0.18)] backdrop-blur-md dark:border-[#f3eae0]/[0.09] dark:bg-[#1b1a18]/96 dark:shadow-[0_14px_34px_-16px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,248,240,0.045)]"
        role="dialog"
        aria-label="Ajan sorusu"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13.5px] leading-relaxed font-medium text-[#24211e] dark:text-[#f3efe8]">
            {request.message || 'Devam etmek için aşağıdaki bağlantıyı açın.'}
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-lg p-1 text-[#8a837a] transition-colors hover:bg-[#24211e]/[0.06] hover:text-[#24211e] dark:hover:bg-[#f5eee6]/[0.07] dark:hover:text-[#f3efe8]"
            aria-label="Kapat"
          >
            <X className="size-4" />
          </button>
        </div>
        {request.url && (
          <a
            href={request.url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-[#d97757]/30 bg-[#d97757]/10 px-3 py-1.5 text-[12.5px] font-medium text-[#c96442] transition-colors hover:bg-[#d97757]/18 dark:text-[#e38b6d]"
          >
            <ExternalLink className="size-3.5" />
            <span className="max-w-[420px] truncate">{request.url}</span>
          </a>
        )}
        <div className="mt-3.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="cursor-pointer rounded-xl px-3 py-1.5 text-[12.5px] font-medium text-[#756e65] transition-colors hover:bg-[#24211e]/[0.05] hover:text-[#24211e] dark:text-[#969087] dark:hover:bg-[#f5eee6]/[0.06] dark:hover:text-[#f3efe8]"
          >
            Atla
          </button>
          <button
            type="button"
            onClick={() => onSubmit({})}
            className="cursor-pointer rounded-xl bg-[#c96442] px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#b85838] dark:bg-[#d97757] dark:hover:bg-[#e08465]"
          >
            Tamamladım
          </button>
        </div>
      </div>
    );
  }

  const totalSteps = Math.max(1, fields.length);
  const currentField = fields[Math.min(stepIndex, fields.length - 1)];
  const isLastStep = stepIndex >= totalSteps - 1;
  const allSatisfied = fields.every((field) => isFieldSatisfied(field, draft));
  const currentSatisfied = currentField ? isFieldSatisfied(currentField, draft) : true;

  const setSingle = (key: string, value: string, customKey?: string) => {
    setDraft((prev) => ({
      ...prev,
      values: { ...prev.values, [key]: prev.values[key] === value ? '' : value },
      ...(customKey ? { customText: { ...prev.customText, [customKey]: '' } } : {}),
    }));
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

  return (
    <div
      className="mb-2 w-full overflow-hidden rounded-2xl border border-[#e6dfd4] bg-[#faf8f4]/96 shadow-[0_8px_28px_-14px_rgba(28,25,23,0.18)] backdrop-blur-md dark:border-[#f3eae0]/[0.09] dark:bg-[#1b1a18]/96 dark:shadow-[0_14px_34px_-16px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,248,240,0.045)]"
      role="dialog"
      aria-label="Ajan sorusu"
    >
      {/* Üst başlık + çoklu soru sekmeleri */}
      <div className="flex items-center justify-between gap-2 border-b border-[#24211e]/[0.06] px-4 py-2.5 dark:border-[#f5eee6]/[0.06]">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="inline-block size-2 shrink-0 rounded-full bg-[#c96442] dark:bg-[#d97757]"
            aria-hidden="true"
          />
          {totalSteps > 1 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {fields.map((field, idx) => {
                const active = idx === stepIndex;
                const answered =
                  field.kind === 'multi-select'
                    ? (Array.isArray(draft.values[field.key]) &&
                        (draft.values[field.key] as string[]).length > 0) ||
                      Boolean(field.customFieldKey && draft.customText[field.customFieldKey]?.trim())
                    : field.kind === 'single-select'
                      ? Boolean(draft.values[field.key]) ||
                        Boolean(field.customFieldKey && draft.customText[field.customFieldKey]?.trim())
                      : field.kind === 'boolean'
                        ? true
                        : Boolean(
                            typeof draft.values[field.key] === 'string' &&
                              (draft.values[field.key] as string).trim()
                          );
                return (
                  <button
                    key={field.key}
                    type="button"
                    onClick={() => setStepIndex(idx)}
                    className={
                      active
                        ? 'cursor-pointer rounded-lg bg-[#c96442]/12 px-2 py-0.5 text-[11.5px] font-medium text-[#c96442] dark:bg-[#d97757]/16 dark:text-[#e69274]'
                        : answered
                          ? 'cursor-pointer rounded-lg px-2 py-0.5 text-[11.5px] text-[#6e675e] transition-colors hover:bg-[#24211e]/[0.05] dark:text-[#a8a096] dark:hover:bg-[#f5eee6]/[0.05]'
                          : 'cursor-pointer rounded-lg px-2 py-0.5 text-[11.5px] text-[#9b948a] transition-colors hover:bg-[#24211e]/[0.05] dark:text-[#736d65] dark:hover:bg-[#f5eee6]/[0.05]'
                    }
                  >
                    {field.header || `Soru ${idx + 1}`}
                  </button>
                );
              })}
            </div>
          ) : (
            <span className="truncate text-[12px] font-medium text-[#6e675e] dark:text-[#a39c92]">
              {currentField?.header || 'Seçim bekleniyor'}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {queueCount > 1 && (
            <span className="text-[11px] font-medium tabular-nums text-[#8a837a]">
              1 / {queueCount} istek
            </span>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-lg p-1 text-[#8a837a] transition-colors hover:bg-[#24211e]/[0.06] hover:text-[#24211e] dark:hover:bg-[#f5eee6]/[0.07] dark:hover:text-[#f3efe8]"
            aria-label="İptal et"
            title="İptal et"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Aktif soru gövdesi */}
      <div className="max-h-[320px] overflow-y-auto px-4 py-3">
        {currentField ? (
          <div>
            <p className="mb-2.5 text-[13.5px] leading-[1.45] font-medium text-[#24211e] dark:text-[#f3efe8]">
              {currentField.prompt}
              {currentField.kind === 'multi-select' && (
                <span className="ml-1.5 text-[11.5px] font-normal text-[#8a837a] dark:text-[#8f887e]">
                  (birden fazla seçebilirsin)
                </span>
              )}
            </p>

            {currentField.kind === 'single-select' && (
              <div className="space-y-1.5">
                {currentField.options.map((option, optIdx) => {
                  const selected = draft.values[currentField.key] === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() =>
                        setSingle(currentField.key, option.value, currentField.customFieldKey)
                      }
                      className={
                        selected
                          ? 'flex w-full cursor-pointer items-start gap-2.5 rounded-xl border border-[#c96442]/45 bg-[#c96442]/[0.08] px-3 py-2 text-left transition-colors dark:border-[#d97757]/45 dark:bg-[#d97757]/[0.11]'
                          : 'flex w-full cursor-pointer items-start gap-2.5 rounded-xl border border-[#24211e]/[0.07] bg-transparent px-3 py-2 text-left transition-colors hover:border-[#24211e]/[0.14] hover:bg-[#24211e]/[0.025] dark:border-[#f5eee6]/[0.07] dark:hover:border-[#f5eee6]/[0.14] dark:hover:bg-[#f5eee6]/[0.03]'
                      }
                    >
                      <span
                        className={
                          selected
                            ? 'mt-[1px] flex size-5 shrink-0 items-center justify-center rounded-full bg-[#c96442] text-[11px] font-semibold text-white dark:bg-[#d97757]'
                            : 'mt-[1px] flex size-5 shrink-0 items-center justify-center rounded-full border border-[#24211e]/20 text-[11px] font-medium text-[#7d766d] dark:border-[#f5eee6]/18 dark:text-[#969087]'
                        }
                      >
                        {selected ? <Check className="size-3" /> : optIdx + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-[13px] leading-[1.4] font-medium text-[#24211e] dark:text-[#f3efe8]">
                          <span>{option.label}</span>
                          {option.recommended && (
                            <span className="rounded-md bg-[#c96442]/12 px-1.5 py-0.5 text-[10.5px] font-medium text-[#c96442] dark:bg-[#d97757]/18 dark:text-[#e69274]">
                              Önerilen
                            </span>
                          )}
                        </span>
                        {option.description && (
                          <span className="mt-0.5 block text-[12px] leading-[1.4] text-[#787168] dark:text-[#969087]">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {currentField.customFieldKey && (
                  <div className="pt-1">
                    <input
                      type="text"
                      value={draft.customText[currentField.customFieldKey] ?? ''}
                      onChange={(e) =>
                        setCustom(currentField.customFieldKey!, e.target.value, currentField.key)
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && isLastStep && allSatisfied) {
                          e.preventDefault();
                          handleConfirm();
                        }
                      }}
                      placeholder={currentField.customPlaceholder ?? 'Diğer (kendi cevabını yaz)…'}
                      className="w-full rounded-xl border border-[#24211e]/[0.09] bg-transparent px-3 py-2 text-[12.5px] text-[#24211e] placeholder:text-[#9b948a] focus:border-[#c96442]/50 focus:outline-none dark:border-[#f5eee6]/[0.09] dark:text-[#f3efe8] dark:placeholder:text-[#787168] dark:focus:border-[#d97757]/55"
                    />
                  </div>
                )}
              </div>
            )}

            {currentField.kind === 'multi-select' && (
              <div className="space-y-1.5">
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
                          ? 'flex w-full cursor-pointer items-start gap-2.5 rounded-xl border border-[#c96442]/45 bg-[#c96442]/[0.08] px-3 py-2 text-left transition-colors dark:border-[#d97757]/45 dark:bg-[#d97757]/[0.11]'
                          : 'flex w-full cursor-pointer items-start gap-2.5 rounded-xl border border-[#24211e]/[0.07] bg-transparent px-3 py-2 text-left transition-colors hover:border-[#24211e]/[0.14] hover:bg-[#24211e]/[0.025] dark:border-[#f5eee6]/[0.07] dark:hover:border-[#f5eee6]/[0.14] dark:hover:bg-[#f5eee6]/[0.03]'
                      }
                    >
                      <span
                        className={
                          checked
                            ? 'mt-[2px] flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-[#c96442] text-white dark:bg-[#d97757]'
                            : 'mt-[2px] flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-[#24211e]/25 dark:border-[#f5eee6]/22'
                        }
                      >
                        {checked && <Check className="size-3 stroke-[2.5]" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-[13px] leading-[1.4] font-medium text-[#24211e] dark:text-[#f3efe8]">
                          <span>{option.label}</span>
                          {option.recommended && (
                            <span className="rounded-md bg-[#c96442]/12 px-1.5 py-0.5 text-[10.5px] font-medium text-[#c96442] dark:bg-[#d97757]/18 dark:text-[#e69274]">
                              Önerilen
                            </span>
                          )}
                        </span>
                        {option.description && (
                          <span className="mt-0.5 block text-[12px] leading-[1.4] text-[#787168] dark:text-[#969087]">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {currentField.customFieldKey && (
                  <div className="pt-1">
                    <input
                      type="text"
                      value={draft.customText[currentField.customFieldKey] ?? ''}
                      onChange={(e) => setCustom(currentField.customFieldKey!, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && isLastStep && allSatisfied) {
                          e.preventDefault();
                          handleConfirm();
                        }
                      }}
                      placeholder={currentField.customPlaceholder ?? 'Diğer (ek seçenek yaz)…'}
                      className="w-full rounded-xl border border-[#24211e]/[0.09] bg-transparent px-3 py-2 text-[12.5px] text-[#24211e] placeholder:text-[#9b948a] focus:border-[#c96442]/50 focus:outline-none dark:border-[#f5eee6]/[0.09] dark:text-[#f3efe8] dark:placeholder:text-[#787168] dark:focus:border-[#d97757]/55"
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
                    ? 'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-[#c96442]/45 bg-[#c96442]/[0.08] px-3 py-2.5 text-left transition-colors dark:border-[#d97757]/45 dark:bg-[#d97757]/[0.11]'
                    : 'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-[#24211e]/[0.08] px-3 py-2.5 text-left transition-colors hover:bg-[#24211e]/[0.025] dark:border-[#f5eee6]/[0.08] dark:hover:bg-[#f5eee6]/[0.03]'
                }
              >
                <span
                  className={
                    draft.values[currentField.key]
                      ? 'flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-[#c96442] text-white dark:bg-[#d97757]'
                      : 'flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-[#24211e]/25 dark:border-[#f5eee6]/22'
                  }
                >
                  {draft.values[currentField.key] && <Check className="size-3 stroke-[2.5]" />}
                </span>
                <span className="text-[13px] font-medium text-[#24211e] dark:text-[#f3efe8]">
                  {draft.values[currentField.key] ? 'Evet, onaylıyorum' : 'Hayır'}
                </span>
              </button>
            )}

            {currentField.kind === 'text' && (
              <input
                type={currentField.inputType === 'text' ? 'text' : 'number'}
                step={currentField.inputType === 'integer' ? '1' : 'any'}
                value={typeof draft.values[currentField.key] === 'string' ? (draft.values[currentField.key] as string) : ''}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    values: { ...prev.values, [currentField.key]: e.target.value },
                  }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && isLastStep && allSatisfied) {
                    e.preventDefault();
                    handleConfirm();
                  }
                }}
                placeholder={currentField.placeholder ?? 'Yanıtını yaz…'}
                className="w-full rounded-xl border border-[#24211e]/[0.1] bg-transparent px-3 py-2 text-[13px] text-[#24211e] placeholder:text-[#9b948a] focus:border-[#c96442]/50 focus:outline-none dark:border-[#f5eee6]/[0.1] dark:text-[#f3efe8] dark:placeholder:text-[#787168] dark:focus:border-[#d97757]/55"
              />
            )}
          </div>
        ) : (
          <p className="text-[13.5px] leading-relaxed text-[#24211e] dark:text-[#f3efe8]">
            {request.message}
          </p>
        )}
      </div>

      {/* Alt eylem çubuğu */}
      <div className="flex items-center justify-between gap-2 border-t border-[#24211e]/[0.06] px-4 py-2.5 dark:border-[#f5eee6]/[0.06]">
        <button
          type="button"
          onClick={onSkip}
          className="cursor-pointer rounded-xl px-2.5 py-1.5 text-[12px] font-medium text-[#7d766d] transition-colors hover:bg-[#24211e]/[0.05] hover:text-[#24211e] dark:text-[#969087] dark:hover:bg-[#f5eee6]/[0.06] dark:hover:text-[#f3efe8]"
        >
          Atla
        </button>

        <div className="flex items-center gap-1.5">
          {totalSteps > 1 && stepIndex > 0 && (
            <button
              type="button"
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
              className="inline-flex cursor-pointer items-center gap-1 rounded-xl border border-[#24211e]/[0.1] px-2.5 py-1.5 text-[12px] font-medium text-[#5c564e] transition-colors hover:bg-[#24211e]/[0.04] dark:border-[#f5eee6]/[0.1] dark:text-[#c7c0b6] dark:hover:bg-[#f5eee6]/[0.05]"
            >
              <ChevronLeft className="size-3.5" />
              Önceki
            </button>
          )}
          {totalSteps > 1 && !isLastStep ? (
            <button
              type="button"
              disabled={!currentSatisfied}
              onClick={() => setStepIndex((i) => Math.min(totalSteps - 1, i + 1))}
              className="inline-flex cursor-pointer items-center gap-1 rounded-xl bg-[#c96442] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#b85838] disabled:cursor-not-allowed disabled:opacity-45 dark:bg-[#d97757] dark:hover:bg-[#e08465]"
            >
              Sonraki
              <ChevronRight className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              disabled={!allSatisfied}
              onClick={handleConfirm}
              className="cursor-pointer rounded-xl bg-[#c96442] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#b85838] disabled:cursor-not-allowed disabled:opacity-45 dark:bg-[#d97757] dark:hover:bg-[#e08465]"
            >
              Gönder
            </button>
          )}
        </div>
      </div>
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
