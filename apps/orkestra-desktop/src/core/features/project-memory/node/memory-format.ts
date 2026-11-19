/** Kayıt dosyası biçimi: `description` ön yazısı + markdown gövdesi. Saf; dosya sistemine dokunmaz. */

const FRONT_START = '---\n';

export function serializeMemoryFile(description: string, content: string): string {
  return `${FRONT_START}description: ${description}\n---\n${content}`;
}

export function parseMemoryFile(raw: string): { description: string; content: string } {
  if (raw.startsWith(FRONT_START)) {
    const end = raw.indexOf('\n---\n', FRONT_START.length - 1);
    if (end >= 0) {
      const header = raw.slice(FRONT_START.length, end);
      const match = /^description:[ \t]*(.*)$/m.exec(header);
      return {
        description: (match?.[1] ?? '').trim(),
        content: raw.slice(end + '\n---\n'.length),
      };
    }
  }
  return { description: '', content: raw };
}

/** `MEMORY.md` dizin dosyası; her satır `- [ad](ad.md) — açıklama`. */
export function renderMemoryIndex(
  entries: readonly { name: string; description: string }[]
): string {
  const lines = entries.map(
    (entry) => `- [${entry.name}](${entry.name}.md) — ${entry.description || '(no description)'}`
  );
  return `# Project memory\n\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}
