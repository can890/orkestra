/**
 * Sohbet çıktıları için hafif, sıfır bağımlılıklı ve XSS-güvenli Markdown ayrıştırıcısı.
 * Başlık, paragraf, kod bloğu, liste (sıralı/sırasız), alıntı, tablo, ayırıcı ve satır içi
 * biçimlendirmeleri (kalın, italik, üstü çizili, satır içi kod, güvenli http/https bağlantılar)
 * yapısal düğümlere çevirir.
 */

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; code: string }
  | { kind: 'bold'; children: InlineToken[] }
  | { kind: 'italic'; children: InlineToken[] }
  | { kind: 'strike'; children: InlineToken[] }
  | { kind: 'link'; label: string; href: string };

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; tokens: InlineToken[] }
  | { kind: 'paragraph'; tokens: InlineToken[] }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: 'blockquote'; lines: InlineToken[][] }
  | { kind: 'table'; headers: InlineToken[][]; rows: InlineToken[][][] }
  | { kind: 'hr' };

/** Liste maddesi: satır içi metin, isteğe bağlı görev kutusu ve iç içe bloklar (alt listeler). */
export type MarkdownListItem = {
  tokens: InlineToken[];
  /** GFM görev listesi: `- [ ]` → false, `- [x]` → true; görev değilse yok. */
  checked?: boolean;
  children: MarkdownBlock[];
};

const LIST_MARKER_RE = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;

type ListMarkerMatch = { indent: number; ordered: boolean; number: number; content: string };

function matchListMarker(line: string): ListMarkerMatch | null {
  const m = LIST_MARKER_RE.exec(line);
  if (!m) return null;
  const marker = m[2]!;
  const ordered = /\d/.test(marker);
  return {
    indent: m[1]!.replace(/\t/g, '    ').length,
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : 0,
    content: m[3]!,
  };
}

function leadingIndent(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
}

/**
 * `lines[start]` ile başlayan listeyi ayrıştırır. Boş satırla ayrılmış maddeler aynı listede
 * kalır (numara sıfırlanmaz); daha içeriden girintili satırlar (alt liste, devam paragrafı)
 * maddenin `children` bloklarına özyinelemeli ayrıştırılır.
 */
function parseList(lines: string[], start: number): { block: MarkdownBlock; next: number } {
  const first = matchListMarker(lines[start]!)!;
  const baseIndent = first.indent;
  const items: MarkdownListItem[] = [];
  let i = start;
  let nested: string[] = [];

  const flushNested = (): void => {
    const item = items[items.length - 1];
    if (item && nested.some((l) => l.trim() !== '')) {
      const minIndent = Math.min(
        ...nested.filter((l) => l.trim() !== '').map((l) => leadingIndent(l))
      );
      const dedented = nested.map((l) => l.replace(/\t/g, '    ').slice(minIndent));
      item.children.push(...parseMarkdown(dedented.join('\n')));
    }
    nested = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      // Boş satırdan sonra liste devam ediyor mu? Sonraki dolu satıra bak.
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === '') j += 1;
      if (j >= lines.length) break;
      const peek = matchListMarker(lines[j]!);
      const continuesItem = leadingIndent(lines[j]!) >= baseIndent + 2;
      const sameList = peek && peek.indent < baseIndent + 2 && peek.ordered === first.ordered;
      if (!continuesItem && !sameList) break;
      if (continuesItem) nested.push('');
      i = j;
      continue;
    }
    const marker = matchListMarker(line);
    if (marker && marker.indent < baseIndent + 2) {
      if (marker.ordered !== first.ordered) break; // farklı tür liste yeni bir blok başlatır
      flushNested();
      const task = /^\[([ xX])\]\s+(.*)$/.exec(marker.content);
      items.push(
        task
          ? { tokens: parseInline(task[2]!), checked: task[1] !== ' ', children: [] }
          : { tokens: parseInline(marker.content), children: [] }
      );
      i += 1;
      continue;
    }
    if (leadingIndent(line) >= baseIndent + 2) {
      nested.push(line);
      i += 1;
      continue;
    }
    break;
  }
  flushNested();
  return {
    block: { kind: 'list', ordered: first.ordered, start: first.ordered ? first.number : 1, items },
    next: i,
  };
}

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    return null;
  } catch {
    return null;
  }
}

