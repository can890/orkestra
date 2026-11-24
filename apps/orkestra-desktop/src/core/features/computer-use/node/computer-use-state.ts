import type { ComputerUseLogEntry } from '../api';

const MAX_LOG_ENTRIES = 300;

export type ComputerUseGate =
  | { open: true }
  | { open: false; reason: 'unsupported' | 'global-off' | 'conversation-off' };

export type ComputerUseStateOptions = {
  /** Genel ayar; her denetimde yeniden okunur, böylece ayar kapanınca araçlar hemen durur. */
  isGloballyEnabled(): Promise<boolean>;
  platform: NodeJS.Platform;
  now?: () => number;
};

/**
 * Bilgisayar kullanımının genel kilidi, sohbet bazlı durdurma durumu (opt-out) ve etkinlik
 * günlüğü. Genel ayar (`isGloballyEnabled`) açık olduğu sürece tüm macOS yerel sohbetlerinde
 * bilgisayar kullanımı varsayılan olarak etkindir. Kullanıcı aktif sohbette "Durdur" ile
 * yalnızca o sohbeti kapatabilir (`stopped` yalnızca bellekte tutulur) ve isterse
 * `enableConversation` ile yeniden açabilir; bunu çağıran tek yer arayüzün Wire
 * denetleyicisidir. Ajan araçları yalnızca `check` ile okur.
 */
export class ComputerUseState {
  private readonly stopped = new Set<string>();
  private readonly log: ComputerUseLogEntry[] = [];

  constructor(private readonly options: ComputerUseStateOptions) {}

  get supported(): boolean {
    return this.options.platform === 'darwin';
  }

  /** Genel ayar açıkken macOS üzerinde durdurulmamış tüm sohbetler etkindir. */
  isConversationEnabled(conversationId: string): boolean {
    return this.supported && !this.stopped.has(conversationId);
  }

  /** Durdurulmuş bir sohbeti yeniden açar; yalnızca arayüzün Wire denetleyicisi çağırır. */
  enableConversation(conversationId: string): void {
    this.stopped.delete(conversationId);
  }

  /** Aktif sohbeti anında durdurur ("Durdur" düğmesi); diğer sohbetleri etkilemez. */
  disableConversation(conversationId: string): void {
    this.stopped.add(conversationId);
  }

  /** Sohbet kapandığında/silindiğinde bellek içi durdurma kaydını temizler. */
  forgetConversation(conversationId: string): void {
    this.stopped.delete(conversationId);
  }

  /** Her araç çağrısından önce ve sunucu oturuma eklenmeden önce sorulur. */
  async check(conversationId: string): Promise<ComputerUseGate> {
    if (!this.supported) return { open: false, reason: 'unsupported' };
    if (!(await this.options.isGloballyEnabled())) return { open: false, reason: 'global-off' };
    if (this.stopped.has(conversationId)) return { open: false, reason: 'conversation-off' };
    return { open: true };
  }

  record(entry: Omit<ComputerUseLogEntry, 'at'>): void {
    this.log.push({ ...entry, at: (this.options.now ?? Date.now)() });
    if (this.log.length > MAX_LOG_ENTRIES) this.log.splice(0, this.log.length - MAX_LOG_ENTRIES);
  }

  activity(conversationId: string, limit = 50): ComputerUseLogEntry[] {
    return this.log.filter((entry) => entry.conversationId === conversationId).slice(-limit);
  }

  async globalEnabled(): Promise<boolean> {
    return this.options.isGloballyEnabled();
  }
}

export function gateMessage(reason: Extract<ComputerUseGate, { open: false }>['reason']): string {
  switch (reason) {
    case 'unsupported':
      return 'Computer use is only available on macOS.';
    case 'global-off':
      return 'Computer use is turned off in Orkestra settings. Ask the user to turn it on; you cannot change this yourself.';
    case 'conversation-off':
      return 'Computer use is not enabled for this conversation, or the user stopped it. Ask the user to enable it in the conversation; you cannot change this yourself.';
  }
}
