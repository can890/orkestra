/**
 * "Ajanlar çalışırken bilgisayarı uyanık tut" kararı. Electron'dan bağımsızdır:
 * `powerSaveBlocker` bir port olarak enjekte edilir. Kural: ayar açık VE en az
 * bir sohbet çalışıyorsa TEK bir engelleyici tutulur; aksi halde bırakılır.
 * Yalnızca `prevent-app-suspension` kullanılır (ekran açık tutulmaz).
 */
export interface PowerBlockerPort {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

export interface KeepAwakeController {
  setEnabled(enabled: boolean): void;
  setWorkingCount(count: number): void;
  /** Engelleyiciyi bırakır ve denetleyiciyi etkisiz kılar; uygulama kapanırken çağrılır. */
  dispose(): void;
  readonly isHeld: boolean;
}

export function createKeepAwakeController(blocker: PowerBlockerPort): KeepAwakeController {
  let enabled = false;
  let workingCount = 0;
  let blockerId: number | undefined;
  let disposed = false;

  const sync = (): void => {
    const shouldHold = !disposed && enabled && workingCount > 0;
    if (shouldHold && blockerId === undefined) {
      blockerId = blocker.start('prevent-app-suspension');
    } else if (!shouldHold && blockerId !== undefined) {
      const id = blockerId;
      blockerId = undefined;
      blocker.stop(id);
    }
  };

  return {
    setEnabled(next) {
      enabled = next;
      sync();
    },
    setWorkingCount(count) {
      workingCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
      sync();
    },
    dispose() {
      disposed = true;
      sync();
    },
    get isHeld() {
      return blockerId !== undefined;
    },
  };
}
