import { PageLayout, SettingsCard, SettingsSection } from '@orkestra/ui/react/patterns';
import {
  AbsoluteTime,
  Badge,
  Button,
  Collapsible,
  Field,
  Input,
  Select,
  Spinner,
  Switch,
  Textarea,
  toast,
} from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import {
  getProjectManagerStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  DEFAULT_HOOK_TIMEOUT_SEC,
  HOOK_EVENTS,
  HOOK_EVENT_LABELS,
  MAX_HOOKS,
  MAX_HOOK_TIMEOUT_SEC,
  type HookDefinition,
  type HookEventName,
  type LifecycleHooksConfig,
} from '../api/hook-config';
import type { HookRunRecord, HookRunStatus } from '../api/hook-runs';
import { useLifecycleHooks } from './use-lifecycle-hooks';

const ALL_PROJECTS = '__all';
const MANY_PROJECTS = '__many';

const STATUS_LABEL: Record<HookRunStatus, string> = {
  ok: 'Başarılı',
  failed: 'Başarısız',
  timeout: 'Zaman aşımı',
  skipped: 'Atlandı',
  error: 'Hata',
};
const STATUS_TONE: Record<HookRunStatus, 'success' | 'error' | 'warning' | 'neutral'> = {
  ok: 'success',
  failed: 'error',
  timeout: 'warning',
  skipped: 'neutral',
  error: 'error',
};

const INTEGRITY_WARNINGS: Record<string, string> = {
  tampered:
    'Kanca dosyası uygulama dışında değiştirilmiş ya da doğrulanamadı; güvenlik için yok sayıldı ve hiçbir kanca çalışmıyor. Aşağıdan yeniden tanımlayıp kaydedebilirsiniz.',
  invalid: 'Kanca dosyası okunamadı; yok sayıldı ve hiçbir kanca çalışmıyor.',
  'future-version':
    'Kanca dosyası daha yeni bir Orkestra sürümüyle yazılmış; bu sürüm onu okuyamıyor ve hiçbir kanca çalışmıyor.',
  unavailable: 'Güvenli depolama kullanılamadığı için kancalar kapalı; kanca kaydedilemez.',
};

function newHook(): HookDefinition {
  return {
    id: `h-${crypto.randomUUID().slice(0, 8)}`,
    name: '',
    event: 'conversation.turn-ended',
    command: '',
    enabled: false,
    timeoutSec: DEFAULT_HOOK_TIMEOUT_SEC,
    projectIds: [],
  };
}

