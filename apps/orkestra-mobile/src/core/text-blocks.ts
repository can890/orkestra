export type TextBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; lang: string; code: string };

/**
 * Ajan yanıtındaki ``` çitli kod bloklarını ayırır (tam markdown değil: telefonda hafif kalması
 * için yalnızca kod bloğu ayrımı yapılır). Kapanmamış çit (akış sürerken) sonuna kadar kod sayılır.
 */
export function splitCodeBlocks(input: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const lines = input.split('\n');
  let buffer: string[] = [];
  let code: { lang: string; lines: string[] } | null = null;

  const flushText = (): void => {
    const text = buffer.join('\n').replace(/^\n+|\n+$/g, '');
    if (text) blocks.push({ type: 'text', text });
    buffer = [];
  };

  for (const line of lines) {
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence && !code) {
      flushText();
      code = { lang: fence[1] ?? '', lines: [] };
    } else if (fence && code) {
      blocks.push({ type: 'code', lang: code.lang, code: code.lines.join('\n') });
      code = null;
    } else if (code) {
      code.lines.push(line);
    } else {
      buffer.push(line);
    }
  }
  if (code) blocks.push({ type: 'code', lang: code.lang, code: code.lines.join('\n') });
  else flushText();
  return blocks;
}
