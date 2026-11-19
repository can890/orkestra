import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Uzantı paketinin bütünlüğü: manifest'in atıf yaptığı her dosya var, sayfa betiklerinin
// kullandığı her öğe kimliği HTML'de tanımlı, yasak izin yok.

const EXTENSION_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../chrome-extension'
);
const read = (name: string) => readFileSync(join(EXTENSION_DIR, name), 'utf8');
const manifest = JSON.parse(read('manifest.json')) as {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  icons?: Record<string, string>;
  background?: { service_worker?: string };
  action?: { default_popup?: string; default_icon?: Record<string, string> };
  options_page?: string;
};

describe('Chrome uzantısı bütünlüğü', () => {
  it('manifest atıf yaptığı tüm dosyalar mevcut', () => {
    const files = [
      manifest.background?.service_worker,
      manifest.action?.default_popup,
      manifest.options_page,
      ...Object.values(manifest.icons ?? {}),
      ...Object.values(manifest.action?.default_icon ?? {}),
    ];
    expect(files.filter(Boolean).length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      expect(file, 'manifest dosya yolu eksik').toBeTruthy();
      expect(existsSync(join(EXTENSION_DIR, file as string)), `${file} bulunamadı`).toBe(true);
    }
    for (const size of ['16', '32', '48', '128']) expect(manifest.icons?.[size]).toBeTruthy();
  });

  it.each([
    ['popup.js', 'popup.html'],
    ['options.js', 'options.html'],
  ])('%s kullandığı her öğe kimliği %s içinde tanımlı', (script, page) => {
    const source = read(script);
    const ids = new Set<string>();
    for (const match of source.matchAll(/(?:getElementById|\$)\(\s*['"]([\w-]+)['"]\s*\)/g)) {
      ids.add(match[1]!);
    }
    expect(ids.size).toBeGreaterThan(0);
    const html = read(page);
    for (const id of ids) {
      expect(html, `${page} içinde id="${id}" yok`).toMatch(new RegExp(`id=["']${id}["']`));
    }
    // MV3 CSP: satır içi betik yok, yalnızca modül betiği.
    expect(html).toContain(`<script type="module" src="${script}"></script>`);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it('yasak izinleri içermez ve ana makine izinleri yalnızca isteğe bağlıdır', () => {
    const forbidden = ['cookies', 'history', 'downloads', 'debugger', 'tabs', 'webRequest'];
    const all = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
    for (const name of forbidden) expect(all).not.toContain(name);
    expect(manifest.host_permissions ?? []).toEqual([]);
  });
});