/** Ayarlar → Kancalar: olaylarda kullanıcının yazdığı komutları çalıştırır (yalnızca gözlemsel). */
export const LifecycleHooksSettingsPage = observer(function LifecycleHooksSettingsPage() {
  const model = useLifecycleHooks();
  const [draft, setDraft] = useState<LifecycleHooksConfig | null>(null);
  const [saving, setSaving] = useState(false);

  // Sunucudan ilk durum gelince taslağı doldur; kayıttan sonra taslak zaten eşittir.
  useEffect(() => {
    if (model.saved && draft === null) setDraft(model.saved.config);
  }, [model.saved, draft]);

  useEffect(() => {
    void getProjectManagerStore().load();
  }, []);

  const projects = [...getProjectManagerStore().projects.values()].map((store) => ({
    id: store.id,
    name: projectDisplayName(store) ?? store.id,
  }));

  const dirty = useMemo(
    () =>
      draft !== null &&
      model.saved !== null &&
      JSON.stringify(draft) !== JSON.stringify(model.saved.config),
    [draft, model.saved]
  );

  if (model.loading || !model.saved || !draft) {
    return (
      <div className="space-y-8 pb-10">
        <PageLayout.Header sticky draggable title="Kancalar" />
        <span className="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner size="sm" />
          Yükleniyor…
        </span>
      </div>
    );
  }

  const saved = model.saved;
  const warning = INTEGRITY_WARNINGS[saved.status];
  const canSave = saved.status !== 'unavailable';

  const update = (id: string, patch: Partial<HookDefinition>) =>
    setDraft({
      ...draft,
      hooks: draft.hooks.map((hook) => (hook.id === id ? { ...hook, ...patch } : hook)),
    });

  const persist = async (config: LifecycleHooksConfig, successMessage: string) => {
    setSaving(true);
    const result = await model.save(config);
    setSaving(false);
    if (result.success) {
      toast.success(successMessage);
      return true;
    }
    toast.error('Kancalar kaydedilemedi', { description: result.error });
    return false;
  };

  const togglePaused = async (paused: boolean) => {
    // Güvenlik anahtarı hemen uygulanır; kaydedilmemiş komut düzenlemelerini saklamaz.
    const ok = await persist(
      { ...saved.config, paused },
      paused ? 'Tüm kancalar duraklatıldı' : 'Kancalar sürdürüldü'
    );
    if (ok) setDraft((current) => (current ? { ...current, paused } : current));
  };

  const runsFor = (hookId: string): HookRunRecord[] =>
    model.runs.filter((run) => run.hookId === hookId);

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Kancalar"
        description="Ajan ve görev olaylarında kendi yazdığınız komutları çalıştırın. Kancalar yalnızca gözlemlidir: ajanı engelleyemez, geciktiremez ya da değiştiremez."
      />

      {warning ? (
        <SettingsSection bare>
          <SettingsCard>
            <p className="text-sm text-foreground-warning">{warning}</p>
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection bare>
        <SettingsCard>
          <div className="space-y-2 text-sm">
            <p>
              Komutlar sizin kullanıcı yetkilerinizle, ev dizininizde ve host varsayılan{' '}
              <code>shellSetup</code> ile çalışır. Olay verisi komut metnine gömülmez: JSON olarak
              stdin&apos;e yazılır; ortamda yalnızca <code>ORKESTRA_HOOK_EVENT</code>,{' '}
              <code>ORKESTRA_TASK_ID</code>, <code>ORKESTRA_CONVERSATION_ID</code> ve{' '}
              <code>ORKESTRA_PROJECT_ID</code> bulunur (prompt ve mesaj içeriği env&apos;e konmaz).
            </p>
            <p className="text-muted-foreground">
              Yalnızca yerel projelerde çalışır: SSH projelerinde olaylar için kanca çalıştırılmaz.
              Kanca tanımları yalnızca bu sayfadan eklenir; depo dosyalarından, ajan araçlarından ya
              da uzak erişimden değiştirilemez. Terminal (TUI) sohbetlerinde prompt olayı yoktur.
            </p>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection bare>
        <SettingsCard>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Tüm kancaları duraklat</div>
              <div className="text-muted-foreground text-xs">
                Açıkken hiçbir kanca çalışmaz; tanımlar korunur.
              </div>
            </div>
            <Switch
              aria-label="Tüm kancaları duraklat"
              checked={saved.config.paused}
              disabled={saving || !canSave}
              onCheckedChange={(checked) => void togglePaused(checked)}
            />
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Kancalar" bare>
        <div className="space-y-4">
          {draft.hooks.length === 0 ? (
            <SettingsCard>
              <p className="text-muted-foreground text-sm">
                Henüz kanca yok. Varsayılan olarak hiçbir kanca tanımlı gelmez.
              </p>
            </SettingsCard>
          ) : null}
          {draft.hooks.map((hook) => (
            <HookCard
              key={hook.id}
              hook={hook}
              projects={projects}
              runs={runsFor(hook.id)}
              unsavedNew={!saved.config.hooks.some((entry) => entry.id === hook.id)}
              onChange={(patch) => update(hook.id, patch)}
              onRemove={() =>
                setDraft({ ...draft, hooks: draft.hooks.filter((entry) => entry.id !== hook.id) })
              }
            />
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={draft.hooks.length >= MAX_HOOKS}
              onClick={() => setDraft({ ...draft, hooks: [...draft.hooks, newHook()] })}
            >
              Kanca ekle
            </Button>
            <Button
              size="sm"
              disabled={!dirty || saving || !canSave}
              onClick={() => void persist(draft, 'Kancalar kaydedildi')}
            >
              {saving ? 'Kaydediliyor…' : 'Değişiklikleri kaydet'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!dirty || saving}
              onClick={() => setDraft(saved.config)}
            >
              Vazgeç
            </Button>
            {model.runs.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => void model.clearRuns()}>
                Günlüğü temizle
              </Button>
            ) : null}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
});

function HookCard({
  hook,
  projects,
  runs,
  unsavedNew,
  onChange,
  onRemove,
}: {
  hook: HookDefinition;
  projects: Array<{ id: string; name: string }>;
  runs: HookRunRecord[];
  unsavedNew: boolean;
  onChange(patch: Partial<HookDefinition>): void;
  onRemove(): void;
}) {
  const projectValue =
    hook.projectIds.length === 0
      ? ALL_PROJECTS
      : hook.projectIds.length === 1
        ? hook.projectIds[0]!
        : MANY_PROJECTS;
  return (
    <SettingsCard>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Input
            aria-label="Kanca adı"
            value={hook.name}
            maxLength={80}
            placeholder="Kanca adı (isteğe bağlı)"
            onChange={(event) => onChange({ name: event.target.value })}
          />
          <div className="flex shrink-0 items-center gap-3">
            <Switch
              aria-label="Kancayı etkinleştir"
              checked={hook.enabled}
              onCheckedChange={(checked) => onChange({ enabled: checked })}
            />
            <Button size="sm" variant="ghost" onClick={onRemove}>
              Sil
            </Button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field.Root>
            <Field.Label>Olay</Field.Label>
            <Select.Root
              value={hook.event}
              onValueChange={(value) => value && onChange({ event: value as HookEventName })}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {HOOK_EVENTS.map((event) => (
                  <Select.Item key={event} value={event}>
                    {HOOK_EVENT_LABELS[event]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Field.Root>
          <Field.Root>
            <Field.Label>Proje</Field.Label>
            <Select.Root
              value={projectValue}
              onValueChange={(value) => {
                if (value === null || value === MANY_PROJECTS) return;
                onChange({ projectIds: value === ALL_PROJECTS ? [] : [value] });
              }}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value={ALL_PROJECTS}>Tüm projeler</Select.Item>
                {projectValue === MANY_PROJECTS ? (
                  <Select.Item value={MANY_PROJECTS}>{hook.projectIds.length} proje</Select.Item>
                ) : null}
                {projects.map((project) => (
                  <Select.Item key={project.id} value={project.id}>
                    {project.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Field.Root>
          <Field.Root>
            <Field.Label>Zaman aşımı (sn)</Field.Label>
            <Input
              type="number"
              min={1}
              max={MAX_HOOK_TIMEOUT_SEC}
              value={hook.timeoutSec}
              onChange={(event) => {
                const parsed = Math.round(Number(event.target.value));
                if (Number.isFinite(parsed)) {
                  onChange({ timeoutSec: Math.min(MAX_HOOK_TIMEOUT_SEC, Math.max(1, parsed)) });
                }
              }}
            />
          </Field.Root>
        </div>

        <Field.Root>
          <Field.Label>Komut</Field.Label>
          <Textarea
            className="font-mono text-xs"
            rows={3}
            spellCheck={false}
            value={hook.command}
            placeholder={'jq -r .data.prompt >> ~/orkestra-promptlar.log'}
            onChange={(event) => onChange({ command: event.target.value })}
          />
        </Field.Root>

        {unsavedNew ? (
          <p className="text-muted-foreground text-xs">
            Kaydedilene kadar çalışmaz; kayıttan sonra günlük burada görünür.
          </p>
        ) : (
          <RunLog runs={runs} />
        )}
      </div>
    </SettingsCard>
  );
}

function RunLog({ runs }: { runs: HookRunRecord[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="text-muted-foreground text-sm">
        Son çalıştırmalar ({runs.length})
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {runs.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-xs">Henüz çalışmadı.</p>
        ) : (
          <div className="mt-2 space-y-3">
            {runs.map((run) => (
              <div key={run.id} className="space-y-1 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</Badge>
                  <span>{HOOK_EVENT_LABELS[run.event]}</span>
                  <span className="text-muted-foreground">
                    <AbsoluteTime value={run.startedAt} /> · {run.durationMs} ms
                    {run.exitCode !== null ? ` · çıkış kodu ${run.exitCode}` : ''}
                    {run.signal ? ` · ${run.signal}` : ''}
                  </span>
                </div>
                {run.note ? <div className="text-muted-foreground">{run.note}</div> : null}
                {run.stdoutTail ? <OutputBlock title="stdout" value={run.stdoutTail} /> : null}
                {run.stderrTail ? <OutputBlock title="stderr" value={run.stderrTail} /> : null}
              </div>
            ))}
          </div>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function OutputBlock({ title, value }: { title: string; value: string }) {
  return (
    <pre
      aria-label={title}
      className="bg-muted/40 max-h-40 overflow-auto rounded-md p-2 font-mono text-xs break-all whitespace-pre-wrap text-foreground"
    >
      {value}
    </pre>
  );
}
