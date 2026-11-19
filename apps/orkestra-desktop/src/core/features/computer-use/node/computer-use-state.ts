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
 * Bilgisayar kullanımının çift kilidi ve etkinlik günlüğü. Sohbet kilidi yalnızca bellekte
 * tutulur (uygulama yeniden başlayınca kapanır) ve yalnızca `enableConversation` ile açılır;
 * bunu çağıran tek yer arayüzün Wire denetleyicisidir. Ajan araçları yalnızca `check` ile okur.
 */
export class ComputerUseState {
  private readonly enabled = new Set<string>();
  private readonly log: ComputerUseLogEntry[] = [];

  constructor(private readonly options: ComputerUseStateOptions) {}

  get supported(): boolean {
    return this.options.platform === 'darwin';
  }

  isConversationEnabled(conversationId: string): boolean {
    return this.enabled.has(conversationId);
  }

  /** Yalnızca kullanıcı arayüzü eylemi (Wire denetleyicisi) çağırır. */
  enableConversation(conversationId: string): void {
    this.enabled.add(conversationId);
  }

  disableConversation(conversationId: string): void {
    this.enabled.delete(conversationId);
  }

  forgetConversation(conversationId: string): void {
    this.enabled.delete(conversationId);
  }

  /** Her araç çağrısından önce ve sunucu oturuma eklenmeden önce sorulur. */
  async check(conversationId: string): Promise<ComputerUseGate> {
    if (!this.supported) return { open: false, reason: 'unsupported' };
    if (!(await this.options.isGloballyEnabled())) return { open: false, reason: 'global-off' };
    if (!this.enabled.has(conversationId)) return { open: false, reason: 'conversation-off' };
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
