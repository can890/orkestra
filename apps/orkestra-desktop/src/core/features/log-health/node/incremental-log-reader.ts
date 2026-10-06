import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/**
 * Günlük dosyasını artımlı okur: her çağrıda yalnızca son konumdan sonra eklenen
 * baytları okur, yarım kalan son satırı bir sonraki okumaya saklar ve dosya
 * döndürmesini (rotation: `orkestra.log` → `orkestra.log.1`) inode değişiminden
 * tanır. Döndürülen dosyanın okunmamış kuyruğu kaybolmadan tamamlanır.
 */

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export type LineSink = (lines: string[]) => void;

export type IncrementalLogReaderOptions = {
  /** Tek seferde okunacak bayt; büyük dosyalarda olay döngüsünü kilitlememek için. */
  chunkBytes?: number;
  /** Parçalar arasında olay döngüsüne nefes aldırır. */
  yieldBetweenChunks?: () => Promise<void>;
};

type Position = { ino: number; offset: number };

export class IncrementalLogReader {
  private position: Position | undefined;
  private remainder = '';
  // Ana dosya okumaları arasında yarım kalmış çok baytlı UTF-8 karakterlerini korur.
  private decoder = new StringDecoder('utf8');
  private readonly chunkBytes: number;
  private readonly yieldBetweenChunks: () => Promise<void>;

  constructor(
    private readonly path: string,
    options: IncrementalLogReaderOptions = {}
  ) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.yieldBetweenChunks =
      options.yieldBetweenChunks ?? (() => new Promise((resolve) => setImmediate(resolve)));
  }

  /**
   * İlk tarama: döndürülmüş eski dosyalar (en eskiden yeniye) ve ana dosyanın en
   * yeni `maxBytes` kadarlık kısmı okunur. Sonraki `readNew` çağrıları ana
   * dosyanın o anki sonundan devam eder. Bütçe aşıldıysa true döner.
   */
  async readInitial(
    maxBytes: number,
    rotatedFiles: number,
    sink: LineSink
  ): Promise<{ truncated: boolean }> {
    const candidates = [
      ...Array.from({ length: rotatedFiles }, (_, index) => `${this.path}.${rotatedFiles - index}`),
      this.path,
    ];
    const sizes = await Promise.all(
      candidates.map(async (file) => (await stat(file).catch(() => undefined))?.size ?? 0)
    );

    // Bütçeyi en yeni dosyadan geriye doğru dağıt.
    let budget = maxBytes;
    const allowances = new Array<number>(candidates.length).fill(0);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const allowance = Math.min(sizes[index] ?? 0, budget);
      allowances[index] = allowance;
      budget -= allowance;
    }
    const truncated = sizes.some((size, index) => size > (allowances[index] ?? 0));

    for (let index = 0; index < candidates.length - 1; index += 1) {
      const allowance = allowances[index] ?? 0;
      const size = sizes[index] ?? 0;
      if (allowance <= 0) continue;
      await this.readRange(candidates[index]!, size - allowance, size, sink, {
        dropLeadingPartial: allowance < size,
        flushTail: true,
      });
    }

    const current = await stat(this.path).catch(() => undefined);
    if (!current) {
      this.position = undefined;
      return { truncated };
    }
    const mainAllowance = Math.min(allowances[candidates.length - 1] ?? 0, current.size);
    const start = current.size - mainAllowance;
    this.remainder = '';
    this.decoder = new StringDecoder('utf8');
    await this.readRange(this.path, start, current.size, sink, {
      dropLeadingPartial: start > 0,
      flushTail: false,
    });
    this.position = { ino: current.ino, offset: current.size };
    return { truncated };
  }

  /** Son okunan konumdan sonra eklenen tam satırları `sink`e iletir. */
  async readNew(sink: LineSink): Promise<void> {
    const current = await stat(this.path).catch(() => undefined);
    if (!current) {
      // Dosya henüz yok veya döndürme sırasında kısa süreliğine kayboldu.
      return;
    }

    const previous = this.position;
    if (previous && previous.ino !== current.ino) {
      await this.drainRotated(previous, sink);
      this.position = { ino: current.ino, offset: 0 };
      this.remainder = '';
      this.decoder = new StringDecoder('utf8');
    } else if (!previous || current.size < previous.offset) {
      // İlk okuma ya da dosya kesildi: baştan başla.
      this.position = { ino: current.ino, offset: 0 };
      this.remainder = '';
      this.decoder = new StringDecoder('utf8');
    }

    const position = this.position!;
    if (current.size === position.offset) return;
    await this.readRange(this.path, position.offset, current.size, sink, {
      dropLeadingPartial: false,
      flushTail: false,
    });
    position.offset = current.size;
  }

  /** Döndürülen eski dosyanın (artık `.1`) okunmamış kuyruğunu tamamlar. */
  private async drainRotated(previous: Position, sink: LineSink): Promise<void> {
    const rotatedPath = `${this.path}.1`;
    const rotated = await stat(rotatedPath).catch(() => undefined);
    if (rotated && rotated.ino === previous.ino && rotated.size > previous.offset) {
      await this.readRange(rotatedPath, previous.offset, rotated.size, sink, {
        dropLeadingPartial: false,
        flushTail: true,
        carry: this.remainder,
      });
    } else if (this.remainder) {
      sink([this.remainder]);
    }
    this.remainder = '';
  }

  private async readRange(
    file: string,
    start: number,
    end: number,
    sink: LineSink,
    options: { dropLeadingPartial: boolean; flushTail: boolean; carry?: string }
  ): Promise<void> {
    const handle = await open(file, 'r').catch(() => undefined);
    if (!handle) return;
    let carry = options.flushTail ? (options.carry ?? '') : this.remainder;
    // Döndürülmüş dosyalar kendi çözücüsünü kullanır; ana dosya örnek çözücüsünü paylaşır.
    const decoder = options.flushTail ? new StringDecoder('utf8') : this.decoder;
    let dropLeading = options.dropLeadingPartial;
    try {
      let offset = start;
      const buffer = Buffer.alloc(Math.min(this.chunkBytes, Math.max(end - start, 1)));
      while (offset < end) {
        const length = Math.min(buffer.length, end - offset);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        // StringDecoder, parça sınırında bölünen çok baytlı karakterleri bir sonraki
        // parçaya taşır; böylece Türkçe karakterler bozulmaz.
        const text = carry + decoder.write(buffer.subarray(0, bytesRead));
        const lines = text.split('\n');
        carry = lines.pop() ?? '';
        if (dropLeading && lines.length > 0) {
          lines.shift();
          dropLeading = false;
        }
        const complete = lines.filter((line) => line.length > 0);
        if (complete.length > 0) sink(complete);
        if (offset < end) await this.yieldBetweenChunks();
      }
    } finally {
      await handle.close().catch(() => undefined);
    }

    if (options.flushTail) {
      carry += decoder.end();
      if (carry && !dropLeading) sink([carry]);
    } else {
      this.remainder = carry;
    }
  }
}
