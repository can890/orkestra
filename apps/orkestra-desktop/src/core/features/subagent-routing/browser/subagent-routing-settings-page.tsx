import { PageLayout, SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Badge, Button, Input, Switch, toast } from '@orkestra/ui/react/primitives';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getSubagentRoutingClient } from '@core/features/subagent-routing/api/browser/client';
import type { RoutingPreview } from '@core/features/subagent-routing/api/contract';
import {
  DEFAULT_SUBAGENT_ROUTING_SETTINGS,
  SUBAGENT_PROVIDERS,
  type SubagentRoutingCandidateSetting,
  type SubagentRoutingTierSetting,
} from '@core/features/subagent-routing/api/routing-settings';

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const PREVIEW_INTERVAL_MS = 30_000;

function move<T>(list: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

const STATE_TONE = {
  ok: 'success',
  low: 'warning',
  exhausted: 'error',
  unknown: 'neutral',
} as const;

// Kota durumu rozeti: ham `row.state` yerine (etiket tablosu Türkçe yamayla çevrilir).
const QUOTA_STATE_LABELS: Record<keyof typeof STATE_TONE, string> = {
  ok: 'Available',
  low: 'Low',
  exhausted: 'Exhausted',
  unknown: 'Unknown',
};

function formatReset(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function AddCandidate({
  onAdd,
  disabled,
}: {
  onAdd: (candidate: SubagentRoutingCandidateSetting) => void;
  disabled: boolean;
}) {
  const [provider, setProvider] = useState<(typeof SUBAGENT_PROVIDERS)[number]>('codex');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('');
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!model.trim()) return;
        onAdd({
          provider,
          model: model.trim(),
          ...(effort ? { effort } : {}),
          enabled: true,
        });
        setModel('');
      }}
    >
      <select
        aria-label="Provider"
        className="h-7 rounded-md border border-border bg-background px-2 text-xs"
        value={provider}
        disabled={disabled}
        onChange={(event) => setProvider(event.target.value as typeof provider)}
      >
        {SUBAGENT_PROVIDERS.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      <Input
        aria-label="Model"
        className="w-56"
        placeholder="model slug, e.g. gpt-6.2-astra"
        value={model}
        disabled={disabled}
        onChange={(event) => setModel(event.target.value)}
      />
      <select
        aria-label="Effort"
        className="h-7 rounded-md border border-border bg-background px-2 text-xs"
        value={effort}
        disabled={disabled}
        onChange={(event) => setEffort(event.target.value as typeof effort)}
      >
        {EFFORTS.map((id) => (
          <option key={id} value={id}>
            {id || 'default effort'}
          </option>
        ))}
      </select>
      <Button type="submit" variant="secondary" size="sm" disabled={disabled || !model.trim()}>
        Add candidate
      </Button>
    </form>
  );
}

