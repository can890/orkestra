import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IncrementalLogReader } from './incremental-log-reader';

const tempDirs: string[] = [];
const noYield = () => Promise.resolve();

async function tempLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orkestra-log-health-'));
  tempDirs.push(dir);
  return join(dir, 'orkestra.log');
}

function collector() {
  const lines: string[] = [];
  return { lines, sink: (batch: string[]) => lines.push(...batch) };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('IncrementalLogReader', () => {
  it('ilk taramadan sonra yalnızca yeni eklenen satırları okur', async () => {
    const path = await tempLog();
    await writeFile(path, 'a\nb\n');
    const reader = new IncrementalLogReader(path, { yieldBetweenChunks: noYield });
    const initial = collector();
    await reader.readInitial(1024, 0, initial.sink);
    expect(initial.lines).toEqual(['a', 'b']);

    await appendFile(path, 'c\n');
    const next = collector();
    await reader.readNew(next.sink);
    expect(next.lines).toEqual(['c']);

    const idle = collector();
    await reader.readNew(idle.sink);
    expect(idle.lines).toEqual([]);
  });

  it('yarım satırı tamamlanana kadar bekletir', async () => {
    const path = await tempLog();
    await writeFile(path, '');
    const reader = new IncrementalLogReader(path, { yieldBetweenChunks: noYield });
    await reader.readInitial(1024, 0, () => {});
    await appendFile(path, '{"level":"wa');
    const first = collector();
    await reader.readNew(first.sink);
    expect(first.lines).toEqual([]);
    await appendFile(path, 'rn"}\n');
    const second = collector();
    await reader.readNew(second.sink);
    expect(second.lines).toEqual(['{"level":"warn"}']);
  });

  it('parça sınırında bölünen çok baytlı karakterleri bozmaz', async () => {
    const path = await tempLog();
    await writeFile(path, 'şğüöçİ ılık\nikinci\n');
    const reader = new IncrementalLogReader(path, { chunkBytes: 3, yieldBetweenChunks: noYield });
    const out = collector();
    await reader.readInitial(1024, 0, out.sink);
    expect(out.lines).toEqual(['şğüöçİ ılık', 'ikinci']);
  });

  it('ilk taramada bayt bütçesini aşan baştaki yarım satırı atar', async () => {
    const path = await tempLog();
    await writeFile(path, 'first line\nsecond line\nthird line\n');
    const reader = new IncrementalLogReader(path, { yieldBetweenChunks: noYield });
    const out = collector();
    const result = await reader.readInitial(15, 0, out.sink);
    expect(result.truncated).toBe(true);
    expect(out.lines).toEqual(['third line']);
  });

  it('döndürülmüş dosyaları en eskiden yeniye okur', async () => {
    const path = await tempLog();
    await writeFile(`${path}.2`, 'old-2\n');
    await writeFile(`${path}.1`, 'old-1\n');
    await writeFile(path, 'current\n');
    const reader = new IncrementalLogReader(path, { yieldBetweenChunks: noYield });
    const out = collector();
    await reader.readInitial(1024, 5, out.sink);
    expect(out.lines).toEqual(['old-2', 'old-1', 'current']);
  });

  it('döndürmede eski dosyanın okunmamış kuyruğunu kaybetmez', async () => {
    const path = await tempLog();
    await writeFile(path, 'a\n');
    const reader = new IncrementalLogReader(path, { yieldBetweenChunks: noYield });
    await reader.readInitial(1024, 0, () => {});

    // Taşıyıcının yaptığı gibi: eski dosyaya yazılır, sonra .1 olarak taşınır.
    await appendFile(path, 'b\nc-par');
    const partial = collector();
    await reader.readNew(partial.sink);
    expect(partial.lines).toEqual(['b']);
    await appendFile(path, 'tial\n');
    await rename(path, `${path}.1`);
    await writeFile(path, 'd\n');

    const out = collector();
    await reader.readNew(out.sink);
    expect(out.lines).toEqual(['c-partial', 'd']);
  });

  it('kesilen dosyayı baştan okur', async () => {
    const path = await tempLog();
    await writeFile(path, 'long line one\nlong line two\n');
    const reader = new IncrementalLogReader(path, { yieldBetweenChunks: noYield });
    await reader.readInitial(1024, 0, () => {});
    await writeFile(path, 'x\n');
    const out = collector();
    await reader.readNew(out.sink);
    expect(out.lines).toEqual(['x']);
  });
});
