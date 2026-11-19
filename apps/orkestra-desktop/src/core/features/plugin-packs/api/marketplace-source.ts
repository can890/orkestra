import { err, ok, type Result } from '@orkestra/shared';

export type MarketplaceSource = Readonly<{
  /** Normalize edilmiş, her zaman `https://` ile başlayan clone adresi. */
  url: string;
  /** Kullanıcıya gösterilen kısa ad (`owner/repo` ya da `host/yol`). */
  label: string;
}>;

const OWNER_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const URL_PATH_CHARS = /^[A-Za-z0-9._~\-/%]+$/;

/**
 * Marketplace kaynağını doğrular. Yalnızca `https://` git URL'si ya da GitHub `owner/repo`
 * kabul edilir; `file://`, `ssh://`, `git://`, yerel yol, `-` ile başlayan değer (argüman
 * enjeksiyonu), kullanıcı bilgisi içeren URL ve boşluk/kontrol karakteri reddedilir.
 */
export function parseMarketplaceSource(input: string): Result<MarketplaceSource, string> {
  const value = input.trim();
  if (!value) return err('Kaynak boş olamaz.');
  if (value.length > 300) return err('Kaynak çok uzun.');
  if (value.startsWith('-')) return err('Kaynak "-" ile başlayamaz.');
  if (hasUnsafeChar(value)) return err('Kaynak boşluk veya özel karakter içeremez.');

  const shorthand = OWNER_REPO.exec(value);
  if (shorthand) {
    const [, owner, repoRaw] = shorthand;
    const repo = repoRaw.replace(/\.git$/, '');
    if (!repo || repo === '.' || repo === '..' || repo.startsWith('.')) {
      return err('Geçersiz depo adı.');
    }
    return ok({ url: `https://github.com/${owner}/${repo}.git`, label: `${owner}/${repo}` });
  }

  if (!/^https:\/\//i.test(value)) {
    return err('Yalnızca https:// git URL\'si ya da owner/repo biçimi kabul edilir.');
  }
  // URL ayrıştırıcısı `..` parçalarını sessizce siler; ham değerde reddet.
  if (value.split('/').some((segment) => segment === '..' || segment === '.')) {
    return err('URL yolu geçersiz.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return err('Geçersiz URL.');
  }
  if (parsed.protocol !== 'https:') return err('Yalnızca https:// kabul edilir.');
  if (parsed.username || parsed.password) return err('URL kullanıcı bilgisi içeremez.');
  if (parsed.search || parsed.hash) return err('URL sorgu ya da parça içeremez.');
  if (!HOST.test(parsed.hostname)) return err('Geçersiz ana makine adı.');
  const path = parsed.pathname.replace(/\/+$/, '');
  if (!path || path === '/') return err('URL bir depo yolu içermelidir.');
  if (!URL_PATH_CHARS.test(path)) return err('URL yolu geçersiz karakter içeriyor.');
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) {
    return err('URL yolu geçersiz.');
  }
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? `:${parsed.port}` : '';
  return ok({
    url: `https://${host}${port}${path}`,
    label: `${host}${port}${path}`.replace(/\.git$/, ''),
  });
}

function hasUnsafeChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || char === '\\') return true;
  }
  return false;
}
