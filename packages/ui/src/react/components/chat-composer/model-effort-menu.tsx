import { cx } from '@styles/utilities/cx';
import { ArrowRightLeft, Check, ChevronDown, Search, Star, X } from 'lucide-react';
import * as React from 'react';
import { Popover } from '@/react/primitives/popover';
import {
  buildGroupedModelEntries,
  type ComposerPickerModeOption,
  type ComposerPickerModes,
  type ComposerProviderCatalogEntry,
  type EffortChoice,
  type EffortListItem,
  favoriteModelKey,
  type GroupedModelEntry,
  loadFavoriteModelKeys,
  modellessAgentLabel,
  type ModelListItem,
  saveFavoriteModelKeys,
  shortModelDisplayName,
} from './model-effort-groups';
import * as styles from './model-effort-menu.css';

export type { ComposerProviderCatalogEntry } from './model-effort-groups';

export interface ModelPickerRightPanelContext {
  providerId: string;
  modelId: string;
  modelName: string;
  focusedRowId: string | null;
  isSelectedRow: boolean;
  selectCurrentModel: () => void;
  closeMenu: () => void;
}

export interface ModelEffortMenuProps {
  models: ModelListItem[];
  efforts?: EffortListItem[];
  selectedModel?: string | null;
  selectedEffort?: string | null;
  onSelectModel: (modelId: string) => void;
  onSelectEffort?: (effortId: string) => void;
  onSelectModelAndEffort?: (modelId: string, effortId: string) => void;
  disabled?: boolean;
  /** Optional icon rendered inside the trigger button before the model name. */
  leadingIcon?: React.ReactNode;
  /** Optional title/aria-label for the trigger button. */
  triggerTitle?: string;
  /** Placeholder when no model is selected. */
  placeholder?: string;
  /** Optional "Default model" row at top of menu (used in task/chat creation modals). */
  allowDefault?: boolean;
  defaultLabel?: string;
  appearance?: 'control' | 'input';
  className?: string;
  contentClassName?: string;
  /** Optional multi-provider catalog for T3-style 3-column left rail browsing. */
  providers?: ComposerProviderCatalogEntry[];
  selectedProvider?: string | null;
  onSelectProviderModel?: (
    providerId: string,
    modelId: string,
    effortId?: string,
    modes?: ComposerPickerModes
  ) => void;
  footerHint?: string | ((browsedProviderId: string) => string | null);
  collaborationModes?: ComposerPickerModeOption[];
  selectedCollaborationMode?: string | null;
  onCollaborationModeChange?: (modeId: string) => void;
  permissionModes?: ComposerPickerModeOption[];
  selectedPermissionMode?: string | null;
  onPermissionModeChange?: (modeId: string) => void;
  rightPanelOverride?: (ctx: ModelPickerRightPanelContext) => React.ReactNode | null;
}

interface PickerRow {
  rowKey: string;
  providerId: string;
  providerName: string;
  providerIcon?: React.ReactNode;
  providerDisabled?: boolean;
  modelKey: string;
  displayName: string;
  entry: GroupedModelEntry;
  isSelected: boolean;
  favKey: string;
  searchHaystack: string;
}

const SINGLE_PROVIDER_ID = '__single__';
/** "Varsayılan model" satırının bekleyen seçim anahtarı. */
const DEFAULT_ROW_KEY = '__default__';
const COLLAPSED_LIMIT = 6;

function toModelItems(
  models: Record<string, { name: string; description?: string }>
): ModelListItem[] {
  return Object.entries(models).map(([id, opt]) => ({ id, ...opt }));
}

function toEffortItems(
  efforts: Record<string, { name: string; description?: string }> | null | undefined
): EffortListItem[] {
  return efforts ? Object.entries(efforts).map(([id, opt]) => ({ id, ...opt })) : [];
}

