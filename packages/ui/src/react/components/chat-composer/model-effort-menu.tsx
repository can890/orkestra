import { cx } from '@styles/utilities/cx';
import { Check, ChevronDown } from 'lucide-react';
import * as React from 'react';
import { DropdownMenu } from '@/react/primitives/dropdown-menu';
import {
  buildGroupedModelEntries,
  type EffortListItem,
  type ModelListItem,
} from './model-effort-groups';
import * as styles from './model-effort-menu.css';

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
}: ModelEffortMenuProps) {
  const [open, setOpen] = React.useState(false);

  const { entries, trigger } = React.useMemo(
    () => buildGroupedModelEntries(models, efforts, selectedModel, selectedEffort),
    [models, efforts, selectedModel, selectedEffort]
  );

  const closeAnd = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  const handleSeparateEffortPick = (modelId: string, effortId: string) => {
    closeAnd(() => {
      if (modelId === selectedModel) {
        onSelectEffort?.(effortId);
        return;
      }
      if (onSelectModelAndEffort) {
        onSelectModelAndEffort(modelId, effortId);
      } else {
        onSelectModel(modelId);
        onSelectEffort?.(effortId);
      }
    });
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <DropdownMenu.Trigger
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
            color: trigger ? 'var(--em-foreground)' : 'var(--em-foreground-muted)',
          }}
        >
          {leadingIcon ? (
            <span style={{ display: 'inline-flex', flexShrink: 0 }}>{leadingIcon}</span>
          ) : null}
          <span className={styles.triggerText}>
            {trigger?.label ?? (allowDefault ? defaultLabel : placeholder)}
            {trigger?.effortLabel ? (
              <span className={styles.triggerEffort}> {trigger.effortLabel}</span>
            ) : null}
          </span>
        </span>
        <ChevronDown className={styles.triggerChevron} />
      </DropdownMenu.Trigger>

      <DropdownMenu.Content
        align="start"
        width="content"
        sideOffset={6}
        className={cx(styles.menuContent, contentClassName)}
      >
        <DropdownMenu.Group>
          <DropdownMenu.Label>Model</DropdownMenu.Label>

          {allowDefault ? (
            <>
              <DropdownMenu.Item
                className={cx(styles.standaloneItem, !selectedModel && styles.rowActive)}
                onClick={() => closeAnd(() => onSelectModel(''))}
              >
                <span className={styles.rowModelName}>{defaultLabel}</span>
                {!selectedModel ? (
                  <span className={styles.standaloneCheck}>
                    <Check style={{ width: '0.875rem', height: '0.875rem' }} strokeWidth={2.5} />
                  </span>
                ) : null}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
            </>
          ) : null}

          {entries.map((entry) => {
            if (entry.kind === 'embedded-group') {
              const hintLabel = entry.activeVariant?.label ?? entry.defaultVariant.label;
              return (
                <DropdownMenu.Sub key={entry.key}>
                  <DropdownMenu.SubTrigger
                    delay={45}
                    className={cx(entry.isSelected && styles.rowActive)}
                    onClick={() => closeAnd(() => onSelectModel(entry.defaultVariant.value))}
                  >
                    <span className={styles.rowLabelGroup}>
                      <span className={styles.rowModelName}>{entry.baseName}</span>
                      <span className={styles.rowEffortHint}>{hintLabel}</span>
                    </span>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent
                    side="right"
                    align="start"
                    sideOffset={6}
                    className={cx(styles.subMenuContent, contentClassName)}
                  >
                    <DropdownMenu.RadioGroup
                      value={entry.activeVariant?.value ?? ''}
                      onValueChange={(value) => closeAnd(() => onSelectModel(String(value)))}
                    >
                      {entry.variants.map((variant) => (
                        <DropdownMenu.RadioItem key={variant.value} value={variant.value}>
                          {variant.label}
                        </DropdownMenu.RadioItem>
                      ))}
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Sub>
              );
            }

            // Ayrı efor listesi olan sağlayıcılar (Claude, Codex, Grok vb.)
            if (entry.efforts.length > 0) {
              const hintLabel = entry.activeEffort?.label ?? entry.defaultEffort?.label ?? null;
              return (
                <DropdownMenu.Sub key={entry.key}>
                  <DropdownMenu.SubTrigger
                    delay={45}
                    className={cx(entry.isSelected && styles.rowActive)}
                    onClick={() => closeAnd(() => onSelectModel(entry.id))}
                  >
                    <span className={styles.rowLabelGroup}>
                      <span className={styles.rowModelName}>{entry.name}</span>
                      {hintLabel ? <span className={styles.rowEffortHint}>{hintLabel}</span> : null}
                    </span>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent
                    side="right"
                    align="start"
                    sideOffset={6}
                    className={cx(styles.subMenuContent, contentClassName)}
                  >
                    <DropdownMenu.RadioGroup
                      value={entry.isSelected ? (entry.activeEffort?.value ?? '') : ''}
                      onValueChange={(effortId) =>
                        handleSeparateEffortPick(entry.id, String(effortId))
                      }
                    >
                      {entry.efforts.map((effort) => (
                        <DropdownMenu.RadioItem key={effort.value} value={effort.value}>
                          {effort.label}
                        </DropdownMenu.RadioItem>
                      ))}
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Sub>
              );
            }

            // Tekil efor / eforu olmayan modeller (Orchestrator, GPT-OSS, Kimi, GLM vb.)
            return (
              <DropdownMenu.Item
                key={entry.key}
                className={cx(styles.standaloneItem, entry.isSelected && styles.rowActive)}
                onClick={() => closeAnd(() => onSelectModel(entry.id))}
              >
                <span className={styles.rowModelName}>{entry.name}</span>
                {entry.isSelected ? (
                  <span className={styles.standaloneCheck}>
                    <Check style={{ width: '0.875rem', height: '0.875rem' }} strokeWidth={2.5} />
                  </span>
                ) : null}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
