import { createSignal, onCleanup, type Accessor } from 'solid-js';

/** Format an epoch-ms timestamp cleanly as HH:mm for message footers. */
export function formatMessageTime(createdAt?: number): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }
  try {
    return new Date(createdAt).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

/**
 * T3 tarzı saat etiketi: bugünse "14:32", dünse "Dün 14:32", daha eskiyse "25 Kas 14:32".
 */
export function formatClockTime(createdAt?: number, now: number = Date.now()): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 1_000_000_000_000) {
    return null;
  }
  try {
    const date = new Date(createdAt);
    const ref = new Date(now);
    const hhmm = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const startOfToday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diffDays = Math.round((startOfToday - startOfDate) / DAY);
    if (diffDays === 0) return hhmm;
    if (diffDays === 1) return `Dün ${hhmm}`;
    const sameYear = date.getFullYear() === ref.getFullYear();
    const datePart = date.toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
    return `${datePart} ${hhmm}`;
  } catch {
    return null;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Kullanıcı mesajının altındaki göreli zaman (Claude uygulamasındaki gibi): "şimdi",
 * "15 dakika önce", "3 saat önce", "2 gün önce"; bir haftadan eskiyse tarih ("12 Kas",
 * başka yıldaysa "12 Kas 2025"). Geçersiz zaman damgasında `null`.
 */
export function formatRelativeMessageTime(
  createdAt?: number,
  now: number = Date.now()
): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }
  // Saat kayması yüzünden "gelecekteki" damgalar da "şimdi" sayılır.
  const diff = Math.max(0, now - createdAt);
  if (diff < MINUTE) return 'şimdi';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} dakika önce`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} saat önce`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} gün önce`;
  try {
    const date = new Date(createdAt);
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    return date.toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  } catch {
    return null;
  }
}

/** Göreli zamanın üzerine gelince gösterilen tam tarih ve saat ("25 Kasım 2026 17:36"). */
export function formatFullMessageTime(createdAt?: number): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }
  try {
    return new Date(createdAt).toLocaleString('tr-TR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

// ── Paylaşılan dakika saati ──────────────────────────────────────────────────
// Görünen bütün kullanıcı mesajları tek bir zamanlayıcıyı paylaşır; abone kalmayınca durur.
// Bu bir CSS animasyonu değildir: dakikada bir yalnızca zaman metni yenilenir.

const [minuteNow, setMinuteNow] = createSignal(Date.now());
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Dakikada bir güncellenen "şimdi" sinyali; bileşen kaldırılınca aboneliği bırakır. */
export function useMinuteClock(): Accessor<number> {
  subscribers += 1;
  if (subscribers === 1) {
    setMinuteNow(Date.now());
    timer = setInterval(() => setMinuteNow(Date.now()), MINUTE);
  }
  onCleanup(() => {
    subscribers -= 1;
    if (subscribers === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  });
  return minuteNow;
}
