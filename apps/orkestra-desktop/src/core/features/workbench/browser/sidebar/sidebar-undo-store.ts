import { makeAutoObservable } from 'mobx';

export interface SidebarUndoEntry {
  id: number;
  label: string;
  undo: () => Promise<void> | void;
}

const UNDO_TTL_MS = 6500;

class SidebarUndoStore {
  entry: SidebarUndoEntry | null = null;
  private nextId = 1;
  private timer: number | undefined;

  constructor() {
    makeAutoObservable(this);
  }

  push(label: string, undo: () => Promise<void> | void): void {
    window.clearTimeout(this.timer);
    this.entry = { id: this.nextId++, label, undo };
    this.timer = window.setTimeout(() => {
      this.clear();
    }, UNDO_TTL_MS);
  }

  clear(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.entry = null;
  }

  async performUndo(): Promise<void> {
    const current = this.entry;
    if (!current) return;
    this.clear();
    await current.undo();
  }
}

export const sidebarUndoStore = new SidebarUndoStore();
