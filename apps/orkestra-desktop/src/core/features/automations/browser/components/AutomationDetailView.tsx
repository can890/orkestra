import {
  Button,
  DropdownMenu,
  Input,
  Switch,
  Tabs,
  Tooltip,
  toast,
} from '@orkestra/ui/react/primitives';
import { Copy, Ellipsis, Play, RefreshCw, Trash2, Webhook } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getAutomationsClient } from '@core/features/automations/api/browser/client';
import type { AutomationWebhookInfoDto } from '@core/features/automations/api/contract';
import type { Automation } from '@core/primitives/automations/api';
import { useAutomationTargetAvailability, useRunAutomationNow } from '../use-automations';
import { useAutomationSettingsAutoSave } from '../useAutomationSettingsAutoSave';
import { AutomationSettingsFields } from './AutomationSettingsFields';
import { NextRunBanner } from './NextRunBanner';
import { RunHistory } from './RunHistory';
import { SheetHeader } from './sheet-header';

type AutomationTab = 'runs' | 'settings';

const AUTOMATION_TABS: { value: AutomationTab; label: string }[] = [
  { value: 'runs', label: 'Runs' },
  { value: 'settings', label: 'Settings' },
];

export interface AutomationDetailViewProps {
  automation: Automation;
  onClose: () => void;
  onDelete?: (automation: Automation) => void;
  onRunNow?: (automation: Automation) => void;
  onToggleEnabled?: (automation: Automation, enabled: boolean) => void;
  runNowPending?: boolean;
}

export const AutomationDetailView = observer(function AutomationDetailView({
  automation,
  onClose,
  onDelete,
  onToggleEnabled,
  runNowPending: _runNowPending,
}: AutomationDetailViewProps) {
  const [activeTab, setActiveTab] = useState<AutomationTab>('runs');
  const [cronError, setCronError] = useState<string | null>(null);
  const availability = useAutomationTargetAvailability(automation.projectId);
  const runtimeAvailability = availability.data ?? {
    available: false as const,
    reason: 'Checking automation runtime…',
  };
  const canEdit = runtimeAvailability.available;

  const { formState, setCronExpr, handlePromptBlur, handleNameBlur, saveError } =
    useAutomationSettingsAutoSave(automation, canEdit);
  const { name, setName } = formState;

  const runNow = useRunAutomationNow();

  const canRunNow =
    canEdit &&
    automation.enabled &&
    !!automation.projectId &&
    !!automation.conversationConfig &&
    !!automation.triggerConfig &&
    !!automation.taskConfig &&
    !runNow.isPending;

  return (
    <div className="flex h-full flex-col">
      <SheetHeader title="Automation details" onClose={onClose} />
      <div className="flex flex-col gap-2 px-4">
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex flex-1 flex-row items-center gap-3">
            <Input
              bare
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleNameBlur}
              placeholder="Name this automation"
              className="flex-1 px-0 text-lg!"
              disabled={!canEdit}
            />
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" />}>
                <Ellipsis className="size-4" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content side="bottom" align="end">
                <DropdownMenu.Item variant="destructive" onClick={() => onDelete?.(automation)}>
                  <Trash2 />
                  Delete automation
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <Switch
              checked={automation.enabled}
              disabled={!canEdit}
              onCheckedChange={(checked) => onToggleEnabled?.(automation, checked)}
              aria-label={automation.enabled ? 'Pause automation' : 'Enable automation'}
            />
          </div>
        </div>
        {!runtimeAvailability.available && (
          <p className="rounded-md bg-background-warning px-3 py-2 text-xs text-foreground-warning">
            {runtimeAvailability.reason}
          </p>
        )}
        <NextRunBanner
          automationId={automation.id}
          projectId={automation.projectId}
          runtimeAvailable={canEdit}
        />
        <div className="flex items-center gap-2 py-2">
          <Tabs.Root
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as AutomationTab)}
          >
            <Tabs.List>
              {AUTOMATION_TABS.map(({ value, label }) => (
                <Tabs.Tab key={value} value={value}>
                  {label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.Root>
          {activeTab === 'runs' && (
            <div className="ml-auto flex items-center gap-1">
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Button
                      variant="ghost"
                      icon
                      disabled={!canRunNow}
                      onClick={() =>
                        void runNow.mutateAsync({
                          projectId: automation.projectId!,
                          automationId: automation.id,
                        })
                      }
                    />
                  }
                >
                  <Play className="size-3.5" />
                </Tooltip.Trigger>
                <Tooltip.Content>
                  {automation.projectId == null
                    ? 'Assign a project before running'
                    : !canEdit
                      ? runtimeAvailability.reason
                      : !automation.enabled
                        ? 'Enable the automation before running'
                        : !automation.conversationConfig ||
                            !automation.triggerConfig ||
                            !automation.taskConfig
                          ? 'Configure the automation before running'
                          : 'Run now'}
                </Tooltip.Content>
              </Tooltip.Root>
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {activeTab === 'runs' && <RunHistory automation={automation} />}
        {activeTab === 'settings' && (
          <div className="space-y-4">
            <AutomationSettingsFields
              state={formState}
              cronError={cronError}
              onCronExprChange={(expr) => {
                setCronExpr(expr);
                setCronError(null);
              }}
              onCronErrorClear={() => setCronError(null)}
              onPromptBlur={handlePromptBlur}
              error={saveError}
              disabled={!canEdit}
            />
            <AutomationWebhookSection automationId={automation.id} />
          </div>
        )}
      </div>
    </div>
  );
});

function AutomationWebhookSection({ automationId }: { automationId: string }) {
  const [info, setInfo] = useState<AutomationWebhookInfoDto | null>(null);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getAutomationsClient()
      .then((client) => client.getWebhookInfo({ automationId }))
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [automationId]);

  const handleCopy = (text: string, label: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success(`${label} panoya kopyalandı`))
      .catch(() => toast.error('Panoya kopyalanamadı'));
  };

  const handleRotate = async () => {
    setRotating(true);
    try {
      const client = await getAutomationsClient();
      const next = await client.rotateWebhookSecret({ automationId });
      setInfo(next);
      toast.success('Webhook gizli anahtarı yenilendi');
    } catch (error) {
      toast.error('Anahtar yenilenemedi', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-(--em-surface) p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Webhook className="h-3.5 w-3.5 text-blue-400" />
          Yerel Webhook Tetikleyici
        </div>
        {info && (
          <span className="text-muted-foreground font-mono text-[11px]">
            Gizli anahtar: {info.secretPreview}
          </span>
        )}
      </div>
      <p className="text-muted-foreground text-[11px]">
        Yalnızca bu makineden (<code className="text-[10px]">127.0.0.1</code>) Bearer doğrulamalı
        HTTP <code className="text-[10px]">POST</code> istekleriyle bu otomasyonu tetikleyin.
      </p>
      {info ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Input readOnly value={info.url} className="h-7 flex-1 font-mono text-[11px]" />
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => handleCopy(info.url, 'Webhook URL')}
            >
              <Copy className="h-3 w-3" />
              URL Kopyala
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => handleCopy(info.curlSnippet, 'curl komutu')}
            >
              <Copy className="h-3 w-3" />
              curl Kopyala
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={rotating}
              onClick={() => void handleRotate()}
            >
              <RefreshCw className={`h-3 w-3 ${rotating ? 'animate-spin' : ''}`} />
              Gizli Anahtarı Yenile
            </Button>
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground text-[11px]">Webhook adresi hazırlanıyor…</div>
      )}
    </div>
  );
}