export function parseInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;

  const pushText = (chunk: string): void => {
    if (!chunk) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === 'text') prev.text += chunk;
    else tokens.push({ kind: 'text', text: chunk });
  };

  while (cursor < input.length) {
    const rest = input.slice(cursor);

    // Satır içi kod: `...`
    if (rest.startsWith('`')) {
      const end = input.indexOf('`', cursor + 1);
      if (end > cursor + 1) {
        tokens.push({ kind: 'code', code: input.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }

    // Bağlantı: [etiket](url)
    if (rest.startsWith('[')) {
      const match = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      if (match) {
        const href = safeHref(match[2]!);
        if (href) {
          tokens.push({ kind: 'link', label: match[1]!, href });
          cursor += match[0].length;
          continue;
        }
      }
    }

    // Kalın: **...** veya __...__
    if (rest.startsWith('**') || rest.startsWith('__')) {
      const delim = rest.slice(0, 2);
      const end = input.indexOf(delim, cursor + 2);
      if (end > cursor + 2) {
        tokens.push({ kind: 'bold', children: parseInline(input.slice(cursor + 2, end)) });
        cursor = end + 2;
        continue;
      }
    }

    // Üstü çizili: ~~...~~
    if (rest.startsWith('~~')) {
      const end = input.indexOf('~~', cursor + 2);
      if (end > cursor + 2) {
        tokens.push({ kind: 'strike', children: parseInline(input.slice(cursor + 2, end)) });
        cursor = end + 2;
        continue;
      }
    }

    // İtalik: *...* (tek yıldız; boşlukla başlamamalı)
    if (rest.startsWith('*') && !rest.startsWith('**') && rest.length > 2 && rest[1] !== ' ') {
      const end = input.indexOf('*', cursor + 1);
      if (end > cursor + 1 && input[end - 1] !== ' ') {
        tokens.push({ kind: 'italic', children: parseInline(input.slice(cursor + 1, end)) });
        cursor = end + 1;
        continue;
      }
    }

    pushText(input[cursor]!);
    cursor += 1;
  }

  return tokens;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  return /^\|?[\s:-]+(\|[\s:-]+)+\|?$/.test(trimmed);
}

export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '') {
      i += 1;
      continue;
    }

    // Kod bloğu: ```lang
    const fence = /^```([^\s`]*)/.exec(trimmed);
    if (fence) {
      const language = fence[1] ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // kapanış ```
      blocks.push({ kind: 'code', language, code: codeLines.join('\n') });
      continue;
    }

    // Yatay ayırıcı: ---, ***, ___
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // Başlık: # .. ####
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4;
      blocks.push({ kind: 'heading', level, tokens: parseInline(heading[2]!.trim()) });
      i += 1;
      continue;
    }

    // Tablo: header | header \n --- | ---
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headers = splitTableRow(line).map((cell) => parseInline(cell));
      const rows: InlineToken[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) {
        rows.push(splitTableRow(lines[i]!).map((cell) => parseInline(cell)));
        i += 1;
      }
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    // Alıntı: > ...
    if (trimmed.startsWith('>')) {
      const quoteLines: InlineToken[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(parseInline(lines[i]!.trim().replace(/^>\s?/, '')));
        i += 1;
      }
      blocks.push({ kind: 'blockquote', lines: quoteLines });
      continue;
    }

    // Liste: - / * / + / • (sırasız) veya 1. / 1) (sıralı; başlangıç numarası korunur)
    if (matchListMarker(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    // Paragraf (özel blok başlayana ya da boş satıra kadar birleştir)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const current = lines[i]!;
      const t = current.trim();
      if (
        t === '' ||
        t.startsWith('```') ||
        /^#{1,4}\s+/.test(t) ||
        /^([-*_])\1{2,}$/.test(t) ||
        t.startsWith('>') ||
        matchListMarker(current) !== null ||
        (current.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
      ) {
        break;
      }
      paraLines.push(current);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', tokens: parseInline(paraLines.join('\n')) });
  }

  return blocks;
}
