// Asistan yanıtındaki Markdown'u sesli okunabilir düz metne çevirir. Kod blokları, tablolar,
// bağlantı adresleri ve biçimlendirme işaretleri okunmaz; uzun yanıtlar cümle sınırında kesilir.

export type SpeechTextOptions = {
  /** Okunacak en fazla karakter. */
  maxChars: number;
  /** Atlanan kod bloğunun yerine okunacak kısa ifade; boş dize hiçbir şey okumaz. */
  codeBlockPlaceholder?: string;
  /** Metin kesildiğinde sona eklenecek ifade. */
  truncationSuffix?: string;
};

const DEFAULT_CODE_PLACEHOLDER = '(kod bloğu atlandı)';
const DEFAULT_TRUNCATION_SUFFIX = '… Yanıtın devamı ekranda.';

export function markdownToSpeechText(markdown: string, options: SpeechTextOptions): string {
  const codePlaceholder = options.codeBlockPlaceholder ?? DEFAULT_CODE_PLACEHOLDER;
  let text = markdown.replace(/\r\n?/g, '\n');

  // Çitli kod blokları (``` ya da ~~~), kapanmamış olanlar dahil.
  text = stripFencedCode(text, codePlaceholder);
  // HTML yorumları ve etiketleri.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<\/?[A-Za-z][^>\n]*>/g, ' ');

  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    // Tablo satırları ve ayraçlar okunmaz.
    if (/^\s*\|.*\|\s*$/.test(line)) continue;
    // Yatay çizgiler.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    // 4 boşluk/sekme girintili kod satırları.
    if (/^( {4}|\t)/.test(line) && line.trim().length > 0) continue;
    const structural = /^\s{0,3}#{1,6}\s+|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(line);
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, '') // başlık işaretleri
      .replace(/^\s*>\s?/, '') // alıntı
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '') // görev listesi
      .replace(/^\s*[-*+]\s+/, '') // madde işaretleri
      .replace(/^\s*(\d+)[.)]\s+/, '$1. '); // numaralı liste
    // Başlık ve madde satırları ayrı cümleler gibi okunur.
    lines.push(structural ? endSentence(line) : line);
  }
  text = lines.join('\n');

  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // görseller: alt metin
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // bağlantılar: yalnızca metin
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // referans bağlantılar
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '') // referans tanımları
    .replace(/<?https?:\/\/[^\s>)]+>?/g, 'bağlantı') // çıplak adresler
    .replace(/`([^`\n]+)`/g, '$1') // satır içi kod
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // kalın
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2') // italik *
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2') // italik _
    .replace(/~~(.+?)~~/g, '$1') // üstü çizili
    .replace(/:[a-z0-9_+-]+:/g, ' '); // :emoji: kısa kodları

  // Boşlukları sadeleştir: paragraflar cümle olarak birleşir.
  text = text
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .replace(/\s*\n\s*/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
    )
    .filter((paragraph) => paragraph.length > 0)
    .map(endSentence)
    .join(' ')
    .trim();

  return truncateAtSentence(
    text,
    options.maxChars,
    options.truncationSuffix ?? DEFAULT_TRUNCATION_SUFFIX
  );
}

/** Çitli blokları satır satır atlar; kapanış çiti açılışla aynı karakterden en az o kadar olmalı. */
function stripFencedCode(text: string, placeholder: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (match) {
        fence = match[1];
        if (placeholder) out.push('', placeholder, '');
        continue;
      }
      out.push(line);
    } else if (
      match &&
      match[1][0] === fence[0] &&
      match[1].length >= fence.length &&
      line.trim() === match[1]
    ) {
      fence = null;
    }
  }
  return out.join('\n');
}

function endSentence(value: string): string {
  const trimmed = value.trimEnd();
  if (trimmed.length === 0 || /[.!?…:;,]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

function truncateAtSentence(text: string, maxChars: number, suffix: string): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - suffix.length);
  const slice = text.slice(0, budget);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('… ')
  );
  // Cümle sınırı çok erkense kelime sınırında kes.
  const cut =
    sentenceEnd >= budget * 0.5 ? sentenceEnd + 1 : Math.max(slice.lastIndexOf(' '), 0) || budget;
  return `${slice.slice(0, cut).trimEnd()}${suffix}`.slice(0, maxChars);
}
