import { createScope, type Scope } from '@orkestra/shared/concurrency';
import { toast } from '@orkestra/ui/react/primitives';
import { observe, remote } from '@orkestra/wire/state';
import { computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getMementoClient, type MementoHandle } from '@core/primitives/mementos/browser';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { appSubject } from '@core/primitives/subjects/api';
import { boundPreferenceMap, needsAttention, type LogHealthPreferences } from '../api/attention';
import { getLogHealthClient } from '../api/browser/client';
import {
  logHealthContract,
  type LogHealthGroup,
  type LogHealthReport,
  type RevealLogFileResult,
} from '../api/contract';
import { formatLogHealthSummary } from '../api/summary';
import {
  logHealthPreferencesMemento,
  type LogHealthPreferencesState,
} from '../contributions/mementos';

const MAX_PREFERENCE_ENTRIES = 300;
/** Aynı grup için bildirimler arasında en az bu kadar süre geçer. */
const NOTIFY_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const TOAST_ID = 'log-health-attention';

const EMPTY_PREFERENCES: LogHealthPreferences = { ignored: {}, acknowledged: {} };

/**
 * Renderer tarafı günlük sağlığı deposu: ana süreçteki canlı raporu izler,
 * yok sayma/görüldü tercihlerini kalıcı mementoda tutar ve yeni tekrarlayan bir
 * sorun ortaya çıktığında tek, sessiz bir bildirim gösterir.
 */
export class LogHealthStore {
  report: LogHealthReport | null = null;
  private preferencesHandle: MementoHandle<LogHealthPreferencesState> | null = null;
  private readonly scope: Scope = createScope({ label: 'log-health-store' });
  private readonly toastedThisSession = new Set<string>();
  private started = false;

  constructor() {
    makeObservable<LogHealthStore, 'preferencesHandle'>(this, {
      report: observable.ref,
      preferencesHandle: observable.ref,
      preferences: computed,
      activeGroups: computed,
      ignoredGroups: computed,
      attentionGroups: computed,
      attentionCount: computed,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  get preferences(): LogHealthPreferences {
    return this.preferencesHandle?.value ?? EMPTY_PREFERENCES;
  }

  /** Yok sayılmamış gruplar (ana süreçte önem/sıklığa göre sıralı gelir). */
  get activeGroups(): LogHealthGroup[] {
    const ignored = this.preferences.ignored;
    return (this.report?.groups ?? []).filter((group) => ignored[group.key] === undefined);
  }

  get ignoredGroups(): LogHealthGroup[] {
    const ignored = this.preferences.ignored;
    return (this.report?.groups ?? []).filter((group) => ignored[group.key] !== undefined);
  }

  get attentionGroups(): LogHealthGroup[] {
    const report = this.report;
    if (!report || !this.preferencesHandle) return [];
    const preferences = this.preferences;
    return report.groups.filter((group) =>
      needsAttention(group, preferences, report.sessionStartedAt)
    );
  }

  get attentionCount(): number {
    return this.attentionGroups.length;
  }

  ignore(key: string): void {
    this.updatePreferences((current) => ({
      ...current,
      ignored: boundPreferenceMap(
        { ...current.ignored, [key]: Date.now() },
        MAX_PREFERENCE_ENTRIES
      ),
    }));
  }

  unignore(key: string): void {
    this.updatePreferences((current) => {
      const ignored = { ...current.ignored };
      delete ignored[key];
      return { ...current, ignored };
    });
  }

  /** Şu an dikkat gerektiren grupları "görüldü" olarak işaretler (rozeti söndürür). */
  acknowledgeAttention(): void {
    const keys = this.attentionGroups.map((group) => group.key);
    if (keys.length === 0) return;
    const now = Date.now();
    this.updatePreferences((current) => {
      const acknowledged = { ...current.acknowledged };
      for (const key of keys) acknowledged[key] = now;
      return {
        ...current,
        acknowledged: boundPreferenceMap(acknowledged, MAX_PREFERENCE_ENTRIES),
      };
    });
    toast.dismiss(TOAST_ID);
  }

  /** Verilen grupların maskelenmiş özetini panoya kopyalar. */
  async copySummary(groups: readonly LogHealthGroup[]): Promise<boolean> {
    const report = this.report;
    if (!report) return false;
    const text = formatLogHealthSummary(groups, report);
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async revealLogFile(): Promise<RevealLogFileResult> {
    try {
      const client = await getLogHealthClient();
      return await client.revealLogFile();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async dispose(): Promise<void> {
    await this.scope.dispose();
  }

  private async connect(): Promise<void> {
    const client = await getLogHealthClient();
    const remoteModel = remote(logHealthContract.report, client.report, {
      scope: this.scope,
      lingerMs: 15_000,
    });
    const member = remoteModel(undefined);
    observe(
      member.states.report,
      (snapshot) => {
        runInAction(() => {
          this.report = snapshot.value ?? null;
        });
      },
      { scope: this.scope, immediate: true }
    );

    const handle = this.acquirePreferences();
    if (!handle) return;
    // Tercihler yüklenmeden göstergeyi değerlendirmek yanlış bildirimlere yol açar.
    await handle.ready.catch(() => undefined);
    runInAction(() => {
      this.preferencesHandle = handle;
    });

    const dispose = reaction(
      () => this.attentionGroups.map((group) => group.key).join(','),
      () => this.maybeNotify(),
      { fireImmediately: true }
    );
    this.scope.add(dispose);
  }

  private acquirePreferences(): MementoHandle<LogHealthPreferencesState> | null {
    try {
      const space = getMementoClient().subject(appSubject({}));
      const handle = space.handle(logHealthPreferencesMemento);
      this.scope.add(async () => {
        await handle.flush().catch(() => undefined);
        await handle.dispose();
        await space.release();
      });
      return handle;
    } catch {
      return null;
    }
  }

  private updatePreferences(
    update: (current: LogHealthPreferencesState) => LogHealthPreferencesState
  ): void {
    this.preferencesHandle?.update(update);
  }

  private maybeNotify(): void {
    const handle = this.preferencesHandle;
    if (!handle) return;
    // Kullanıcı zaten Günlük sağlığı sayfasındaysa bildirime gerek yok.
    if (isLogHealthPageOpen()) return;

    const now = Date.now();
    const notified = handle.value.notified;
    const fresh = this.attentionGroups.filter(
      (group) =>
        !this.toastedThisSession.has(group.key) &&
        now - (notified[group.key] ?? 0) >= NOTIFY_COOLDOWN_MS
    );
    const first = fresh[0];
    if (!first) return;

    for (const group of fresh) this.toastedThisSession.add(group.key);
    this.updatePreferences((current) => {
      const next = { ...current.notified };
      for (const group of fresh) next[group.key] = now;
      return { ...current, notified: boundPreferenceMap(next, MAX_PREFERENCE_ENTRIES) };
    });

    const others = fresh.length - 1;
    toast.warning('Günlükte tekrarlayan bir sorun var', {
      id: TOAST_ID,
      description: others > 0 ? `${first.template} (ve ${others} sorun daha)` : first.template,
      duration: 8_000,
      action: {
        label: 'Göster',
        onClick: () => getNavigation().navigate(settingsViewDef({ tab: 'log-health' })),
      },
    });
  }
}

function isLogHealthPageOpen(): boolean {
  try {
    const ref = getNavigation().currentRef;
    return ref.viewId === 'settings' && (ref.params as { tab?: string }).tab === 'log-health';
  } catch {
    return false;
  }
}