function TierEditor({
  tier,
  index,
  count,
  disabled,
  onChange,
  onMove,
}: {
  tier: SubagentRoutingTierSetting;
  index: number;
  count: number;
  disabled: boolean;
  onChange: (tier: SubagentRoutingTierSetting) => void;
  onMove: (delta: number) => void;
}) {
  const setCandidates = (candidates: SubagentRoutingCandidateSetting[]) =>
    onChange({ ...tier, candidates });
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{tier.label}</div>
          <div className="text-xs text-foreground-muted">
            {`Tier ${index + 1} of ${count} · id ${tier.id} · candidates are tried top to bottom`}
          </div>
        </div>
        <Button
          variant="ghost"
          size="xs"
          icon
          aria-label="Move tier up"
          disabled={disabled || index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          icon
          aria-label="Move tier down"
          disabled={disabled || index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown />
        </Button>
        <Switch
          size="sm"
          aria-label="Enable tier"
          checked={tier.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => onChange({ ...tier, enabled })}
        />
      </div>
      <ul className="flex flex-col gap-1">
        {tier.candidates.map((candidate, candidateIndex) => (
          <li
            key={`${candidate.provider}:${candidate.model}:${candidateIndex}`}
            className="flex items-center gap-2 rounded border border-border bg-background-1 px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate text-xs">
              {candidateIndex + 1}. {candidate.provider} / {candidate.model}
              {candidate.effort ? ` (${candidate.effort})` : ''}
            </span>
            <Button
              variant="ghost"
              size="xs"
              icon
              aria-label="Move candidate up"
              disabled={disabled || candidateIndex === 0}
              onClick={() => setCandidates(move(tier.candidates, candidateIndex, -1))}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              icon
              aria-label="Move candidate down"
              disabled={disabled || candidateIndex === tier.candidates.length - 1}
              onClick={() => setCandidates(move(tier.candidates, candidateIndex, 1))}
            >
              <ArrowDown />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              icon
              aria-label="Remove candidate"
              disabled={disabled}
              onClick={() => setCandidates(tier.candidates.filter((_, i) => i !== candidateIndex))}
            >
              <Trash2 />
            </Button>
            <Switch
              size="sm"
              aria-label="Enable candidate"
              checked={candidate.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                setCandidates(
                  tier.candidates.map((c, i) => (i === candidateIndex ? { ...c, enabled } : c))
                )
              }
            />
          </li>
        ))}
      </ul>
      <AddCandidate
        disabled={disabled}
        onAdd={(candidate) => setCandidates([...tier.candidates, candidate])}
      />
    </div>
  );
}

/**
 * Ayarlar → Alt ajan yönlendirmesi: anahtar (varsayılan kapalı), eşik, kıt model kuralı,
 * katman/aday politika düzenleyicisi ve adayların anlık kapasite önizlemesi.
 */
export function SubagentRoutingSettingsPage() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('subagentRouting');
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [threshold, setThreshold] = useState('');
  const [scarce, setScarce] = useState('');
  const disabled = isLoading || isSaving;
  const settings = value ?? DEFAULT_SUBAGENT_ROUTING_SETTINGS;

  const loadPreview = useCallback(async (refresh: boolean) => {
    try {
      setPreview(await (await getSubagentRoutingClient()).preview({ refresh }));
    } catch (error) {
      toast.error('Could not load the routing preview', { description: String(error) });
    }
  }, []);

  useEffect(() => {
    void loadPreview(false);
    const timer = setInterval(() => void loadPreview(false), PREVIEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadPreview, value]);

  useEffect(() => {
    setThreshold(String(settings.thresholdPercent));
    setScarce(settings.scarceModels.join(', '));
  }, [settings.thresholdPercent, settings.scarceModels]);

  const setTiers = (tiers: SubagentRoutingTierSetting[]) => update({ tiers });
  // Ayrı `…Label` değişkeni: iç içe şablon metni Türkçe yamaya görünmez.
  const snapshotUpdatedLabel = preview?.writtenAt
    ? ` (updated ${new Date(preview.writtenAt).toLocaleTimeString()})`
    : '';

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        title="Sub-agent routing"
        description="Route sub-agents started through orkestra-subagents by the remaining headroom of each subscription window. When off, sub-agents run exactly as requested."
      />
      <SettingsSection title="Routing">
        <SettingsRow
          label="Limit-aware sub-agent routing"
          description="list_subagent_models shows each provider's headroom and a recommended model per tier; run_subagent moves a request away from an exhausted or low pool to an equivalent or cheaper candidate and tells the calling agent why."
          control={
            <Switch
              aria-label="Limit-aware sub-agent routing"
              checked={settings.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) => update({ enabled })}
            />
          }
        />
        <SettingsRow
          label="Reroute below (% left)"
          description="A pool with less headroom than this in its tightest current window counts as low."
          control={
            <Input
              aria-label="Reroute below (% left)"
              className="w-20"
              type="number"
              min={1}
              max={90}
              value={threshold}
              disabled={disabled}
              onChange={(event) => setThreshold(event.target.value)}
              onBlur={() => {
                const next = Math.round(Number(threshold));
                if (Number.isFinite(next) && next >= 1 && next <= 90) {
                  if (next !== settings.thresholdPercent) update({ thresholdPercent: next });
                } else setThreshold(String(settings.thresholdPercent));
              }}
            />
          }
        />
        <SettingsRow
          label="Do not spawn the parent's own scarce model"
          description="Unless a model is requested explicitly, never pick a scarce model (patterns below) of the provider the calling conversation runs on."
          control={
            <Switch
              aria-label="Do not spawn the parent's own scarce model"
              checked={settings.avoidParentScarceModels}
              disabled={disabled}
              onCheckedChange={(avoidParentScarceModels) => update({ avoidParentScarceModels })}
            />
          }
        />
        <SettingsRow
          label="Scarce models"
          description="Comma-separated model patterns; * matches anything."
          control={
            <Input
              aria-label="Scarce models"
              className="w-64"
              value={scarce}
              disabled={disabled}
              onChange={(event) => setScarce(event.target.value)}
              onBlur={() => {
                const next = scarce
                  .split(',')
                  .map((part) => part.trim())
                  .filter(Boolean)
                  .slice(0, 20);
                if (next.join(',') !== settings.scarceModels.join(',')) {
                  update({ scarceModels: next });
                }
              }}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Policy (cheapest tier first)" bare>
        <div className="flex flex-col gap-3">
          {settings.tiers.map((tier, index) => (
            <TierEditor
              key={tier.id}
              tier={tier}
              index={index}
              count={settings.tiers.length}
              disabled={disabled}
              onChange={(next) => setTiers(settings.tiers.map((t, i) => (i === index ? next : t)))}
              onMove={(delta) => setTiers(move(settings.tiers, index, delta))}
            />
          ))}
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() =>
                update({
                  tiers: DEFAULT_SUBAGENT_ROUTING_SETTINGS.tiers,
                  scarceModels: DEFAULT_SUBAGENT_ROUTING_SETTINGS.scarceModels,
                })
              }
            >
              Restore default policy
            </Button>
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="Live headroom preview" bare>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-xs text-foreground-muted">
            <span>
              {preview?.enabled
                ? `Snapshot for sub-agents: ${preview.snapshotFile}${snapshotUpdatedLabel}`
                : 'Routing is off; the preview shows what it would do.'}
              {preview?.lastError ? ` · Last error: ${preview.lastError}` : ''}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void loadPreview(true)}>
              Refresh
            </Button>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="text-foreground-muted">
              <tr>
                <th className="py-1 font-normal">Tier</th>
                <th className="py-1 font-normal">Candidate</th>
                <th className="py-1 font-normal">Headroom</th>
                <th className="py-1 font-normal">Window resets</th>
                <th className="py-1 font-normal">Recommended</th>
              </tr>
            </thead>
            <tbody>
              {(preview?.rows ?? []).map((row, index) => (
                <tr
                  key={`${row.tierId}:${row.provider}:${row.model}:${index}`}
                  className={row.enabled && row.tierEnabled ? '' : 'opacity-50'}
                >
                  <td className="py-1">{row.tierLabel}</td>
                  <td className="py-1">
                    {row.provider} / {row.model}
                    {row.scarce ? ' · scarce' : ''}
                  </td>
                  <td className="py-1">
                    <Badge tone={STATE_TONE[row.state]}>{QUOTA_STATE_LABELS[row.state]}</Badge>
                    {row.remainingPercent !== null ? ` ${row.remainingPercent}% left` : ''}
                    {row.windowLabel ? ` (${row.windowLabel})` : ''}
                  </td>
                  <td className="py-1">{formatReset(row.resetsAt)}</td>
                  <td className="py-1">{row.recommended ? 'yes' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>
    </div>
  );
}
