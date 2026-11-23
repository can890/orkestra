import { describe, expect, it } from 'vitest';
import { parseOfficeDocument } from './office-preview-parser';

async function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.byteLength;
  }
  return result;
}

async function buildZip(
  entries: Array<{ name: string; content: string; deflate?: boolean }>
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const rawBytes = encoder.encode(entry.content);
    const method = entry.deflate ? 8 : 0;
    const dataBytes = entry.deflate ? await deflateRaw(rawBytes) : rawBytes;

    const local = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, 0, true);
    localView.setUint32(18, dataBytes.byteLength, true);
    localView.setUint32(22, rawBytes.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, 0, true);
    centralView.setUint32(20, dataBytes.byteLength, true);
    centralView.setUint32(24, rawBytes.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localParts.push(local, dataBytes);
    centralParts.push(central);
    offset += local.byteLength + dataBytes.byteLength;
  }

  const centralSize = centralParts.reduce((s, b) => s + b.byteLength, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, 0, true);

  return concatBytes([...localParts, ...centralParts, eocd]);
}

describe('office-preview-parser', () => {
  it('parses compressed docx paragraphs and tables', async () => {
    const zip = await buildZip([
      {
        name: 'word/document.xml',
        deflate: true,
        content: `<w:document><w:body>
          <w:p><w:r><w:t>Merhaba Dünya &amp; Test</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Hücre 1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>`,
      },
    ]);
    const parsed = await parseOfficeDocument('rapor.docx', zip);
    expect(parsed).toEqual({
      kind: 'docx',
      paragraphs: ['Merhaba Dünya & Test'],
      tables: [[['Hücre 1']]],
    });
  });

  it('parses xlsx workbook sheets and shared strings', async () => {
    const zip = await buildZip([
      {
        name: 'xl/workbook.xml',
        deflate: true,
        content: `<workbook><sheets><sheet name="Gelirler" sheetId="1"/></sheets></workbook>`,
      },
      {
        name: 'xl/sharedStrings.xml',
        deflate: true,
        content: `<sst><si><t>Ay</t></si><si><t>Ocak</t></si></sst>`,
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        deflate: true,
        content: `<worksheet><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Tutar</t></is></c></row>
          <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>4200</v></c></row>
        </sheetData></worksheet>`,
      },
    ]);
    const parsed = await parseOfficeDocument('tablo.xlsx', zip);
    expect(parsed).toEqual({
      kind: 'xlsx',
      sheets: [
        {
          name: 'Gelirler',
          truncatedRows: false,
          rows: [
            ['Ay', 'Tutar'],
            ['Ocak', '4200'],
          ],
        },
      ],
    });
  });

  it('parses pptx slides in numeric order', async () => {
    const zip = await buildZip([
      {
        name: 'ppt/slides/slide1.xml',
        deflate: true,
        content: `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Giriş</a:t></a:r></a:p><a:p><a:r><a:t>Madde 1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      },
    ]);
    const parsed = await parseOfficeDocument('sunum.pptx', zip);
    expect(parsed).toEqual({
      kind: 'pptx',
      slides: [{ index: 1, title: 'Giriş', texts: ['Madde 1'] }],
    });
  });
});
