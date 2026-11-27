import { mapTurn, turnId, turnSeq, type HistoryPageView, type TranscriptEntry } from './mappers';

/**
 * Sohbet dökümü: geçmiş sayfalarından (`loadHistory`) gelen işlenmiş turlar + canlı etkin tur.
 * Saf veri yapısıdır (ağ yok). Turlar `id` ile tekilleştirilir; `generation` değişirse (masaüstü
 * dökümü yeniden kurdu) eski turlar atılır.
 */
export class TranscriptStore {
  private turns = new Map<string, unknown>();
  private generation: string | null = null;
  private cursor: number | null | undefined;
  private active: unknown = null;
  /** Etkin tur bittiğinde yeni `loadHistory` dönene kadar eski etkin turu tutarak flicker'ı önler. */
  private retainedActive: unknown = null;

  /**
   * @param updateCursor `true`: bu sayfanın `nextCursor`'ı "daha eski" imlecidir (ilk yükleme ya
   *   da eskiye doğru sayfalama). En yeni sayfayı tazelerken `false` verilir.
   * @returns dökümün sıfırlanıp sıfırlanmadığı
   */
  applyPage(page: HistoryPageView, updateCursor: boolean): boolean {
    let reset = false;
    if (
      page.generation !== null &&
      this.generation !== null &&
      page.generation !== this.generation
    ) {
      this.turns.clear();
      this.cursor = undefined;
      reset = true;
    }
    if (page.generation !== null) this.generation = page.generation;
    for (const turn of page.turns) {
      const id = turnId(turn);
      if (id) this.turns.set(id, turn);
    }
    if (updateCursor || reset) this.cursor = page.nextCursor;
    this.retainedActive = null;
    return reset;
  }

  setActiveTurn(turn: unknown, options?: { retainUntilPage?: boolean }): void {
    if (turn !== null && turn !== undefined) {
      this.active = turn;
      this.retainedActive = null;
      return;
    }
    if (options?.retainUntilPage && this.active !== null && this.active !== undefined) {
      this.retainedActive = this.active;
    } else if (!options?.retainUntilPage) {
      this.retainedActive = null;
    }
    this.active = null;
  }

  /** Daha eski sayfa varsa `before` imleci; yoksa `null`; henüz yüklenmediyse `undefined`. */
  get olderCursor(): number | null | undefined {
    return this.cursor;
  }

  get hasOlder(): boolean {
    return typeof this.cursor === 'number';
  }

  get loaded(): boolean {
    return this.cursor !== undefined;
  }

  get currentGeneration(): string | null {
    return this.generation;
  }

  entries(): TranscriptEntry[] {
    const ordered = [...this.turns.values()].sort((a, b) => turnSeq(a) - turnSeq(b));
    const liveTurn = this.active ?? this.retainedActive;
    const liveId = turnId(liveTurn);
    const entries = ordered.flatMap(mapTurn);
    // Etkin tur tamamlanıp geçmişe girdiyse yinelenmesin (geçmiş sürümü kazanır).
    if (liveTurn && !this.turns.has(liveId)) entries.push(...mapTurn(liveTurn));
    return entries;
  }
}
