/**
 * Harici bağımlılık olmadan `.docx`, `.xlsx` ve `.pptx` OpenXML ZIP arşivlerini
 * çözümleyen hafif tarayıcı/Node uyumlu önizleme ayrıştırıcısı.
 */

export const MAX_OFFICE_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_OFFICE_ENTRIES = 2048;
export const MAX_OFFICE_ENTRY_BYTES = 12 * 1024 * 1024;
export const MAX_XLSX_PREVIEW_ROWS = 500;
export const MAX_XLSX_PREVIEW_COLS = 50;

export type DocxPreview = {
  kind: 'docx';
  paragraphs: string[];
  tables: string[][][];
};

export type XlsxSheetPreview = {
  name: string;
  rows: string[][];
  truncatedRows: boolean;
};

export type XlsxPreview = {
  kind: 'xlsx';
  sheets: XlsxSheetPreview[];
};

export type PptxSlidePreview = {
  index: number;
  title: string;
  texts: string[];
};

export type PptxPreview = {
  kind: 'pptx';
  slides: PptxSlidePreview[];
};

export type OfficePreviewDocument = DocxPreview | XlsxPreview | PptxPreview;

type ZipCentralEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&');
}

function stripTagsAndCollectText(xmlFragment: string): string {
  return decodeXmlEntities(xmlFragment.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseZipDirectory(bytes: Uint8Array): Map<string, ZipCentralEntry> {
  if (bytes.byteLength > MAX_OFFICE_ARCHIVE_BYTES) {
    throw new Error('Office dosyası önizleme sınırını (25 MB) aşıyor.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of Central Directory (0x06054b50) sondan ara
  const minOffset = Math.max(0, bytes.byteLength - 65558);
  let eocdOffset = -1;
  for (let i = bytes.byteLength - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Geçerli bir Office (ZIP) arşivi bulunamadı.');
  }
  const entryCount = view.getUint16(eocdOffset + 10, true);
  if (entryCount > MAX_OFFICE_ENTRIES) {
    throw new Error(`Arşiv ${MAX_OFFICE_ENTRIES} girdi sınırını aşıyor.`);
  }
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map<string, ZipCentralEntry>();
  let cursor = cdOffset;

  for (let i = 0; i < entryCount && cursor + 46 <= bytes.byteLength; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLen);
    const name = decoder.decode(nameBytes);
    entries.set(name, {
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntryText(
  bytes: Uint8Array,
  entries: Map<string, ZipCentralEntry>,
  name: string
): Promise<string | null> {
  const entry = entries.get(name);
  if (!entry) return null;
  if (entry.uncompressedSize > MAX_OFFICE_ENTRY_BYTES) {
    throw new Error(`${name} girdisi güvenlik sınırını aşıyor.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = entry.localHeaderOffset;
  if (off + 30 > bytes.byteLength || view.getUint32(off, true) !== 0x04034b50) {
    throw new Error(`${name} için yerel ZIP başlığı bozuk.`);
  }
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const dataStart = off + 30 + nameLen + extraLen;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  let inflated: Uint8Array;
  if (entry.compressionMethod === 0) {
    inflated = compressed;
  } else if (entry.compressionMethod === 8) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const copy = new Uint8Array(new ArrayBuffer(compressed.byteLength));
    copy.set(compressed);
    await writer.write(copy);
    await writer.close();
    const ab = await new Response(ds.readable).arrayBuffer();
    inflated = new Uint8Array(ab);
  } else {
    throw new Error(`Desteklenmeyen ZIP sıkıştırma yöntemi: ${entry.compressionMethod}`);
  }
  return new TextDecoder('utf-8').decode(inflated);
}

function parseDocxXml(xml: string): DocxPreview {
  const paragraphs: string[] = [];
  const tables: string[][][] = [];

  for (const tblMatch of xml.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g)) {
    const rows: string[][] = [];
    for (const rowMatch of tblMatch[1]!.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[1]!.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
        const cellTexts = [...cellMatch[1]!.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) =>
          decodeXmlEntities(m[1]!)
        );
        cells.push(cellTexts.join('').trim());
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }

  const withoutTables = xml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, ' ');
  for (const pMatch of withoutTables.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const runs = [...pMatch[1]!.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) =>
      decodeXmlEntities(m[1]!)
    );
    const line = runs.join('').trim();
    if (line) paragraphs.push(line);
  }

  return { kind: 'docx', paragraphs, tables };
}

function columnLettersToIndex(ref: string): number {
  const match = /^([A-Za-z]+)/.exec(ref);
  if (!match) return -1;
  let col = 0;
  for (const ch of match[1]!.toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return col - 1;
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const siMatch of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...siMatch[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) =>
      decodeXmlEntities(m[1]!)
    );
    strings.push(parts.join(''));
  }
  return strings;
}

function parseSheetNames(workbookXml: string | null, count: number): string[] {
  if (!workbookXml) {
    return Array.from({ length: count }, (_, idx) => `Sayfa ${idx + 1}`);
  }
  const names: string[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\/?>/g)) {
    names.push(decodeXmlEntities(match[1]!));
  }
  return names;
}

function parseWorksheetXml(
  xml: string,
  sharedStrings: string[]
): XlsxSheetPreview['rows'] extends infer _ ? { rows: string[][]; truncatedRows: boolean } : never {
  const rows: string[][] = [];
  let truncatedRows = false;

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_XLSX_PREVIEW_ROWS) {
      truncatedRows = true;
      break;
    }
    const rowCells: string[] = [];
    for (const cellMatch of rowMatch[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1]!;
      const body = cellMatch[2]!;
      const refMatch = /\br="([^"]+)"/.exec(attrs);
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const colIdx = refMatch ? columnLettersToIndex(refMatch[1]!) : rowCells.length;
      if (colIdx < 0 || colIdx >= MAX_XLSX_PREVIEW_COLS) continue;

      let value = '';
      const type = typeMatch?.[1];
      if (type === 'inlineStr') {
        value = stripTagsAndCollectText(body);
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const raw = vMatch ? decodeXmlEntities(vMatch[1]!) : '';
        if (type === 's') {
          const idx = Number.parseInt(raw, 10);
          value =
            Number.isFinite(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx]! : raw;
        } else if (type === 'b') {
          value = raw === '1' ? 'DOĞRU' : 'YANLIŞ';
        } else {
          value = raw;
        }
      }
      while (rowCells.length <= colIdx) rowCells.push('');
      rowCells[colIdx] = value;
    }
    if (rowCells.some((cell) => cell !== '')) {
      rows.push(rowCells);
    }
  }
  return { rows, truncatedRows };
}

function parseSlideXml(xml: string, index: number): PptxSlidePreview {
  const texts: string[] = [];
  for (const pMatch of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const runs = [...pMatch[1]!.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) =>
      decodeXmlEntities(m[1]!)
    );
    const text = runs.join('').trim();
    if (text) texts.push(text);
  }
  return {
    index,
    title: texts[0] ?? `Slayt ${index}`,
    texts: texts.slice(1),
  };
}

export async function parseOfficeDocument(
  filePath: string,
  bytes: Uint8Array
): Promise<OfficePreviewDocument> {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const entries = parseZipDirectory(bytes);

  if (ext === 'docx') {
    const xml = await readZipEntryText(bytes, entries, 'word/document.xml');
    if (!xml) throw new Error('Word belgesi (word/document.xml) bulunamadı.');
    return parseDocxXml(xml);
  }

  if (ext === 'xlsx') {
    const [workbookXml, sharedStringsXml] = await Promise.all([
      readZipEntryText(bytes, entries, 'xl/workbook.xml'),
      readZipEntryText(bytes, entries, 'xl/sharedStrings.xml'),
    ]);
    const sharedStrings = parseSharedStrings(sharedStringsXml);
    const sheetPaths = [...entries.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (sheetPaths.length === 0) {
      throw new Error('Çalışma sayfası XML dosyası bulunamadı.');
    }
    const sheetNames = parseSheetNames(workbookXml, sheetPaths.length);
    const sheets: XlsxSheetPreview[] = [];
    for (let i = 0; i < sheetPaths.length; i++) {
      const sheetXml = await readZipEntryText(bytes, entries, sheetPaths[i]!);
      if (!sheetXml) continue;
      const parsed = parseWorksheetXml(sheetXml, sharedStrings);
      sheets.push({
        name: sheetNames[i] ?? `Sayfa ${i + 1}`,
        rows: parsed.rows,
        truncatedRows: parsed.truncatedRows,
      });
    }
    return { kind: 'xlsx', sheets };
  }

  if (ext === 'pptx') {
    const slidePaths = [...entries.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (slidePaths.length === 0) {
      throw new Error('Sunum slaytı (ppt/slides/slide*.xml) bulunamadı.');
    }
    const slides: PptxSlidePreview[] = [];
    for (let i = 0; i < slidePaths.length; i++) {
      const slideXml = await readZipEntryText(bytes, entries, slidePaths[i]!);
      if (slideXml) slides.push(parseSlideXml(slideXml, i + 1));
    }
    return { kind: 'pptx', slides };
  }

  throw new Error(`Desteklenmeyen Office uzantısı: .${ext}`);
}
