// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/promptStashStore.ts
//
// Uygulama geneli istem zulası. Kalıcılık mevcut memento sistemiyle yapılır (uygulama
// konusu, mementos.db); böylece zula yeniden başlatmalardan sonra da durur ve tüm
// pencereler aynı listeyi görür.

import {
  addStashEntry,
  PROMPT_STASH_MAX_ENTRIES,
  takeStashEntry,
  type PromptStashEntry,
  type PromptStashState,
} from './prompt-stash-model';

/** Zulanın ihtiyaç duyduğu kalıcılık yüzeyi (MementoHandle bunu karşılar). */
export interface PromptStashPersistence {
  readonly ready: Promise<void>;
  /** MobX gözlemlenebilir okuma: gözlemci bileşenler değişince yeniden çizilir. */
  read(): PromptStashState;
  update(next: (current: PromptStashState) => PromptStashState): void;
  flush(): Promise<void>;
}

export class PromptStashStore {
  constructor(
    private readonly persistence: PromptStashPersistence,
    private readonly max: number = PROMPT_STASH_MAX_ENTRIES
  ) {}

  get ready(): Promise<void> {
    return this.persistence.ready;
  }

  /** En yeni önce. */
  get entries(): readonly PromptStashEntry[] {
    return this.persistence.read().entries;
  }

  /** Girdiyi zulaya ekler; üst sınır nedeniyle çıkarılan eski girdileri döndürür. */
  stash(entry: PromptStashEntry): { evicted: PromptStashEntry[] } {
    let evicted: PromptStashEntry[] = [];
    this.persistence.update((current) => {
      const result = addStashEntry(current, entry, this.max);
      evicted = result.evicted;
      return result.state;
    });
    void this.persistence.flush();
    return { evicted };
  }

  /** Girdiyi zuladan alır (geri yükleme için); yoksa null. */
  take(entryId: string): PromptStashEntry | null {
    let taken: PromptStashEntry | null = null;
    this.persistence.update((current) => {
      const result = takeStashEntry(current, entryId);
      taken = result.entry;
      return result.state;
    });
    if (taken) void this.persistence.flush();
    return taken;
  }

  /** Girdiyi siler; silinen girdiyi döndürür (ekleri temizlemek için). */
  remove(entryId: string): PromptStashEntry | null {
    return this.take(entryId);
  }
}
