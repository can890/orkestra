import { Button, Field, Label, Select } from '@orkestra/ui/react/primitives';
import { RotateCcw, Sparkles } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useCallback } from 'react';
import {
  ANTIGRAVITY_EFFORT_LABELS,
  ANTIGRAVITY_EXECUTOR_FAMILIES,
  ANTIGRAVITY_ORCHESTRATOR_MODES,
  ANTIGRAVITY_PLANNER_FAMILIES,
  buildAntigravityRoleSlug,
  formatAntigravityRoleLabel,
  hasOrchestratorOverride,
  normalizeProviderOrchestratorConfig,
  parseAntigravityRoleSlug,
  type AntigravityOrchestratorEffort,
  type AntigravityOrchestratorMode,
  type AntigravityRoleModelFamily,
  type ProviderCustomConfig,
  type ProviderOrchestratorConfig,
} from '@core/primitives/app-settings/api';
import { log } from '@core/primitives/logging/browser/logger';

const SYSTEM_DEFAULT_VALUE = '__default__';

export interface AntigravityOrchestratorSectionProps {
  storedConfig: ProviderCustomConfig | undefined;
  isLoading: boolean;
  update: (
    cfg: ProviderCustomConfig,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }
  ) => void;
  reset: (
    val?: undefined,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }
  ) => void;
}

interface RolePickerRowProps {
  id: string;
  label: string;
  description: string;
  value: string | undefined;
  families: readonly AntigravityRoleModelFamily[];
  disabled: boolean;
  onChange: (slug: string | undefined) => void;
}