function buildProviderRows(
  provider: ComposerProviderCatalogEntry,
  isCurrentProvider: boolean,
  selectedModel: string | null | undefined,
  selectedEffort: string | null | undefined
): PickerRow[] {
  const modelItems = toModelItems(provider.models);
  const effortItems = toEffortItems(provider.efforts);
  const { entries } = buildGroupedModelEntries(
    modelItems,
    effortItems,
    isCurrentProvider ? selectedModel : null,
    isCurrentProvider ? selectedEffort : null
  );
  return entries.map((entry) => {
    const modelKey = entry.kind === 'embedded-group' ? entry.key : entry.id;
    const displayName = entry.kind === 'embedded-group' ? entry.baseName : entry.name;
    const isSelected = isCurrentProvider && entry.isSelected;
    const rawIds =
      entry.kind === 'embedded-group' ? entry.variants.map((v) => v.value).join(' ') : entry.id;
    return {
      rowKey: `${provider.id}::${entry.key}`,
      providerId: provider.id,
      providerName: provider.name,
      providerIcon: provider.icon,
      providerDisabled: provider.disabled,
      modelKey,
      displayName,
      entry,
      isSelected,
      favKey: favoriteModelKey(provider.id, modelKey),
      searchHaystack: `${displayName} ${provider.name} ${rawIds}`.toLocaleLowerCase('tr-TR'),
    };
  });
}

function resolveRowEfforts(row: PickerRow | null): {
  choices: EffortChoice[];
  selectedValue: string | null;
  defaultValue: string | null;
} {
  if (!row) return { choices: [], selectedValue: null, defaultValue: null };
  if (row.entry.kind === 'embedded-group') {
    return {
      choices: row.entry.variants,
      selectedValue: row.isSelected ? (row.entry.activeVariant?.value ?? null) : null,
      defaultValue: row.entry.defaultVariant.value,
    };
  }
  return {
    choices: row.entry.efforts,
    selectedValue: row.isSelected ? (row.entry.activeEffort?.value ?? null) : null,
    defaultValue: row.entry.defaultEffort?.value ?? null,
  };
}

