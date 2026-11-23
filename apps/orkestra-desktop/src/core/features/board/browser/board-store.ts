import { observable, runInAction } from 'mobx';
import { addTile, removeTile, type BoardTileRef } from '@core/features/board/api/board-layout';
import type { BoardLayoutState } from '@core/features/board/contributions/mementos';
import type { MementoHandle } from '@core/primitives/mementos/browser';

/**
 * App-scoped owner of the persisted Board layout.
 *
 * Both the Board view and out-of-view callers (sidebar, command palette) go through this single
 * store so they share one memento handle: a handle opened separately for another subject space
 * would not be observed by the mounted view. The handle is acquired lazily because the app scope
 * is created before the memento client is initialized.
 */
export class BoardStore {
  private _handle: MementoHandle<BoardLayoutState> | undefined;
  private _ready = false;
  private readonly _pendingFocus = observable.box<string | undefined>(undefined);

  constructor(private readonly acquireHandle: () => MementoHandle<BoardLayoutState>) {}

  private get handle(): MementoHandle<BoardLayoutState> {
    if (!this._handle) {
      const handle = this.acquireHandle();
      this._handle = handle;
      void handle.ready.then(() => {
        this._ready = true;
      });
    }
    return this._handle;
  }

  /** Tiles in display order. Observable through the memento handle. */
  get tiles(): readonly BoardTileRef[] {
    return this.handle.value.tiles;
  }

  /** One-shot request for the mounted Board to focus a tile, e.g. after a sidebar drop. */
  get pendingFocusTaskId(): string | undefined {
    return this._pendingFocus.get();
  }

  requestFocus(taskId: string): void {
    runInAction(() => this._pendingFocus.set(taskId));
  }

  /** Clears the request once the Board has applied it; stale ids are ignored. */
  consumeFocus(taskId: string): void {
    runInAction(() => {
      if (this._pendingFocus.get() === taskId) this._pendingFocus.set(undefined);
    });
  }

  hasTask(taskId: string): boolean {
    return this.tiles.some((tile) => tile.taskId === taskId);
  }

  add(ref: BoardTileRef): void {
    this.mutate((tiles) => addTile(tiles, ref));
  }

  setTiles(nextTiles: readonly BoardTileRef[]): void {
    this.mutate(() => [...nextTiles]);
  }

  remove(taskId: string): void {
    this.mutate((tiles) => removeTile(tiles, taskId));
  }

  /**
   * Writes only after the stored value has loaded, so an early click cannot overwrite the saved
   * layout with the default.
   */
  private mutate(transform: (tiles: readonly BoardTileRef[]) => readonly BoardTileRef[]): void {
    const handle = this.handle;
    const apply = () => {
      handle.update((current) => {
        const next = transform(current.tiles);
        return next === current.tiles ? current : { version: '1', tiles: [...next] };
      });
    };
    if (this._ready) apply();
    else void handle.ready.then(apply);
  }
}
