import { DEEP_LINK_SCHEME } from '@core/primitives/app-identity/api/app-identity';

/**
 * Dış dünyadan gelen `orkestra://` bağlantıları. Bağlantılar YALNIZCA gezinme
 * yapar: kimlik taşır, hiçbir komut, prompt, dosya işlemi, ayar değişikliği ya
 * da ağ isteği taşımaz. Ayrıştırıcı bilinçli olarak sıkıdır; tanınmayan her şey
 * `undefined` döner ve sessizce yok sayılır.
 */

export const DEEP_LINK_KINDS = ['task', 'project', 'conversation'] as const;
export type DeepLinkKind = (typeof DEEP_LINK_KINDS)[number];

export interface DeepLinkRoute {
  readonly kind: DeepLinkKind;
  readonly id: string;
}

/** Bütün bağlantı metni için üst sınır (en uzun geçerli bağlantı ~160 karakterdir). */
export const DEEP_LINK_MAX_LENGTH = 256;

/**
 * Depodaki kimlikler UUID'dir (randomUUID); eski içe aktarımlardan gelenler
 * `claude-chat-<görev>-<zaman>` gibi harf, rakam, tire ve alt çizgiden oluşur.
 * Nokta, eğik çizgi, yüzde, `@`, `:`, `?`, `#` ve boşluk kasıtlı olarak dışarıdadır.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KIND_PATTERN = /^(task|project|conversation)$/;
const CONTROL_OR_SPACE = /[\u0000- \u007f-\u009f]/;

export function isValidDeepLinkId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/**
 * `<şema>://<tür>/<kimlik>` biçimini katı biçimde ayrıştırır. Şema büyük/küçük
 * harf duyarsızdır (RFC 3986); tür ve kimlik değildir. Tek bir sondaki eğik
 * çizgi (bazı işletim sistemleri ekler) kabul edilir; başka her şey reddedilir:
 * sorgu, parça, ek yol parçası, kullanıcı bilgisi, port, yüzde kodlaması.
 */
export function parseDeepLink(
  raw: unknown,
  scheme: string = DEEP_LINK_SCHEME
): DeepLinkRoute | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0 || raw.length > DEEP_LINK_MAX_LENGTH) return undefined;
  if (CONTROL_OR_SPACE.test(raw)) return undefined;

  const prefix = `${scheme}://`;
  if (raw.length <= prefix.length) return undefined;
  if (raw.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return undefined;

  let rest = raw.slice(prefix.length);
  if (rest.endsWith('/')) rest = rest.slice(0, -1);

  const segments = rest.split('/');
  if (segments.length !== 2) return undefined;
  const [kind, id] = segments as [string, string];
  if (!KIND_PATTERN.test(kind)) return undefined;
  if (!ID_PATTERN.test(id)) return undefined;
  return { kind: kind as DeepLinkKind, id };
}

export function buildDeepLink(route: DeepLinkRoute, scheme: string = DEEP_LINK_SCHEME): string {
  return `${scheme}://${route.kind}/${route.id}`;
}

/**
 * İşletim sistemi bağlantıyı argv ile (Windows/Linux) iletir. Yalnızca şema ile
 * başlayan TEK bir değer alınır; birden fazla ya da hiç yoksa `undefined`.
 * Diğer argümanlar hiçbir şekilde yorumlanmaz.
 */
export function extractDeepLinkFromArgv(
  argv: readonly unknown[],
  scheme: string = DEEP_LINK_SCHEME
): string | undefined {
  const prefix = `${scheme}://`.toLowerCase();
  const matches = argv.filter(
    (arg): arg is string => typeof arg === 'string' && arg.toLowerCase().startsWith(prefix)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Ana süreçte kimlikler veritabanından çözüldükten sonra arayüze giden hedef. */
export type DeepLinkTarget =
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string }
  | { kind: 'conversation'; projectId: string; taskId: string; conversationId: string }
  | { kind: 'not-found'; route: DeepLinkRoute };