const RolePickerRow: React.FC<RolePickerRowProps> = ({
  id,
  label,
  description,
  value,
  families,
  disabled,
  onChange,
}) => {
  const parsed = parseAntigravityRoleSlug(value, families);
  const selectedFamilyId = parsed?.familyId ?? SYSTEM_DEFAULT_VALUE;
  const selectedFamily = families.find((f) => f.id === parsed?.familyId) ?? null;
  const selectedEffort: AntigravityOrchestratorEffort =
    parsed?.effort ?? selectedFamily?.defaultEffort ?? 'high';

  const handleFamilyChange = (nextFamilyId: string | null) => {
    if (!nextFamilyId || nextFamilyId === SYSTEM_DEFAULT_VALUE) {
      onChange(undefined);
      return;
    }
    const family = families.find((f) => f.id === nextFamilyId);
    if (!family) return;
    const nextEffort = family.efforts.includes(selectedEffort)
      ? selectedEffort
      : family.defaultEffort;
    onChange(buildAntigravityRoleSlug(family.id, nextEffort, families));
  };

  const handleEffortChange = (nextEffort: string | null) => {
    if (!selectedFamily || !nextEffort) return;
    onChange(
      buildAntigravityRoleSlug(
        selectedFamily.id,
        nextEffort as AntigravityOrchestratorEffort,
        families
      )
    );
  };

  return (
    <Field.Root className="space-y-1.5">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-foreground-muted">{description}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select.Root
          value={selectedFamilyId}
          onValueChange={handleFamilyChange}
          disabled={disabled}
        >
          <Select.Trigger id={id} className="min-w-[180px] flex-1 gap-2 [&>span]:line-clamp-none">
            <Select.Value>
              {selectedFamily ? selectedFamily.label : 'Antigravity varsayılanı'}
            </Select.Value>
          </Select.Trigger>
          <Select.Content align="start" className="min-w-max">
            <Select.Item value={SYSTEM_DEFAULT_VALUE}>Antigravity varsayılanı</Select.Item>
            {families.map((family) => (
              <Select.Item key={family.id} value={family.id}>
                {family.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>

        {selectedFamily && (
          <Select.Root
            value={selectedEffort}
            onValueChange={handleEffortChange}
            disabled={disabled}
          >
            <Select.Trigger
              aria-label={`${label} düşünme düzeyi`}
              className="w-[128px] shrink-0 gap-2 [&>span]:line-clamp-none"
            >
              <Select.Value>{ANTIGRAVITY_EFFORT_LABELS[selectedEffort]}</Select.Value>
            </Select.Trigger>
            <Select.Content align="end" className="min-w-max">
              {selectedFamily.efforts.map((effort) => (
                <Select.Item key={effort} value={effort}>
                  {ANTIGRAVITY_EFFORT_LABELS[effort]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        )}
      </div>
    </Field.Root>
  );
};

export const AntigravityOrchestratorSection = observer(function AntigravityOrchestratorSection({
  storedConfig,
  isLoading,
  update,
  reset,
}: AntigravityOrchestratorSectionProps) {
  const orchestrator = storedConfig?.orchestrator;
  const currentMode: AntigravityOrchestratorMode = orchestrator?.defaultMode ?? 'standard';
  const currentModeOption =
    ANTIGRAVITY_ORCHESTRATOR_MODES.find((item) => item.id === currentMode) ??
    ANTIGRAVITY_ORCHESTRATOR_MODES[0]!;
  const isCustomized = hasOrchestratorOverride(orchestrator);

  const commitOrchestrator = useCallback(
    (nextRaw: ProviderOrchestratorConfig | undefined) => {
      const normalized = normalizeProviderOrchestratorConfig(nextRaw);
      const hasOtherOverrides =
        Boolean(storedConfig?.extraArgs?.trim()) ||
        Boolean(storedConfig?.env && Object.keys(storedConfig.env).length > 0);

      if (!normalized && !hasOtherOverrides) {
        reset(undefined, {
          onError: (err) => log.error('Antigravity orkestratör ayarları sıfırlanamadı:', err),
        });
        return;
      }

      const nextConfig: ProviderCustomConfig = {
        ...(storedConfig ?? {}),
        orchestrator: normalized,
      };
      update(nextConfig, {
        onError: (err) => log.error('Antigravity orkestratör ayarları kaydedilemedi:', err),
      });
    },
    [storedConfig, reset, update]
  );

  const handleModeChange = (nextMode: string | null) => {
    if (!nextMode) return;
    commitOrchestrator({
      ...(orchestrator ?? {}),
      defaultMode: nextMode as AntigravityOrchestratorMode,
    });
  };

  const handlePlannerChange = (plannerModel: string | undefined) => {
    commitOrchestrator({
      ...(orchestrator ?? {}),
      plannerModel,
    });
  };

  const handleExecutorChange = (executorModel: string | undefined) => {
    commitOrchestrator({
      ...(orchestrator ?? {}),
      executorModel,
    });
  };

  const handleReset = () => {
    commitOrchestrator(undefined);
  };

  return (
    <div className="space-y-3 rounded-lg border bg-background-1 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Sparkles className="size-3.5 text-foreground-muted" aria-hidden="true" />
            <span>Orkestratör Modu (Orchestrator)</span>
          </div>
          <p className="text-xs text-foreground-muted">
            Antigravity&apos;nin Planlayıcı + Uygulayıcı kipini ve rol bazlı model/efor tercihlerini
            yapılandırın. Yeni sohbet ve terminal oturumlarına otomatik uygulanır.
          </p>
        </div>
        {isCustomized && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1.5 px-2 text-xs"
            onClick={handleReset}
            disabled={isLoading}
          >
            <RotateCcw className="size-3.5" />
            Sıfırla
          </Button>
        )}
      </div>

      <div className="space-y-3.5 pt-1">
        <Field.Root className="space-y-1.5">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="agy-orchestrator-mode">Varsayılan çalışma kipi</Label>
            <span className="text-xs text-foreground-muted">{currentModeOption.description}</span>
          </div>
          <Select.Root
            value={currentMode}
            onValueChange={handleModeChange}
            disabled={isLoading}
          >
            <Select.Trigger
              id="agy-orchestrator-mode"
              className="w-full gap-2 [&>span]:line-clamp-none"
            >
              <Select.Value>{currentModeOption.label}</Select.Value>
            </Select.Trigger>
            <Select.Content align="start" className="min-w-max">
              {ANTIGRAVITY_ORCHESTRATOR_MODES.map((option) => (
                <Select.Item key={option.id} value={option.id}>
                  {option.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Field.Root>

        <RolePickerRow
          id="agy-orchestrator-planner"
          label="Planlayıcı (Planner)"
          description="Görevi analiz edip adımları planlayan üst model ve düşünme düzeyi."
          value={orchestrator?.plannerModel}
          families={ANTIGRAVITY_PLANNER_FAMILIES}
          disabled={isLoading}
          onChange={handlePlannerChange}
        />

        <RolePickerRow
          id="agy-orchestrator-executor"
          label="Uygulayıcı (Executor)"
          description="Planlanan adımları kodlayıp araçları çalıştıran alt model ve düşünme düzeyi."
          value={orchestrator?.executorModel}
          families={ANTIGRAVITY_EXECUTOR_FAMILIES}
          disabled={isLoading}
          onChange={handleExecutorChange}
        />

        {isCustomized && (
          <div className="rounded-md border bg-background-2 px-3 py-2 text-xs text-foreground-muted">
            <span className="font-medium text-foreground">Etkin orkestratör profili: </span>
            {currentModeOption.label} · Planlayıcı:{' '}
            {formatAntigravityRoleLabel(orchestrator?.plannerModel, ANTIGRAVITY_PLANNER_FAMILIES)} ·
            Uygulayıcı:{' '}
            {formatAntigravityRoleLabel(orchestrator?.executorModel, ANTIGRAVITY_EXECUTOR_FAMILIES)}
          </div>
        )}
      </div>
    </div>
  );
});
