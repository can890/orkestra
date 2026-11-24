import { action, makeObservable, observable } from 'mobx';

export const MINI_PLAYER_DEFAULT_WIDTH = 320;
export const MINI_PLAYER_DEFAULT_HEIGHT = 320;
export const MINI_PLAYER_MIN_WIDTH = 240;
export const MINI_PLAYER_MIN_HEIGHT = 150;

const STORAGE_KEY = 'orkestra:browser-mini-player';

export type MiniPlayerPosition = {
  x: number;
  y: number;
};

export type MiniPlayerGeometry = {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
};

export type TaskMiniPlayerState = {
  browserId: string | null;
  geometry: MiniPlayerGeometry;
};

function defaultGeometry(): MiniPlayerGeometry {
  return {
    width: MINI_PLAYER_DEFAULT_WIDTH,
    height: MINI_PLAYER_DEFAULT_HEIGHT,
    x: null,
    y: null,
  };
}

function readPersistedGeometry(): MiniPlayerGeometry {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return defaultGeometry();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultGeometry();
    const parsed = JSON.parse(raw) as Partial<MiniPlayerGeometry>;
    const width =
      typeof parsed.width === 'number' && Number.isFinite(parsed.width)
        ? Math.max(MINI_PLAYER_MIN_WIDTH, Math.round(parsed.width))
        : MINI_PLAYER_DEFAULT_WIDTH;
    const height =
      typeof parsed.height === 'number' && Number.isFinite(parsed.height)
        ? Math.max(MINI_PLAYER_MIN_HEIGHT, Math.round(parsed.height))
        : MINI_PLAYER_DEFAULT_HEIGHT;
    const x = typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : null;
    const y = typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : null;
    return { width, height, x, y };
  } catch {
    return defaultGeometry();
  }
}

function persistGeometry(geometry: MiniPlayerGeometry): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(geometry));
  } catch {
    // Depolama kotası aşımında sessizce yoksay.
  }
}

export function taskMiniPlayerKey(projectId: string, taskId: string): string {
  return `${projectId}\u0000${taskId}`;
}

export class BrowserMiniPlayerStore {
  readonly states = observable.map<string, TaskMiniPlayerState>({}, { deep: false });
  sharedGeometry: MiniPlayerGeometry = readPersistedGeometry();

  constructor() {
    makeObservable(this, {
      states: observable,
      sharedGeometry: observable,
      openFloating: action,
      closeFloating: action,
      move: action,
      resize: action,
      clearBrowser: action,
      clear: action,
    });
  }

  getEntry(projectId: string, taskId: string): TaskMiniPlayerState {
    const key = taskMiniPlayerKey(projectId, taskId);
    return this.states.get(key) ?? { browserId: null, geometry: this.sharedGeometry };
  }

  floatingBrowserForTask(projectId: string, taskId: string): string | null {
    return this.states.get(taskMiniPlayerKey(projectId, taskId))?.browserId ?? null;
  }

  isFloating(browserId: string): boolean {
    for (const state of this.states.values()) {
      if (state.browserId === browserId) return true;
    }
    return false;
  }

  openFloating(projectId: string, taskId: string, browserId: string): void {
    const key = taskMiniPlayerKey(projectId, taskId);
    const current = this.states.get(key);
    this.states.set(key, {
      browserId,
      geometry: current?.geometry ?? this.sharedGeometry,
    });
  }

  closeFloating(projectId: string, taskId: string): void {
    const key = taskMiniPlayerKey(projectId, taskId);
    const current = this.states.get(key);
    if (!current || current.browserId === null) return;
    this.states.set(key, { ...current, browserId: null });
  }

  move(projectId: string, taskId: string, position: MiniPlayerPosition): void {
    const key = taskMiniPlayerKey(projectId, taskId);
    const current = this.getEntry(projectId, taskId);
    const geometry: MiniPlayerGeometry = {
      ...current.geometry,
      x: Math.round(position.x),
      y: Math.round(position.y),
    };
    this.sharedGeometry = geometry;
    this.states.set(key, { ...current, geometry });
    persistGeometry(geometry);
  }

  resize(
    projectId: string,
    taskId: string,
    width: number,
    height: number,
    position?: MiniPlayerPosition
  ): void {
    const key = taskMiniPlayerKey(projectId, taskId);
    const current = this.getEntry(projectId, taskId);
    const clampedWidth = Math.max(MINI_PLAYER_MIN_WIDTH, Math.round(width));
    const clampedHeight = Math.max(MINI_PLAYER_MIN_HEIGHT, Math.round(height));
    const geometry: MiniPlayerGeometry = {
      width: clampedWidth,
      height: clampedHeight,
      x: position ? Math.round(position.x) : current.geometry.x,
      y: position ? Math.round(position.y) : current.geometry.y,
    };
    this.sharedGeometry = geometry;
    this.states.set(key, { ...current, geometry });
    persistGeometry(geometry);
  }

  clearBrowser(browserId: string): void {
    for (const [key, state] of this.states) {
      if (state.browserId === browserId) {
        this.states.set(key, { ...state, browserId: null });
      }
    }
  }

  clear(): void {
    this.states.clear();
  }
}

export const browserMiniPlayerStore = new BrowserMiniPlayerStore();
