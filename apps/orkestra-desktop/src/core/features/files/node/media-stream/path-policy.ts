import { mediaMimeTypeForPath } from '../../api/media-stream';

// Konuşmalar dilimindeki uzak medya önizleme kurallarıyla aynı ruhta: gizli anahtar, kimlik
// bilgisi ve sistem dizinleri hiçbir zaman akıtılmaz, uzantı medya gibi görünse bile.
const SENSITIVE_PATH_RE =
  /(^|[/\\])(\.env(\.|$)|\.ssh([/\\]|$)|\.gnupg([/\\]|$)|\.aws([/\\]|$)|\.config[/\\]gh([/\\]|$)|\.netrc$|\.npmrc$|keychain|credentials|secrets|auth\.json$|tokens\.json$|orkestra4\.db|id_rsa|id_ed25519|known_hosts$)|(\.(pem|key|p12|pfx|keystore|jks)$)/i;
const SYSTEM_PREFIXES = ['/etc/', '/proc/', '/sys/', '/dev/', '/private/etc/'];

export type MediaPathVerdict =
  | { ok: true; mimeType: string }
  | { ok: false; type: 'unsupported' | 'forbidden'; message: string };

/** Mutlak, `..` içermeyen, medya/PDF uzantılı ve hassas olmayan yollar kabul edilir. */
export function checkMediaPath(path: string): MediaPathVerdict {
  if (!path || path.includes('\0')) {
    return { ok: false, type: 'forbidden', message: 'Geçersiz dosya yolu.' };
  }
  const normalized = path.replaceAll('\\', '/');
  const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
  if (!absolute || normalized.split('/').some((part) => part === '..' || part === '.')) {
    return { ok: false, type: 'forbidden', message: 'Geçersiz dosya yolu.' };
  }
  const lower = normalized.toLowerCase();
  if (SYSTEM_PREFIXES.some((prefix) => lower.startsWith(prefix)) || SENSITIVE_PATH_RE.test(path)) {
    return { ok: false, type: 'forbidden', message: 'Bu dosya güvenlik nedeniyle açılamaz.' };
  }
  const mimeType = mediaMimeTypeForPath(path);
  if (!mimeType) {
    return { ok: false, type: 'unsupported', message: 'Bu dosya türü oynatılamaz.' };
  }
  return { ok: true, mimeType };
}