export function ModelEffortMenu({
  models,
  efforts = [],
  selectedModel,
  selectedEffort,
  onSelectModel,
  onSelectEffort,
  onSelectModelAndEffort,
  disabled = false,
  leadingIcon,
  triggerTitle,
  placeholder = 'Model…',
  allowDefault = false,
  defaultLabel = 'Varsayılan model',
  appearance = 'control',
  className,
  contentClassName,
  providers,
  selectedProvider,
  onSelectProviderModel,
  footerHint,
  collaborationModes,
  selectedCollaborationMode,
  onCollaborationModeChange,
  permissionModes,
  selectedPermissionMode,
  onPermissionModeChange,
  rightPanelOverride,
}: ModelEffortMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<string>(() =>
    providers && providers.length > 0 ? (selectedProvider ?? providers[0]!.id) : SINGLE_PROVIDER_ID
  );
  const [searchQuery, setSearchQuery] = React.useState('');
  const [expandedTabs, setExpandedTabs] = React.useState<Record<string, boolean>>({});
  const [favoriteKeys, setFavoriteKeys] = React.useState<string[]>(() => loadFavoriteModelKeys());
  // Fareyle tıklama yalnızca bekleyen seçimi işaretler; değişiklik "Tamam" ile uygulanır.
  // Üzerine gelmek (hover) bekleyen seçimi değiştirmez.
  const [focusedRowKey, setFocusedRowKey] = React.useState<string | null>(null);
  const [pendingEffortValue, setPendingEffortValue] = React.useState<string | null>(null);
  const [modeDrafts, setModeDrafts] = React.useState<Record<string, ComposerPickerModes>>({});

  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  const hasProviderRail = Boolean(providers && providers.length > 0);

  const { trigger: directTrigger } = React.useMemo(
    () => buildGroupedModelEntries(models, efforts, selectedModel, selectedEffort),
    [models, efforts, selectedModel, selectedEffort]
  );

  // Fallback trigger label when providers catalog has static model metadata while live session is connecting.
  const trigger = React.useMemo(() => {
    if (directTrigger) return directTrigger;
    if (selectedProvider && providers && selectedModel) {
      const p = providers.find((item) => item.id === selectedProvider);
      if (p) {
        const res = buildGroupedModelEntries(
          toModelItems(p.models),
          toEffortItems(p.efforts),
          selectedModel,
          selectedEffort
        );
        if (res.trigger) return res.trigger;
      }
    }
    return null;
  }, [directTrigger, selectedProvider, providers, selectedModel, selectedEffort]);

  const modellessLabel = React.useMemo(
    () =>
      trigger
        ? null
        : modellessAgentLabel({
            liveModelCount: models.length,
            providers,
            selectedProvider,
            fallbackName: triggerTitle,
          }),
    [trigger, models.length, providers, selectedProvider, triggerTitle]
  );

  // Build rows across all providers (or single-provider synthetic entry).
  const allRows = React.useMemo<PickerRow[]>(() => {
    if (providers && providers.length > 0) {
      return providers.flatMap((provider) => {
        const isCurrent = selectedProvider ? provider.id === selectedProvider : true;
        // For the currently active provider, prefer live `models`/`efforts` if non-empty.
        if (isCurrent && models.length > 0) {
          const liveProvider: ComposerProviderCatalogEntry = {
            ...provider,
            models: Object.fromEntries(models.map((m) => [m.id, m])),
            efforts:
              efforts.length > 0
                ? Object.fromEntries(efforts.map((e) => [e.id, e]))
                : provider.efforts,
          };
          return buildProviderRows(liveProvider, true, selectedModel, selectedEffort);
        }
        return buildProviderRows(provider, isCurrent, selectedModel, selectedEffort);
      });
    }
    return buildProviderRows(
      {
        id: SINGLE_PROVIDER_ID,
        name: triggerTitle ?? 'Model',
        icon: leadingIcon,
        models: Object.fromEntries(models.map((m) => [m.id, m])),
        efforts: Object.fromEntries(efforts.map((e) => [e.id, e])),
      },
      true,
      selectedModel,
      selectedEffort
    );
  }, [
    providers,
    selectedProvider,
    models,
    efforts,
    selectedModel,
    selectedEffort,
    triggerTitle,
    leadingIcon,
  ]);

  const favoriteSet = React.useMemo(() => new Set(favoriteKeys), [favoriteKeys]);

  // Reset transient state each time popover opens.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (disabled) return;
      setOpen(next);
      if (next) {
        setSearchQuery('');
        setExpandedTabs({});
        setModeDrafts({});
        setActiveTab(
          providers && providers.length > 0
            ? (selectedProvider ?? providers[0]!.id)
            : SINGLE_PROVIDER_ID
        );
        setFocusedRowKey(null);
        setPendingEffortValue(null);
      }
    },
    [disabled, providers, selectedProvider]
  );

  // Filtered rows before "Show more" collapse.
  const filteredRows = React.useMemo<PickerRow[]>(() => {
    const trimmed = searchQuery.trim().toLocaleLowerCase('tr-TR');
    if (trimmed) {
      return allRows.filter((row) => row.searchHaystack.includes(trimmed));
    }
    if (activeTab === 'favorites') {
      return allRows.filter((row) => favoriteSet.has(row.favKey));
    }
    return allRows.filter((row) => row.providerId === activeTab);
  }, [allRows, searchQuery, activeTab, favoriteSet]);

  const isSearching = searchQuery.trim().length > 0;
  const isExpanded = Boolean(expandedTabs[activeTab]);
  const canCollapse = !isSearching && filteredRows.length > COLLAPSED_LIMIT;

  const visibleRows = React.useMemo<PickerRow[]>(() => {
    if (!canCollapse || isExpanded) return filteredRows;
    const head = filteredRows.slice(0, COLLAPSED_LIMIT);
    const selectedIndex = filteredRows.findIndex((r) => r.isSelected);
    if (selectedIndex >= COLLAPSED_LIMIT) {
      return [...filteredRows.slice(0, COLLAPSED_LIMIT - 1), filteredRows[selectedIndex]!];
    }
    return head;
  }, [canCollapse, isExpanded, filteredRows]);

  const isDefaultPending = focusedRowKey === DEFAULT_ROW_KEY;

  // Bekleyen (işaretlenmiş ama henüz onaylanmamış) satır. Sekme değiştirmek veya
  // aramak onu sıfırlamaz; işaretlenmemişse şu an seçili model gösterilir.
  const effectiveFocusedRow = React.useMemo<PickerRow | null>(() => {
    if (isDefaultPending) return null;
    if (focusedRowKey) {
      const found = allRows.find((r) => r.rowKey === focusedRowKey);
      if (found) return found;
    }
    return allRows.find((r) => r.isSelected) ?? null;
  }, [allRows, focusedRowKey, isDefaultPending]);

  const effortDetail = React.useMemo(
    () => resolveRowEfforts(effectiveFocusedRow),
    [effectiveFocusedRow]
  );

  const pendingEffortChoice = React.useMemo<EffortChoice | null>(() => {
    const value = pendingEffortValue ?? effortDetail.selectedValue ?? effortDetail.defaultValue;
    if (!value) return null;
    return effortDetail.choices.find((c) => c.value === value) ?? null;
  }, [pendingEffortValue, effortDetail]);

  const markRow = React.useCallback((rowKey: string) => {
    setFocusedRowKey(rowKey);
    setPendingEffortValue(null);
  }, []);

  const toggleFavorite = React.useCallback((favKey: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setFavoriteKeys((prev) => {
      const next = prev.includes(favKey) ? prev.filter((k) => k !== favKey) : [...prev, favKey];
      saveFavoriteModelKeys(next);
      return next;
    });
  }, []);

  const pickRowModel = React.useCallback(
    (row: PickerRow) => {
      if (row.providerDisabled) return;
      const targetModelId =
        row.entry.kind === 'embedded-group'
          ? (row.entry.activeVariant?.value ?? row.entry.defaultVariant.value)
          : row.entry.id;

      const isSameProvider =
        !hasProviderRail || !selectedProvider || row.providerId === selectedProvider;
      if (!isSameProvider && onSelectProviderModel) {
        const defaultEffort =
          row.entry.kind === 'model' ? row.entry.defaultEffort?.value : undefined;
        onSelectProviderModel(row.providerId, targetModelId, defaultEffort);
      } else {
        onSelectModel(targetModelId);
      }
      setOpen(false);
    },
    [hasProviderRail, selectedProvider, onSelectProviderModel, onSelectModel]
  );

  const pickEffortChoice = React.useCallback(
    (row: PickerRow, choice: EffortChoice) => {
      if (row.providerDisabled) return;
      const isSameProvider =
        !hasProviderRail || !selectedProvider || row.providerId === selectedProvider;

      if (row.entry.kind === 'embedded-group') {
        if (!isSameProvider && onSelectProviderModel) {
          onSelectProviderModel(row.providerId, choice.value);
        } else {
          onSelectModel(choice.value);
        }
        setOpen(false);
        return;
      }

      if (!isSameProvider && onSelectProviderModel) {
        onSelectProviderModel(row.providerId, row.entry.id, choice.value);
        setOpen(false);
        return;
      }

      if (row.entry.id === selectedModel) {
        onSelectEffort?.(choice.value);
      } else if (onSelectModelAndEffort) {
        onSelectModelAndEffort(row.entry.id, choice.value);
      } else {
        onSelectModel(row.entry.id);
        onSelectEffort?.(choice.value);
      }
      setOpen(false);
    },
    [
      hasProviderRail,
      selectedProvider,
      selectedModel,
      onSelectProviderModel,
      onSelectModel,
      onSelectEffort,
      onSelectModelAndEffort,
    ]
  );

  const currentProviderId = hasProviderRail
    ? (selectedProvider ?? providers?.[0]?.id ?? SINGLE_PROVIDER_ID)
    : SINGLE_PROVIDER_ID;
  const browsedProviderId =
    !isSearching && activeTab !== 'favorites' && activeTab !== SINGLE_PROVIDER_ID
      ? activeTab
      : (effectiveFocusedRow?.providerId ?? currentProviderId);
  const confirmationProviderId = effectiveFocusedRow?.providerId ?? currentProviderId;
  const confirmedModes = modeDrafts[confirmationProviderId];
  const hasModeChanges = Boolean(
    (confirmedModes?.permissionMode &&
      (confirmationProviderId !== currentProviderId ||
        confirmedModes.permissionMode !== selectedPermissionMode)) ||
    (confirmedModes?.collaborationMode &&
      (confirmationProviderId !== currentProviderId ||
        confirmedModes.collaborationMode !== selectedCollaborationMode))
  );
  const canConfirm =
    isDefaultPending ||
    (browsedProviderId === confirmationProviderId &&
      (effectiveFocusedRow ? !effectiveFocusedRow.providerDisabled : hasModeChanges));

  const confirmPending = React.useCallback(() => {
    if (!canConfirm) return;
    if (isDefaultPending) {
      onSelectModel('');
      setOpen(false);
      return;
    }
    const row = effectiveFocusedRow;
    if (row?.providerDisabled) return;
    const choice = pendingEffortChoice;
    const modelOrEffortChanged =
      row && (!row.isSelected || (choice && choice.value !== effortDetail.selectedValue));

    if (hasModeChanges && confirmedModes) {
      if (hasProviderRail && onSelectProviderModel) {
        const modelId = modelOrEffortChanged
          ? row.entry.kind === 'embedded-group'
            ? (choice?.value ?? row.entry.defaultVariant.value)
            : row.entry.id
          : '';
        onSelectProviderModel(
          confirmationProviderId,
          modelId,
          modelOrEffortChanged && row.entry.kind === 'model' ? choice?.value : undefined,
          confirmedModes
        );
        setOpen(false);
        return;
      }
      if (confirmedModes.permissionMode) onPermissionModeChange?.(confirmedModes.permissionMode);
      if (confirmedModes.collaborationMode) {
        onCollaborationModeChange?.(confirmedModes.collaborationMode);
      }
    }

    if (!modelOrEffortChanged || !row) setOpen(false);
    else if (choice) pickEffortChoice(row, choice);
    else pickRowModel(row);
  }, [
    canConfirm,
    isDefaultPending,
    effectiveFocusedRow,
    pendingEffortChoice,
    effortDetail.selectedValue,
    hasModeChanges,
    confirmedModes,
    hasProviderRail,
    onSelectProviderModel,
    confirmationProviderId,
    onPermissionModeChange,
    onCollaborationModeChange,
    onSelectModel,
    pickEffortChoice,
    pickRowModel,
  ]);

  const handlePickerKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '6') {
        const target = visibleRows[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          pickRowModel(target);
        }
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (visibleRows.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const curIdx = effectiveFocusedRow
          ? visibleRows.findIndex((r) => r.rowKey === effectiveFocusedRow.rowKey)
          : -1;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const nextIdx =
          curIdx === -1 ? 0 : (curIdx + delta + visibleRows.length) % visibleRows.length;
        markRow(visibleRows[nextIdx]!.rowKey);
        return;
      }

      if (e.key === 'Enter' && document.activeElement === searchInputRef.current) {
        if (canConfirm) {
          e.preventDefault();
          e.stopPropagation();
          confirmPending();
        }
      }
    },
    [visibleRows, effectiveFocusedRow, pickRowModel, markRow, canConfirm, confirmPending]
  );

  const browsedProvider = providers?.find((p) => p.id === browsedProviderId);
  const isCurrentProvider = browsedProviderId === currentProviderId;
  const visiblePermissionModes = isCurrentProvider
    ? permissionModes?.length
      ? permissionModes
      : browsedProvider?.permissionModes
    : browsedProvider?.permissionModes;
  const visibleCollaborationModes = isCurrentProvider
    ? collaborationModes?.length
      ? collaborationModes
      : browsedProvider?.collaborationModes
    : browsedProvider?.collaborationModes;
  const browsedDraft = modeDrafts[browsedProviderId];
  const displayedPermission =
    browsedDraft?.permissionMode ?? (isCurrentProvider ? selectedPermissionMode : null);
  const displayedCollaboration =
    browsedDraft?.collaborationMode ?? (isCurrentProvider ? selectedCollaborationMode : null);
  const resolvedFooterHint =
    typeof footerHint === 'function' ? footerHint(browsedProviderId) : footerHint;
  const showModes = Boolean(visiblePermissionModes?.length || visibleCollaborationModes?.length);

  function markMode(key: keyof ComposerPickerModes, id: string) {
    setModeDrafts((drafts) => ({
      ...drafts,
      [browsedProviderId]: { ...drafts[browsedProviderId], [key]: id },
    }));
  }

  const previewRow =
    effectiveFocusedRow?.providerId === browsedProviderId ? effectiveFocusedRow : null;
  const resolvedRightPanel = React.useMemo<React.ReactNode | null>(() => {
    if (!rightPanelOverride || !previewRow) return null;
    const focusedModelId =
      previewRow.entry.kind === 'embedded-group'
        ? (previewRow.entry.activeVariant?.value ?? previewRow.entry.defaultVariant.value)
        : previewRow.entry.id;
    return (
      rightPanelOverride({
        providerId: previewRow.providerId,
        modelId: focusedModelId,
        modelName: previewRow.displayName,
        focusedRowId: previewRow.rowKey,
        isSelectedRow: previewRow.isSelected,
        selectCurrentModel: confirmPending,
        closeMenu: () => setOpen(false),
      }) ?? null
    );
  }, [rightPanelOverride, previewRow, confirmPending]);

  const hasCustomRightPanel = resolvedRightPanel !== null;

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        data-slot="combobox-trigger"
        disabled={disabled}
        title={triggerTitle}
        aria-label={triggerTitle}
        className={
          appearance === 'input'
            ? cx(...styles.triggerInput, className)
            : cx(styles.triggerControl, className)
        }
      >
        <span
          className={styles.triggerContent}
          style={{
            color:
              trigger || modellessLabel ? 'var(--em-foreground)' : 'var(--em-foreground-muted)',
          }}
        >
          {leadingIcon ? (
            <span style={{ display: 'inline-flex', flexShrink: 0 }}>{leadingIcon}</span>
          ) : null}
          <span className={styles.triggerText}>
            {trigger?.label ?? modellessLabel ?? (allowDefault ? defaultLabel : placeholder)}
            {trigger?.effortLabel ? (
              <span className={styles.triggerEffort}> {trigger.effortLabel}</span>
            ) : null}
          </span>
        </span>
        <ChevronDown className={styles.triggerChevron} />
      </Popover.Trigger>

      <Popover.Content
        side="top"
        align="start"
        sideOffset={8}
        className={cx(styles.popoverSurface, contentClassName)}
        onKeyDown={handlePickerKeyDown}
        data-model-picker-content="true"
      >
        <div
          className={cx(
            styles.pickerRoot,
            !hasProviderRail && styles.pickerRootCompact,
            hasCustomRightPanel &&
              (hasProviderRail ? styles.pickerRootWide : styles.pickerRootCompactWide)
          )}
          style={{ position: 'relative' }}
        >
          <div className={styles.pickerBody}>
            {/* Sütun 1: Sol Sağlayıcı ve Favoriler Şeridi */}
            {hasProviderRail && providers && (
              <div
                className={styles.providerRail}
                data-model-picker-sidebar="true"
                role="tablist"
                aria-label="Yapay zeka sağlayıcıları"
              >
                <div className={styles.railItemWrap}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'favorites'}
                    aria-label="Favoriler"
                    title="Favoriler"
                    data-active={activeTab === 'favorites' ? 'true' : undefined}
                    className={styles.railButton}
                    onClick={() => {
                      setActiveTab('favorites');
                      setSearchQuery('');
                    }}
                  >
                    <Star
                      style={{
                        width: '1rem',
                        height: '1rem',
                        fill: activeTab === 'favorites' ? 'currentColor' : 'none',
                      }}
                    />
                  </button>
                  {activeTab === 'favorites' && <span className={styles.railActiveBar} />}
                </div>

                <div className={styles.railDivider} />

                {providers.map((provider) => {
                  const isActive = activeTab === provider.id;
                  const titleText = provider.badge
                    ? `${provider.name} (${provider.badge.label})`
                    : provider.name;
                  return (
                    <div key={provider.id} className={styles.railItemWrap}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        aria-label={provider.name}
                        title={titleText}
                        disabled={provider.disabled}
                        data-active={isActive ? 'true' : undefined}
                        data-model-picker-provider={provider.id}
                        className={styles.railButton}
                        onClick={() => {
                          setActiveTab(provider.id);
                          setSearchQuery('');
                        }}
                      >
                        {provider.icon ?? (
                          <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>
                            {provider.name.slice(0, 1)}
                          </span>
                        )}
                        {provider.badge && provider.badge.tone !== 'muted' && (
                          <span
                            className={cx(
                              styles.railBadgeDot,
                              provider.badge.tone === 'danger'
                                ? styles.railBadgeDotDanger
                                : styles.railBadgeDotWarning
                            )}
                          />
                        )}
                      </button>
                      {isActive && <span className={styles.railActiveBar} />}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Sütun 2: Arama ve Model Listesi */}
            <div className={styles.modelColumn}>
              <div className={styles.searchBar}>
                <Search style={{ width: '0.875rem', height: '0.875rem', flexShrink: 0 }} />
                <input
                  ref={searchInputRef}
                  type="text"
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                  }}
                  placeholder="Model ara..."
                  aria-label="Model ara"
                  className={styles.searchInput}
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="Aramayı temizle"
                    className={styles.searchClearBtn}
                    onClick={() => {
                      setSearchQuery('');
                      searchInputRef.current?.focus();
                    }}
                  >
                    <X style={{ width: '0.75rem', height: '0.75rem' }} />
                  </button>
                )}
              </div>

              <div className={styles.modelList} role="listbox" aria-label="Modeller">
                {allowDefault && !isSearching && activeTab !== 'favorites' && (
                  <div
                    className={styles.modelRow}
                    data-selected={!selectedModel ? 'true' : undefined}
                    data-pending={isDefaultPending ? 'true' : undefined}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={!selectedModel}
                      data-model-picker-row="true"
                      data-model-picker-default-row="true"
                      className={styles.modelRowBtn}
                      onClick={() => markRow(DEFAULT_ROW_KEY)}
                      onDoubleClick={() => {
                        onSelectModel('');
                        setOpen(false);
                      }}
                    >
                      <span className={styles.modelRowName}>{defaultLabel}</span>
                      {!selectedModel && (
                        <span className={styles.modelRowCheck}>
                          <Check
                            style={{ width: '0.875rem', height: '0.875rem' }}
                            strokeWidth={2.5}
                          />
                        </span>
                      )}
                    </button>
                  </div>
                )}

                {visibleRows.length === 0 ? (
                  <div className={styles.emptyStateText}>
                    {isSearching
                      ? 'Aramayla eşleşen model bulunamadı'
                      : activeTab === 'favorites'
                        ? 'Henüz favori model yok. Yıldız simgesine tıklayarak favori ekleyebilirsin.'
                        : 'Bu sağlayıcıda listelenebilecek model bulunamadı'}
                  </div>
                ) : (
                  visibleRows.map((row, idx) => {
                    const isFocused = effectiveFocusedRow?.rowKey === row.rowKey;
                    const isFav = favoriteSet.has(row.favKey);
                    const iconNode = row.providerIcon ?? leadingIcon;
                    return (
                      <div
                        key={row.rowKey}
                        className={styles.modelRow}
                        data-selected={isFocused ? 'true' : undefined}
                        data-pending={isFocused ? 'true' : undefined}
                      >
                        <button
                          type="button"
                          role="option"
                          aria-selected={isFocused}
                          disabled={row.providerDisabled}
                          data-model-picker-row="true"
                          data-selected={isFocused ? 'true' : undefined}
                          className={styles.modelRowBtn}
                          onClick={() => markRow(row.rowKey)}
                          onDoubleClick={confirmPending}
                        >
                          {iconNode ? (
                            <span className={styles.modelRowIcon}>{iconNode}</span>
                          ) : null}
                          <span className={styles.modelRowName}>{row.displayName}</span>
                          {isFocused && (
                            <span className={styles.modelRowCheck}>
                              <Check
                                style={{ width: '0.875rem', height: '0.875rem' }}
                                strokeWidth={2.25}
                              />
                            </span>
                          )}
                        </button>
                        <span className={styles.modelRowRight}>
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-label={isFav ? 'Favorilerden çıkar' : 'Favorilere ekle'}
                            aria-pressed={isFav}
                            data-favorited={isFav ? 'true' : undefined}
                            className={styles.favoriteStarBtn}
                            onClick={(e) => toggleFavorite(row.favKey, e)}
                          >
                            <Star
                              style={{
                                width: '0.75rem',
                                height: '0.75rem',
                                fill: isFav ? 'currentColor' : 'none',
                              }}
                            />
                          </button>
                          {idx < 6 && (
                            <span className={styles.shortcutPill} aria-hidden="true">
                              ⌘{idx + 1}
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })
                )}

                {canCollapse && (
                  <button
                    type="button"
                    data-model-picker-show-more="true"
                    aria-expanded={isExpanded}
                    className={styles.showMoreBtn}
                    onClick={() =>
                      setExpandedTabs((prev) => ({ ...prev, [activeTab]: !isExpanded }))
                    }
                  >
                    {isExpanded ? 'Daha az göster' : 'Daha fazla göster'}
                  </button>
                )}
              </div>
            </div>

            {/* Sütun 3: Sağ Düşünme / Efor Paneli (veya Özel Panel) */}
            <div
              className={cx(styles.effortColumn, hasCustomRightPanel && styles.effortColumnWide)}
              data-model-picker-effort="true"
            >
              {hasCustomRightPanel ? (
                resolvedRightPanel
              ) : (
                <>
                  <div className={styles.effortHeader}>
                    <span className={styles.effortHeaderTitle}>Düşünme</span>
                    {previewRow && (
                      <span className={styles.effortHeaderModel}>
                        {shortModelDisplayName(previewRow.displayName, previewRow.providerName)}
                      </span>
                    )}
                  </div>
                  <div
                    className={styles.effortList}
                    role="radiogroup"
                    aria-label="Düşünme seviyesi"
                  >
                    {previewRow && effortDetail.choices.length > 0 ? (
                      effortDetail.choices.map((choice) => {
                        const isPicked = pendingEffortChoice?.value === choice.value;
                        const isDefault = !isPicked && effortDetail.defaultValue === choice.value;
                        return (
                          <button
                            key={choice.value}
                            type="button"
                            role="radio"
                            aria-checked={isPicked}
                            data-selected={isPicked ? 'true' : undefined}
                            data-effort-choice={choice.value}
                            title={choice.description}
                            className={styles.effortRow}
                            onClick={() => setPendingEffortValue(choice.value)}
                            onDoubleClick={confirmPending}
                          >
                            <span className={styles.modelRowName}>{choice.label}</span>
                            {isPicked ? (
                              <Check
                                style={{ width: '0.875rem', height: '0.875rem', flexShrink: 0 }}
                                strokeWidth={2.25}
                              />
                            ) : isDefault ? (
                              <span className={styles.effortDefaultTag}>Varsayılan</span>
                            ) : null}
                          </button>
                        );
                      })
                    ) : (
                      <div className={styles.emptyStateText}>
                        {previewRow ? 'Sabit düşünme seviyesi' : 'Bir model seç'}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {showModes && (
            <div className={styles.modeBar} key={browsedProviderId}>
              {visiblePermissionModes && visiblePermissionModes.length > 0 && (
                <PickerModes
                  label="İzin kipi"
                  items={visiblePermissionModes}
                  selectedId={displayedPermission}
                  disabled={isCurrentProvider ? !onPermissionModeChange : !onSelectProviderModel}
                  onSelect={(id) => markMode('permissionMode', id)}
                />
              )}
              {visibleCollaborationModes && visibleCollaborationModes.length > 0 && (
                <PickerModes
                  label="Çalışma kipi"
                  items={visibleCollaborationModes}
                  selectedId={displayedCollaboration}
                  disabled={isCurrentProvider ? !onCollaborationModeChange : !onSelectProviderModel}
                  onSelect={(id) => markMode('collaborationMode', id)}
                />
              )}
            </div>
          )}
          {(resolvedFooterHint || browsedProvider?.badge) && (
            <div className={styles.footerBar}>
              {resolvedFooterHint && (
                <span className={styles.footerSwitchHint}>
                  <ArrowRightLeft style={{ width: '0.75rem', height: '0.75rem', flexShrink: 0 }} />
                  <span className={styles.modelRowName}>{resolvedFooterHint}</span>
                </span>
              )}
              {browsedProvider?.badge && (
                <span
                  className={styles.shortcutPill}
                  title={browsedProvider.badge.title}
                  style={{
                    color:
                      browsedProvider.badge.tone === 'danger'
                        ? '#ef4444'
                        : browsedProvider.badge.tone === 'warning'
                          ? '#f59e0b'
                          : undefined,
                  }}
                >
                  {browsedProvider.badge.label}
                </span>
              )}
            </div>
          )}

          {/* Onay çubuğu: işaretlenen model/düşünme seviyesi yalnızca "Tamam" ile uygulanır. */}
          <div className={styles.confirmBar} data-model-picker-confirm-bar="true">
            <span className={styles.confirmSummary} data-model-picker-pending-summary="true">
              {isDefaultPending
                ? defaultLabel
                : effectiveFocusedRow
                  ? `${shortModelDisplayName(
                      effectiveFocusedRow.displayName,
                      effectiveFocusedRow.providerName
                    )}${pendingEffortChoice ? ` · ${pendingEffortChoice.label}` : ''}`
                  : 'Bir model seç'}
            </span>
            <button
              type="button"
              className={styles.cancelBtn}
              data-model-picker-cancel="true"
              onClick={() => setOpen(false)}
            >
              Vazgeç
            </button>
            <button
              type="button"
              className={styles.confirmBtn}
              data-model-picker-confirm="true"
              disabled={!canConfirm}
              onClick={confirmPending}
            >
              Tamam
            </button>
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

function PickerModes({
  label,
  items,
  selectedId,
  disabled,
  onSelect,
}: {
  label: string;
  items: ComposerPickerModeOption[];
  selectedId?: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div className={styles.modeGroup} role="group" aria-label={label}>
      <span className={styles.modeLabel}>{label}</span>
      <div className={styles.segmentedGroup}>
        {items.map(({ id, name, description }) => (
          <button
            key={id}
            type="button"
            aria-pressed={selectedId === id}
            data-active={selectedId === id ? 'true' : undefined}
            title={description}
            className={styles.segmentedBtn}
            disabled={disabled}
            onClick={() => onSelect(id)}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
