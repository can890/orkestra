import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildElicitationContent,
  initialElicitationDraft,
  parseElicitationFields,
  type ElicitationAction,
  type ElicitationContent,
  type ElicitationDraft,
  type ElicitationField,
  type ElicitationRequestView,
} from '@/core/elicitation-schema';
import { triggerHaptic } from '@/core/native-bridge';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  XIcon,
} from './icons';

function PencilIcon(props: { size?: number }) {
  const size = props.size ?? 13;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    </svg>
  );
}

export function isElicitationFieldSatisfied(
  field: ElicitationField,
  draft: ElicitationDraft
): boolean {
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

export interface ElicitationFormCardProps {
  request: ElicitationRequestView;
  queueCount: number;
  onResolve: (
    requestId: string,
    action: ElicitationAction,
    content?: ElicitationContent
  ) => Promise<void> | void;
}

export function ElicitationFormCard({
  request,
  queueCount,
  onResolve,
}: ElicitationFormCardProps) {
  const fields = useMemo(() => parseElicitationFields(request), [request]);
  const [draft, setDraft] = useState<ElicitationDraft>(() => initialElicitationDraft(fields));
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setDraft(initialElicitationDraft(fields));
    setStepIndex(0);
    submittingRef.current = false;
    setSubmitting(false);
  }, [request.requestId, fields]);

  const runResolve = useCallback(
    async (action: ElicitationAction, content?: ElicitationContent) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      triggerHaptic(action === 'accept' ? 'medium' : 'light');
      try {
        await onResolve(request.requestId, action, content);
      } finally {
        if (mountedRef.current) {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    },
    [onResolve, request.requestId]
  );

  const totalSteps = Math.max(1, fields.length);
  const clampedStep = Math.min(stepIndex, Math.max(0, fields.length - 1));
  const currentField = fields[clampedStep];
  const isLastStep = clampedStep >= totalSteps - 1;
  const allSatisfied = fields.every((field) => isElicitationFieldSatisfied(field, draft));
  const currentSatisfied = currentField ? isElicitationFieldSatisfied(currentField, draft) : true;

  const setSingleAndAdvance = (key: string, value: string, customKey?: string) => {
    if (submittingRef.current) return;
    const nextDraft: ElicitationDraft = {
      ...draft,
      values: { ...draft.values, [key]: value },
      ...(customKey ? { customText: { ...draft.customText, [customKey]: '' } } : {}),
    };
    setDraft(nextDraft);
    if (totalSteps > 1 && !isLastStep) {
      triggerHaptic('light');
      setStepIndex((i) => Math.min(totalSteps - 1, i + 1));
      return;
    }
    if (fields.every((field) => isElicitationFieldSatisfied(field, nextDraft))) {
      void runResolve('accept', buildElicitationContent(fields, nextDraft));
    }
  };

  const toggleMulti = (key: string, value: string) => {
    if (submittingRef.current) return;
    triggerHaptic('light');
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
    if (submittingRef.current || !allSatisfied) return;
    void runResolve('accept', buildElicitationContent(fields, draft));
  };

  const handleAdvanceOrSubmit = () => {
    if (submittingRef.current) return;
    if (totalSteps > 1 && !isLastStep) {
      if (currentSatisfied) {
        triggerHaptic('light');
        setStepIndex((i) => Math.min(totalSteps - 1, i + 1));
      }
      return;
    }
    handleConfirm();
  };

  // Harici klavye kısayolları: 1-9 seçenek seçer, Enter devam eder/gönderir, Esc iptal eder.
  useEffect(() => {
    if (request.mode === 'url') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (submittingRef.current) return;
      const target = e.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if (e.key === 'Escape') {
        e.preventDefault();
        void runResolve('cancel');
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
      <section className="elicit-card" role="dialog" aria-label="Ajan sorusu">
        <div className="elicit-head">
          <div className="elicit-head-text">
            <p className="elicit-prompt">
              {request.message || 'Devam etmek için aşağıdaki bağlantıyı açın.'}
            </p>
          </div>
          <div className="elicit-head-controls">
            {queueCount > 1 ? (
              <span className="elicit-queue-badge mono">1/{queueCount}</span>
            ) : null}
            <button
              type="button"
              className="elicit-icon-btn"
              disabled={submitting}
              onClick={() => void runResolve('cancel')}
              aria-label="Kapat"
            >
              <XIcon size={15} />
            </button>
          </div>
        </div>
        {request.url ? (
          <div className="elicit-body">
            <a
              href={request.url}
              target="_blank"
              rel="noreferrer"
              className="elicit-url-link"
            >
              <ExternalLinkIcon size={14} />
              <span className="elicit-url-text">{request.url}</span>
            </a>
          </div>
        ) : null}
        <div className="elicit-foot">
          <button
            type="button"
            className="elicit-skip-btn"
            disabled={submitting}
            onClick={() => void runResolve('decline')}
          >
            Atla
          </button>
          <div className="elicit-foot-right">
            <button
              type="button"
              className="elicit-primary-btn"
              disabled={submitting}
              onClick={() => void runResolve('accept', {})}
            >
              {submitting ? 'Gönderiliyor…' : 'Tamamladım'}
            </button>
          </div>
        </div>
      </section>
    );
  }

  const singleCustomTyped =
    currentField?.kind === 'single-select' &&
    Boolean(
      currentField.customFieldKey &&
        (draft.customText[currentField.customFieldKey] ?? '').trim()
    );
  const showConfirmButton = currentField?.kind !== 'single-select' || singleCustomTyped;

  return (
    <section
      className={`elicit-card ${submitting ? 'is-submitting' : ''}`}
      role="dialog"
      aria-label="Ajan sorusu"
    >
      <div className="elicit-head">
        <div className="elicit-head-text">
          {currentField?.header ? (
            <span className="elicit-header-kicker">{currentField.header}</span>
          ) : null}
          <p className="elicit-prompt">
            {currentField ? currentField.prompt : request.message}
            {currentField?.kind === 'multi-select' ? (
              <span className="elicit-multi-hint"> (birden fazla seçebilirsin)</span>
            ) : null}
          </p>
        </div>

        <div className="elicit-head-controls">
          {totalSteps > 1 ? (
            <div className="elicit-stepper" aria-label="Soru adımı">
              <button
                type="button"
                className="elicit-step-btn"
                disabled={submitting || clampedStep === 0}
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                aria-label="Önceki soru"
              >
                <ChevronLeftIcon size={14} />
              </button>
              <span className="elicit-step-count mono">
                {clampedStep + 1} / {totalSteps}
              </span>
              <button
                type="button"
                className="elicit-step-btn"
                disabled={submitting || isLastStep}
                onClick={() => setStepIndex((i) => Math.min(totalSteps - 1, i + 1))}
                aria-label="Sonraki soru"
              >
                <ChevronRightIcon size={14} />
              </button>
            </div>
          ) : null}
          {queueCount > 1 ? (
            <span className="elicit-queue-badge mono">1/{queueCount}</span>
          ) : null}
          <button
            type="button"
            className="elicit-icon-btn"
            disabled={submitting}
            onClick={() => void runResolve('cancel')}
            aria-label="İptal et"
            title="İptal et"
          >
            <XIcon size={15} />
          </button>
        </div>
      </div>

      {currentField ? (
        <div className="elicit-body">
          {currentField.kind === 'single-select' ? (
            <div className="elicit-options">
              {currentField.options.map((option, optIdx) => {
                const selected = draft.values[currentField.key] === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={submitting}
                    aria-pressed={selected}
                    onClick={() =>
                      setSingleAndAdvance(currentField.key, option.value, currentField.customFieldKey)
                    }
                    className={`elicit-option ${selected ? 'is-selected' : ''}`}
                  >
                    <span className={`elicit-index-badge ${selected ? 'is-selected' : ''}`}>
                      {selected ? <CheckIcon size={12} /> : optIdx + 1}
                    </span>
                    <span className="elicit-option-copy">
                      <span className="elicit-option-title">
                        <span>{option.label}</span>
                        {option.recommended ? (
                          <span className="elicit-rec-pill">Önerilen</span>
                        ) : null}
                      </span>
                      {option.description ? (
                        <span className="elicit-option-desc">{option.description}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}

              {currentField.customFieldKey ? (
                <div
                  className={`elicit-custom-row ${
                    (draft.customText[currentField.customFieldKey] ?? '').trim()
                      ? 'is-selected'
                      : ''
                  }`}
                  onClick={() => customInputRef.current?.focus()}
                >
                  <span
                    className={`elicit-index-badge ${
                      (draft.customText[currentField.customFieldKey] ?? '').trim()
                        ? 'is-selected'
                        : ''
                    }`}
                  >
                    <PencilIcon size={12} />
                  </span>
                  <input
                    ref={customInputRef}
                    type="text"
                    disabled={submitting}
                    className="elicit-custom-input"
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
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {currentField.kind === 'multi-select' ? (
            <div className="elicit-options">
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
                    disabled={submitting}
                    onClick={() => toggleMulti(currentField.key, option.value)}
                    className={`elicit-option ${checked ? 'is-selected' : ''}`}
                  >
                    <span className={`elicit-checkbox ${checked ? 'is-checked' : ''}`}>
                      {checked ? <CheckIcon size={11} /> : null}
                    </span>
                    <span className="elicit-option-copy">
                      <span className="elicit-option-title">
                        <span>{option.label}</span>
                        {option.recommended ? (
                          <span className="elicit-rec-pill">Önerilen</span>
                        ) : null}
                      </span>
                      {option.description ? (
                        <span className="elicit-option-desc">{option.description}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}

              {currentField.customFieldKey ? (
                <div
                  className={`elicit-custom-row ${
                    (draft.customText[currentField.customFieldKey] ?? '').trim()
                      ? 'is-selected'
                      : ''
                  }`}
                  onClick={() => customInputRef.current?.focus()}
                >
                  <span
                    className={`elicit-checkbox ${
                      (draft.customText[currentField.customFieldKey] ?? '').trim()
                        ? 'is-checked'
                        : ''
                    }`}
                  >
                    <PencilIcon size={10} />
                  </span>
                  <input
                    ref={customInputRef}
                    type="text"
                    disabled={submitting}
                    className="elicit-custom-input"
                    value={draft.customText[currentField.customFieldKey] ?? ''}
                    onChange={(e) => setCustom(currentField.customFieldKey!, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAdvanceOrSubmit();
                      }
                    }}
                    placeholder="Başka bir şey ekle…"
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {currentField.kind === 'boolean' ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={Boolean(draft.values[currentField.key])}
              disabled={submitting}
              onClick={() => {
                triggerHaptic('light');
                setDraft((prev) => ({
                  ...prev,
                  values: { ...prev.values, [currentField.key]: !prev.values[currentField.key] },
                }));
              }}
              className={`elicit-option elicit-boolean-row ${
                draft.values[currentField.key] ? 'is-selected' : ''
              }`}
            >
              <span
                className={`elicit-checkbox ${draft.values[currentField.key] ? 'is-checked' : ''}`}
              >
                {draft.values[currentField.key] ? <CheckIcon size={11} /> : null}
              </span>
              <span className="elicit-option-title">
                {draft.values[currentField.key] ? 'Evet, onaylıyorum' : 'Hayır'}
              </span>
            </button>
          ) : null}

          {currentField.kind === 'text' ? (
            <input
              type={currentField.inputType === 'text' ? 'text' : 'number'}
              step={currentField.inputType === 'integer' ? '1' : 'any'}
              disabled={submitting}
              className="elicit-text-input"
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
            />
          ) : null}
        </div>
      ) : null}

      <div className="elicit-foot">
        <button
          type="button"
          className="elicit-skip-btn"
          disabled={submitting}
          onClick={() => void runResolve('decline')}
        >
          Atla
        </button>

        <div className="elicit-foot-right">
          {totalSteps > 1 && clampedStep > 0 ? (
            <button
              type="button"
              className="elicit-secondary-btn"
              disabled={submitting}
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            >
              Geri
            </button>
          ) : null}
          {showConfirmButton ? (
            totalSteps > 1 && !isLastStep ? (
              <button
                type="button"
                className="elicit-primary-btn"
                disabled={submitting || !currentSatisfied}
                onClick={() => {
                  triggerHaptic('light');
                  setStepIndex((i) => Math.min(totalSteps - 1, i + 1));
                }}
              >
                <span>Devam</span>
                <ChevronRightIcon size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="elicit-primary-btn"
                disabled={submitting || !allSatisfied}
                onClick={handleConfirm}
              >
                {submitting ? 'Gönderiliyor…' : 'Gönder'}
              </button>
            )
          ) : null}
        </div>
      </div>
    </section>
  );
}

export interface ElicitationCardProps {
  requests: readonly ElicitationRequestView[];
  onResolve: (
    requestId: string,
    action: ElicitationAction,
    content?: ElicitationContent
  ) => Promise<void> | void;
}

export function ElicitationCard({ requests, onResolve }: ElicitationCardProps) {
  const active = requests[0];
  if (!active) return null;
  return (
    <ElicitationFormCard
      key={active.requestId}
      request={active}
      queueCount={requests.length}
      onResolve={onResolve}
    />
  );
}
