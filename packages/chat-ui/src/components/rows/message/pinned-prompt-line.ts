// Sabitlenmiş istek hapında gösterilecek tek satırlık metin (DOM bağımlılığı yok, test edilebilir).

/** İsteğin ilk anlamlı satırı; Markdown işaretleri ve fazla boşluk atılır. */
export function pinnedPromptLine(text: string): string {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  return firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
