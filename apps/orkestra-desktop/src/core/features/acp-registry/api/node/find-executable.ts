// Kullanıcı ACP ajanlarının çalıştırılabilir dosyasını bulur (mutlak yol veya PATH adı).
import { stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** PATH üzerinde bir komutu arar (mutlak yolsa varlığını denetler). */
export async function findExecutable(
  command: string,
  env: Record<string, string | undefined> = process.env
): Promise<string | undefined> {
  if (isAbsolute(command)) return (await exists(command)) ? command : undefined;
  if (command.includes('/') || command.includes('\\')) return undefined;
  const pathValue = env.PATH ?? env.Path ?? '';
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}
