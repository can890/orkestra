import { RemoteHandshakeError } from '@orkestra/wire/remote';

/** Bağlantının kullanıcıya yansıyan durumu. Saf; geçişleri `connectionReducer` yapar. */
export type ConnectionIssue =
  | 'unreachable'
  | 'timeout'
  | 'busy'
  | 'rate-limited'
  | 'protocol'
  | 'unknown';

export type TerminalReason = 'auth' | 'version' | 'protocol' | 'unknown';

export type ConnectionStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; hostName: string }
  | { kind: 'reconnecting'; issue: ConnectionIssue | null; attempts: number }
  | { kind: 'failed'; reason: TerminalReason };

export type ConnectionEvent =
  | { type: 'start' }
  | { type: 'ready'; hostName: string }
  | { type: 'disconnected' }
  | { type: 'attempt-failed'; issue: ConnectionIssue }
  | { type: 'terminal'; reason: TerminalReason }
  | { type: 'stop' };

export const IDLE_STATUS: ConnectionStatus = { kind: 'idle' };

export function connectionReducer(
  state: ConnectionStatus,
  event: ConnectionEvent
): ConnectionStatus {
  switch (event.type) {
    case 'start':
      return { kind: 'connecting' };
    case 'stop':
      return IDLE_STATUS;
    case 'ready':
      if (state.kind === 'failed' || state.kind === 'idle') return state;
      return { kind: 'connected', hostName: event.hostName };
    case 'disconnected':
      if (state.kind === 'failed' || state.kind === 'idle') return state;
      return { kind: 'reconnecting', issue: null, attempts: 0 };
    case 'attempt-failed':
      if (state.kind === 'failed' || state.kind === 'idle') return state;
      return {
        kind: 'reconnecting',
        issue: event.issue,
        attempts: state.kind === 'reconnecting' ? state.attempts + 1 : 1,
      };
    case 'terminal':
      if (state.kind === 'idle') return state;
      return { kind: 'failed', reason: event.reason };
  }
}

export type ClassifiedError = {
  issue: ConnectionIssue;
  /** Yeniden denemenin anlamsız olduğu hata; bağlantı kalıcı olarak "failed" olur. */
  terminal: TerminalReason | null;
  retryAfterMs: number | null;
};

/** Hata mesajı/ayrıntısı sır içerebileceği için yalnızca kodlar kullanılır. */
export function classifyConnectionError(error: unknown): ClassifiedError {
  if (error instanceof RemoteHandshakeError) {
    switch (error.code) {
      case 'AUTH_FAILED':
        return { issue: 'protocol', terminal: 'auth', retryAfterMs: null };
      case 'VERSION_UNSUPPORTED':
        return { issue: 'protocol', terminal: 'version', retryAfterMs: null };
      case 'RATE_LIMITED':
        return { issue: 'rate-limited', terminal: null, retryAfterMs: error.retryAfterMs ?? 30_000 };
      case 'BUSY':
        return { issue: 'busy', terminal: null, retryAfterMs: 2_000 };
      case 'TIMEOUT':
        return { issue: 'timeout', terminal: null, retryAfterMs: null };
      case 'UNREACHABLE':
        return { issue: 'unreachable', terminal: null, retryAfterMs: null };
      case 'PROTOCOL':
        return { issue: 'protocol', terminal: null, retryAfterMs: null };
    }
  }
  return { issue: 'unknown', terminal: null, retryAfterMs: null };
}

export function describeStatus(status: ConnectionStatus): string {
  switch (status.kind) {
    case 'idle':
      return 'Bağlı değil';
    case 'connecting':
      return 'Bağlanıyor…';
    case 'connected':
      return `${status.hostName} ile bağlı`;
    case 'reconnecting':
      return describeIssue(status.issue);
    case 'failed':
      return describeTerminal(status.reason);
  }
}

function describeIssue(issue: ConnectionIssue | null): string {
  switch (issue) {
    case 'unreachable':
      return 'Masaüstüne ulaşılamıyor, yeniden deneniyor…';
    case 'timeout':
      return 'Masaüstü yanıt vermiyor, yeniden deneniyor…';
    case 'busy':
      return 'Masaüstü meşgul, birazdan yeniden denenecek…';
    case 'rate-limited':
      return 'Çok fazla deneme yapıldı, biraz bekleniyor…';
    case 'protocol':
      return 'Masaüstüyle anlaşılamadı, yeniden deneniyor…';
    default:
      return 'Bağlantı koptu, yeniden bağlanılıyor…';
  }
}

export function describeTerminal(reason: TerminalReason): string {
  switch (reason) {
    case 'auth':
      return 'Eşleşme geçersiz: cihaz masaüstünden kaldırılmış ya da eşleştirme süresi dolmuş olabilir. Yeniden eşleştirin.';
    case 'version':
      return 'Masaüstü ile uygulama sürümleri uyumsuz. İkisini de güncelleyin.';
    case 'protocol':
      return 'Masaüstüyle iletişim kurulamadı.';
    default:
      return 'Bağlantı kurulamadı.';
  }
}
