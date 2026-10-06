import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const SHA256_LINE = /^([0-9a-fA-F]{64})\s+\*?(.+)$/;

/**
 * `shasum -a 256` / `sha256sum` çıktısını (SHA256SUMS) dosya adı → küçük harfli özet eşlemesine
 * çevirir. Boş satırlar ve `#` yorumları atlanır; dosya adının dizin kısmı (`./`, `dist/`) yok
 * sayılır. Aynı dosya adı farklı özetlerle iki kez geçiyorsa dosya belirsizdir ve reddedilir.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = SHA256_LINE.exec(line);
    if (!match) continue;
    const digest = match[1]!.toLowerCase();
    const name = baseName(match[2]!.trim());
    if (!name) continue;
    const existing = sums.get(name);
    if (existing && existing !== digest) {
      throw new Error(`SHA256SUMS dosyasında ${name} için çelişkili özetler var.`);
    }
    sums.set(name, digest);
  }
  return sums;
}

/** SHA256SUMS içinden istenen dosyanın özetini döndürür; yoksa açıklayıcı bir hata fırlatır. */
export function expectedChecksum(sumsText: string, assetName: string): string {
  const digest = parseSha256Sums(sumsText).get(assetName);
  if (!digest) {
    throw new Error(`SHA256SUMS dosyasında ${assetName} için özet bulunamadı.`);
  }
  return digest;
}

/** Dosyanın SHA-256 özetini akış hâlinde (belleğe tamamen yüklemeden) hesaplar. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Özetler eşleşmezse indirilen dosyanın değiştirilmiş ya da bozuk olduğunu bildirir. */
export function assertChecksumMatches(actual: string, expected: string, assetName: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${assetName} dosyasının SHA-256 özeti SHA256SUMS ile eşleşmiyor; dosya bozuk ya da değiştirilmiş olabilir.`
    );
  }
}

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? '';
}
