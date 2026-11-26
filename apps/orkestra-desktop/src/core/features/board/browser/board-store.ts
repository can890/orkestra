import { observable, runInAction } from 'mobx';
import {
  addTile,
  buildDefaultBoardLayout,
  insertTileInBoardLayout,
  MAX_BOARD_TILES,
  normalizeBoardLayout,
  removeTile,
  removeTileFromBoardLayout,
  tilesFromLayout,
  type BoardDropTarget,
  type BoardLayoutNode,
  type BoardTileRef,
} from '@core/features/board/api/board-layout';
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

  /** Custom split tree when user dropped directionally or chose a stacked/horizontal mode; null for auto-grid. */
  get layout(): BoardLayoutNode | null {
    const raw = this.handle.value.layout;
    if (!raw) return null;
    return normalizeBoardLayout(raw, this.handle.value.tiles);
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
    this.mutateState((current) => {
      const nextTiles = addTile(current.tiles, ref);
      if (nextTiles === current.tiles) return current;
      if (!current.layout) {
        return { version: '1', tiles: [...nextTiles] };
      }
      const nextLayout = insertTileInBoardLayout(current.layout, ref, { side: 'right' });
      return {
        version: '1',
        tiles: tilesFromLayout(nextLayout),
        ...(nextLayout.kind === 'split' ? { layout: nextLayout } : {}),
      };
    });
  }

  setTiles(nextTiles: readonly BoardTileRef[]): void {
    this.mutateState(() => ({ version: '1', tiles: [...nextTiles] }));
  }

  setLayout(nextLayout: BoardLayoutNode | null): void {
    this.mutateState(() => {
      if (!nextLayout) return { version: '1', tiles: [] };
      const syncedTiles = tilesFromLayout(nextLayout);
      return {
        version: '1',
        tiles: syncedTiles,
        ...(nextLayout.kind === 'split' ? { layout: nextLayout } : {}),
      };
    });
  }

  /**
   * Belirtilen yönde (`left | right | top | bottom`) ve varsa hedef karoya göre yeni karo
   * ekler veya mevcut karoyu taşır.
   */
  insertAt(ref: BoardTileRef, target?: BoardDropTarget): void {
    this.mutateState((current) => {
      const exists = current.tiles.some((t) => t.taskId === ref.taskId);
      if (!exists && current.tiles.length >= MAX_BOARD_TILES) return current;
      const baseLayout =
        normalizeBoardLayout(current.layout, current.tiles) ??
        buildDefaultBoardLayout(current.tiles, 'horizontal');
      const nextLayout = insertTileInBoardLayout(baseLayout, ref, target);
      return {
        version: '1',
        tiles: tilesFromLayout(nextLayout),
        ...(nextLayout.kind === 'split' ? { layout: nextLayout } : {}),
      };
    });
  }

  setArrangement(mode: 'horizontal' | 'vertical' | 'grid'): void {
    this.mutateState((current) => {
      if (mode === 'grid') {
        return { version: '1', tiles: [...current.tiles] };
      }
      const nextLayout = buildDefaultBoardLayout(current.tiles, mode);
      return {
        version: '1',
        tiles: [...current.tiles],
        ...(nextLayout && nextLayout.kind === 'split' ? { layout: nextLayout } : {}),
      };
    });
  }

  /** Panodaki sohbetlerin sırasını ters çevirir (2 karoda sol/sağ veya üst/alt yer değiştirir). */
  swapTiles(): void {
    this.mutateState((current) => {
      if (current.tiles.length < 2) return current;
      const reversed = [...current.tiles].reverse();
      if (!current.layout) {
        return { version: '1', tiles: reversed };
      }
      const axis = current.layout.kind === 'split' ? current.layout.axis : 'horizontal';
      const nextLayout = buildDefaultBoardLayout(reversed, axis);
      return {
        version: '1',
        tiles: reversed,
        ...(nextLayout && nextLayout.kind === 'split' ? { layout: nextLayout } : {}),
      };
    });
  }

  remove(taskId: string): void {
    this.mutateState((current) => {
      const nextTiles = removeTile(current.tiles, taskId);
      if (nextTiles === current.tiles) return current;
      if (!current.layout) {
        return { version: '1', tiles: [...nextTiles] };
      }
      const nextLayout = removeTileFromBoardLayout(current.layout, taskId);
      return {
        version: '1',
        tiles: [...nextTiles],
        ...(nextLayout && nextLayout.kind === 'split' ? { layout: nextLayout } : {}),
      };
    });
  }

  /**
   * Writes only after the stored value has loaded, so an early click cannot overwrite the saved
   * layout with the default.
   */
  private mutateState(transform: (current: BoardLayoutState) => BoardLayoutState): void {
    const handle = this.handle;
    const apply = () => {
      handle.update((current) => {
        const next = transform(current);
        return next === current ? current : next;
      });
    };
    if (this._ready) apply();
    else void handle.ready.then(apply);
  }
}
