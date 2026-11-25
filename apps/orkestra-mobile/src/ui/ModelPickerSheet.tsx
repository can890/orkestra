import { useMemo, useState } from 'react';
import type { AccountView, ProviderUsageView, SessionConfigView } from '@/core/mappers';
import { groupMobileModelOptions } from '@/core/model-groups';
import { triggerHaptic } from '@/core/native-bridge';
import { providerDisplayName } from './components';
import { CheckIcon, CopyIcon, GitBranchIcon, PlusIcon, ShareIcon, XIcon } from './icons';
import {
  CORE_USAGE_PROVIDERS,
  ProviderAvatar,
  primaryRemainingPercent,
  quotaTone,
} from './ProviderBrand';

export type ConfigOptionKey = 'model' | 'mode' | 'effort' | 'collaborationMode';

export function ModelPickerSheet(props: {
  activeProviderId: string;
  providerLabel: string;
  config: SessionConfigView | null;
  optimistic: Partial<Record<ConfigOptionKey, string>>;
  accounts: AccountView[];
  agentNames: Record<string, string>;
  providerUsage: Record<string, ProviderUsageView>;
  canSwitchProvider: boolean;
  canExportMarkdown: boolean;
  onSelectOption: (key: ConfigOptionKey, value: string) => Promise<boolean>;
  onHandoffToProvider: (providerId: string) => void;
  onOpenNewTabWithProvider: (providerId: string) => void;
  onExportMarkdown: () => void;
  onShareMarkdown: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'models' | 'modes'>('models');
  const [selectedProvider, setSelectedProvider] = useState(props.activeProviderId);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const providers = useMemo(() => {
    const ids = new Set<string>(CORE_USAGE_PROVIDERS);
    if (props.activeProviderId) ids.add(props.activeProviderId);
    for (const acc of props.accounts) {
      if (acc.auth === 'authenticated') ids.add(acc.providerId);
    }
    return [...ids];
  }, [props.activeProviderId, props.accounts]);

  const currentModelId = props.optimistic.model ?? props.config?.currentModel ?? null;
  const currentEffortId = props.optimistic.effort ?? props.config?.currentEffort ?? null;
  const currentModeId = props.optimistic.mode ?? props.config?.currentModeId ?? null;
  const currentCollabId =
    props.optimistic.collaborationMode ?? props.config?.currentCollaborationMode ?? null;

  const groupedModels = useMemo(() => {
    if (!props.config) return [];
    return groupMobileModelOptions(
      props.config.modelOptions,
      currentModelId,
      props.config.efforts,
      currentEffortId
    );
  }, [props.config, currentModelId, currentEffortId]);

  const isViewingActiveProvider = selectedProvider === props.activeProviderId;
  const viewingProviderName = providerDisplayName(selectedProvider, props.agentNames);
  const viewingAccount = props.accounts.find((a) => a.providerId === selectedProvider);
  const viewingRemaining = primaryRemainingPercent(props.providerUsage[selectedProvider]);

  async function pick(key: ConfigOptionKey, value: string): Promise<void> {
    if (!value || savingKey) return;
    triggerHaptic('light');
    setSavingKey(`${key}:${value}`);
    try {
      await props.onSelectOption(key, value);
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="Model ve Oturum">
      <div className="sheet-backdrop" onClick={props.onClose} />
      <div className="sheet-panel model-picker-panel">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <div className="segmented sheet-seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'models'}
              className={`segmented-btn ${tab === 'models' ? 'is-active' : ''}`}
              onClick={() => setTab('models')}
            >
              Model &amp; Efor
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'modes'}
              className={`segmented-btn ${tab === 'modes' ? 'is-active' : ''}`}
              onClick={() => setTab('modes')}
            >
              Mod &amp; İşlemler
            </button>
          </div>
          <button
            type="button"
            className="wb-icon-btn sm"
            onClick={props.onClose}
            aria-label="Kapat"
          >
            <XIcon size={17} />
          </button>
        </div>

        {tab === 'models' ? (
          /* Mac 1. Sütun Karşılığı: Sabit Yatay Sağlayıcı Şeridi (kaydırmada sabit ve tam boy) */
          <div className="mp-provider-rail" role="tablist" aria-label="Yapay zeka sağlayıcıları">
            {providers.map((id) => {
              const active = selectedProvider === id;
              const isCurrent = id === props.activeProviderId;
              const rem = primaryRemainingPercent(props.providerUsage[id]);
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`mp-provider-tab ${active ? 'is-active' : ''} ${
                    isCurrent ? 'is-current' : ''
                  }`}
                  onClick={() => {
                    triggerHaptic('light');
                    setSelectedProvider(id);
                  }}
                >
                  <ProviderAvatar providerId={id} size="sm" names={props.agentNames} />
                  <span>{providerDisplayName(id, props.agentNames)}</span>
                  {rem !== null ? (
                    <span className={`quick-agent-pct is-${quotaTone(rem)}`}>%{rem}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="sheet-body">
          {tab === 'models' ? (
            <>
              {isViewingActiveProvider ? (
                <>
                  {groupedModels.length === 0 ? (
                    <p className="muted-note">
                      {props.providerLabel} oturumu henüz değiştirilebilir model listesi bildirmedi.
                    </p>
                  ) : (
                    <div className="mp-model-list">
                      {groupedModels.map((entry) => {
                        if (entry.kind === 'embedded-group') {
                          const selectedVariant = entry.activeVariant ?? entry.defaultVariant;
                          return (
                            <div
                              key={entry.key}
                              className={`mp-model-card ${entry.isSelected ? 'is-selected' : ''}`}
                            >
                              <button
                                type="button"
                                className="mp-model-head"
                                disabled={Boolean(savingKey)}
                                onClick={() => void pick('model', selectedVariant.value)}
                              >
                                <span className="mp-model-name">{entry.baseName}</span>
                                <span className="mp-model-check">
                                  {entry.isSelected ? (
                                    <CheckIcon size={15} className="icon-accent" />
                                  ) : null}
                                </span>
                              </button>
                              <div className="mp-effort-row" role="group" aria-label="Efor düzeyi">
                                {entry.variants.map((variant) => {
                                  const isPicked = currentModelId === variant.value;
                                  const busy = savingKey === `model:${variant.value}`;
                                  return (
                                    <button
                                      key={variant.value}
                                      type="button"
                                      className={`mp-effort-chip ${isPicked ? 'is-active' : ''}`}
                                      disabled={Boolean(savingKey)}
                                      onClick={() => void pick('model', variant.value)}
                                    >
                                      {busy ? <span className="spinner xs" /> : null}
                                      <span>{variant.label}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        }

                        const busy = savingKey === `model:${entry.id}`;
                        return (
                          <div
                            key={entry.key}
                            className={`mp-model-card ${entry.isSelected ? 'is-selected' : ''}`}
                          >
                            <button
                              type="button"
                              className="mp-model-head"
                              disabled={Boolean(savingKey)}
                              onClick={() => void pick('model', entry.id)}
                            >
                              <span className="mp-model-title-col">
                                <span className="mp-model-name">{entry.name}</span>
                                {entry.description ? (
                                  <span className="mp-model-desc">{entry.description}</span>
                                ) : null}
                              </span>
                              <span className="mp-model-check">
                                {busy ? (
                                  <span className="spinner xs" />
                                ) : entry.isSelected ? (
                                  <CheckIcon size={15} className="icon-accent" />
                                ) : null}
                              </span>
                            </button>
                            {entry.isSelected && entry.efforts.length > 0 ? (
                              <div
                                className="mp-effort-row"
                                role="group"
                                aria-label="Düşünme eforu"
                              >
                                {entry.efforts.map((eff) => {
                                  const isPicked = currentEffortId === eff.value;
                                  const effBusy = savingKey === `effort:${eff.value}`;
                                  return (
                                    <button
                                      key={eff.value}
                                      type="button"
                                      className={`mp-effort-chip ${isPicked ? 'is-active' : ''}`}
                                      disabled={Boolean(savingKey)}
                                      onClick={() => void pick('effort', eff.value)}
                                    >
                                      {effBusy ? <span className="spinner xs" /> : null}
                                      <span>{eff.label}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <div className="mp-switch-card">
                  <div className="mp-switch-head">
                    <ProviderAvatar
                      providerId={selectedProvider}
                      size="md"
                      names={props.agentNames}
                    />
                    <div className="mp-switch-meta">
                      <strong>{viewingProviderName}</strong>
                      <span>
                        {viewingRemaining !== null
                          ? `Kalan kota: %${viewingRemaining}`
                          : viewingAccount?.auth === 'unauthenticated'
                            ? 'Bu sağlayıcının oturumu kapalı'
                            : 'Bu sohbette farklı ajana geçebilirsin'}
                      </span>
                    </div>
                  </div>
                  {props.canSwitchProvider ? (
                    <div className="mp-switch-actions">
                      <button
                        type="button"
                        className="btn btn-primary full"
                        onClick={() => props.onHandoffToProvider(selectedProvider)}
                      >
                        <GitBranchIcon size={15} />
                        <span>{viewingProviderName} ajanına devret (özetle)</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary full"
                        onClick={() => props.onOpenNewTabWithProvider(selectedProvider)}
                      >
                        <PlusIcon size={15} />
                        <span>{viewingProviderName} ile yeni sekme aç</span>
                      </button>
                    </div>
                  ) : (
                    <p className="muted-note">
                      Farklı bir ajana geçmek için görevin bağlı olması gerekir.
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {props.config && props.config.modeOptions.length > 0 ? (
                <div className="form-group">
                  <span className="field-label">İzin Modu</span>
                  <div className="option-list">
                    {props.config.modeOptions.map((opt) => {
                      const active = currentModeId === opt.id;
                      const busy = savingKey === `mode:${opt.id}`;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={`option-row ${active ? 'is-selected' : ''}`}
                          disabled={Boolean(savingKey)}
                          onClick={() => void pick('mode', opt.id)}
                        >
                          <div className="option-row-text">
                            <span className="option-row-name">{opt.name}</span>
                            {opt.description ? (
                              <span className="option-row-desc">{opt.description}</span>
                            ) : null}
                          </div>
                          <span className="option-row-mark">
                            {busy ? (
                              <span className="spinner xs" />
                            ) : active ? (
                              <CheckIcon size={15} className="icon-accent" />
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {props.config && props.config.collaborationModeOptions.length > 0 ? (
                <div className="form-group">
                  <span className="field-label">Çalışma Modu</span>
                  <div className="option-chip-wrap">
                    {props.config.collaborationModeOptions.map((opt) => {
                      const active = currentCollabId === opt.id;
                      const busy = savingKey === `collaborationMode:${opt.id}`;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={`select-chip ${active ? 'is-selected' : ''}`}
                          disabled={Boolean(savingKey)}
                          onClick={() => void pick('collaborationMode', opt.id)}
                        >
                          {busy ? <span className="spinner xs" /> : null}
                          <span>{opt.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {props.canExportMarkdown ? (
                <div className="form-group sheet-export-group">
                  <span className="field-label">Dışa Aktar</span>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-secondary flex1"
                      onClick={props.onExportMarkdown}
                    >
                      <CopyIcon size={15} />
                      <span>Markdown kopyala</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary flex1"
                      onClick={props.onShareMarkdown}
                    >
                      <ShareIcon size={15} />
                      <span>Paylaş</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
