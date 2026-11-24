// İçe aktarma girişi: dosya metnini (JSON/JSONC) okur; Orkestra tema dosyası mı yoksa VS Code
// teması mı olduğunu anlayıp uygun ayrıştırıcıya yönlendirir.

import { parseThemeFile, type CustomTheme } from './custom-theme';
import { isVsCodeThemeFile, parseJsonc, parseVsCodeTheme } from './vscode-theme';

export function parseThemeImport(
  source: string,
  taken: ReadonlySet<string> = new Set()
): CustomTheme {
  const value = parseJsonc(source);
  return isVsCodeThemeFile(value) ? parseVsCodeTheme(value, taken) : parseThemeFile(value, taken);
}
