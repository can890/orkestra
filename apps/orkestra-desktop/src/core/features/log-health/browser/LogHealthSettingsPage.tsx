import { PageLayout, SettingsCard, SettingsSection } from '@orkestra/ui/react/patterns';
import {
  AbsoluteTime,
  Badge,
  Button,
  Collapsible,
  RelativeTime,
  Spinner,
  toast,
} from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { LogHealthGroup, LogHealthReport } from '../api/contract';
import { logHealthLevelLabel } from '../api/summary';
import { getLogHealthStore } from '../contributions/app-stores';
import type { LogHealthStore } from './log-health-store';

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const REVEAL_LABEL = IS_MAC
  ? "Günlük dosyasını Finder'da göster"
  : 'Günlük dosyasını klasörde göster';

/** Ayarlar → Günlük sağlığı: tekrarlayan uyarı ve hataların listesi. */
export const LogHealthSettingsPage = observer(function LogHealthSettingsPage() {
  const store = getLogHealthStore();
  const report = store.report;
  const [newKeys, setNewKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [showIgnored, setShowIgnored] = useState(false);
  const attentionKeys = store.attentionGroups.map((group) => group.key).join(',');

  // Sayfa açıkken dikkat gerektiren grupları "yeni" olarak etiketle ve rozeti söndür.
  useEffect(() => {
    if (!attentionKeys) return;
    setNewKeys((previous) => new Set([...previous, ...attentionKeys.split(',')]));
    store.acknowledgeAttention();
  }, [attentionKeys, store]);

  const active = store.activeGroups;
  const ignored = store.ignoredGroups;
  const showList = report?.status === 'ready' || active.length > 0;

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Günlük sağlığı"
        description="Uygulama günlüğünde tekrarlayan uyarı ve hataları gruplar. Gösterilen ayrıntılar gizli bilgilerden arındırılmıştır."
      />

      <SettingsSection bare>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ReportStatus report={report} activeCount={active.length} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void reveal(store)}>
              {REVEAL_LABEL}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={active.length === 0}
              onClick={() => void copy(store, active)}
            >
              Tümünü kopyala
            </Button>
          </div>
        </div>
      </SettingsSection>

      {showList && active.length > 0 ? (
        <SettingsSection title="Tekrarlayan sorunlar" bare>
          <SettingsCard>
            <div className="flex flex-col divide-y divide-border/60">
              {active.map((group) => (
                <GroupRow
                  key={group.key}
                  group={group}
                  isNew={newKeys.has(group.key)}
                  onCopy={() => void copy(store, [group])}
                  onToggleIgnore={() => store.ignore(group.key)}
                  ignoreLabel="Yok say"
                />
              ))}
            </div>
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {showList && active.length === 0 ? (
        <SettingsSection bare>
          <SettingsCard>
            <p className="text-muted-foreground text-sm">
              Son {report?.windowDays ?? 7} günde dikkat edilecek bir uyarı veya hata yok.
            </p>
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {ignored.length > 0 ? (
        <SettingsSection bare>
          <Collapsible.Root open={showIgnored} onOpenChange={setShowIgnored}>
            <Collapsible.Trigger className="text-muted-foreground text-sm">
              Yok sayılanlar ({ignored.length})
            </Collapsible.Trigger>
            <Collapsible.Panel>
              <SettingsCard className="mt-3">
                <div className="flex flex-col divide-y divide-border/60">
                  {ignored.map((group) => (
                    <GroupRow
                      key={group.key}
                      group={group}
                      isNew={false}
                      onCopy={() => void copy(store, [group])}
                      onToggleIgnore={() => store.unignore(group.key)}
                      ignoreLabel="Geri al"
                    />
                  ))}
                </div>
              </SettingsCard>
            </Collapsible.Panel>
          </Collapsible.Root>
        </SettingsSection>
      ) : null}
    </div>
  );
});

function ReportStatus({
  report,
  activeCount,
}: {
  report: LogHealthReport | null;
  activeCount: number;
}) {
  if (!report || report.status === 'idle' || report.status === 'scanning') {
    return (
      <span className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner size="sm" />
        Günlük taranıyor…
      </span>
    );
  }
  if (report.status === 'unavailable') {
    return <span className="text-muted-foreground text-sm">Günlük dosyası bulunamadı.</span>;
  }
  return (
    <span className="text-muted-foreground text-sm">
      Son {report.windowDays} gün · {activeCount} grup
      {report.truncated ? ' · yalnızca en yeni kayıtlar tarandı' : ''}
    </span>
  );
}

function GroupRow({
  group,
  isNew,
  onCopy,
  onToggleIgnore,
  ignoreLabel,
}: {
  group: LogHealthGroup;
  isNew: boolean;
  onCopy: () => void;
  onToggleIgnore: () => void;
  ignoreLabel: string;
}) {
  const tone = group.level === 'warn' ? 'warning' : 'error';
  return (
    <Collapsible.Root className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <Collapsible.Trigger className="min-w-0 flex-1 text-left">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <Badge tone={tone}>{logHealthLevelLabel(group.level)}</Badge>
              {isNew ? (
                <Badge tone="info" variant="outline">
                  Yeni
                </Badge>
              ) : null}
              <span className="truncate text-sm font-medium text-foreground">{group.template}</span>
            </div>
            {group.errorSignature ? (
              <span className="text-muted-foreground truncate font-mono text-xs">
                {group.errorSignature}
              </span>
            ) : null}
            <span className="text-muted-foreground text-xs">
              {group.count} kez · bu oturumda {group.sessionCount} · {group.launchCount} açılış ·
              son <RelativeTime value={group.lastSeen} />
            </span>
          </div>
        </Collapsible.Trigger>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onCopy}>
            Kopyala
          </Button>
          <Button size="sm" variant="ghost" onClick={onToggleIgnore}>
            {ignoreLabel}
          </Button>
        </div>
      </div>
      <Collapsible.Panel>
        <GroupDetails group={group} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function GroupDetails({ group }: { group: LogHealthGroup }) {
  const example = group.example;
  const errorLine = [example.errorName, example.errorMessage].filter(Boolean).join(': ');
  return (
    <div className="mt-3 space-y-3 text-xs">
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>İlk görülme</dt>
        <dd>
          <AbsoluteTime value={group.firstSeen} includeYear />
        </dd>
        <dt>Son görülme</dt>
        <dd>
          <AbsoluteTime value={group.lastSeen} includeYear />
        </dd>
        <dt>Görüldüğü gün</dt>
        <dd>{group.dayCount}</dd>
        {group.processes.length > 0 ? (
          <>
            <dt>Süreçler</dt>
            <dd className="font-mono">{group.processes.join(', ')}</dd>
          </>
        ) : null}
      </dl>
      <DetailBlock title="Son örnek mesaj" value={example.message} />
      {errorLine ? <DetailBlock title="Hata" value={errorLine} /> : null}
      {example.stack ? <DetailBlock title="Yığın izi" value={example.stack} /> : null}
      {example.fields ? <DetailBlock title="Alanlar" value={example.fields} /> : null}
    </div>
  );
}

function DetailBlock({ title, value }: { title: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground font-medium">{title}</div>
      <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs break-all whitespace-pre-wrap text-foreground">
        {value}
      </pre>
    </div>
  );
}

async function reveal(store: LogHealthStore): Promise<void> {
  const result = await store.revealLogFile();
  if (!result.success) toast.error('Günlük dosyası gösterilemedi', { description: result.error });
}

async function copy(store: LogHealthStore, groups: readonly LogHealthGroup[]): Promise<void> {
  const copied = await store.copySummary(groups);
  if (copied) toast.success('Özet panoya kopyalandı');
  else toast.error('Özet kopyalanamadı');
}
