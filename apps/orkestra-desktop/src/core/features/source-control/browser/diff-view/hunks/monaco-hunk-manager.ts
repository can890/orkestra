import type { GitDiffHunk, GitHunkAction, GitHunkScope } from '@orkestra/core/runtimes/git/api';
import type * as monaco from 'monaco-editor';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HunkActionToolbar } from './hunk-action-toolbar';

const HUNK_ZONE_HEIGHT_PX = 26;

export interface MonacoHunkManagerOptions {
  onApplyHunk: (
    hunk: GitDiffHunk,
    scope: GitHunkScope,
    action: GitHunkAction
  ) => void | Promise<void>;
}

function resolveAfterLineNumber(hunk: GitDiffHunk): number {
  if (hunk.newLines === 0) {
    return Math.max(0, hunk.newStart);
  }
  return Math.max(0, hunk.newStart - 1);
}

export class MonacoHunkManager {
  private readonly editor: monaco.editor.IStandaloneDiffEditor;
  private readonly options: MonacoHunkManagerOptions;
  private readonly viewZoneRoots = new Map<
    string,
    { zoneId: string; root: Root; domNode: HTMLElement; afterLineNumber: number }
  >();
  private busyHunkId: string | null = null;
  private currentHunks: GitDiffHunk[] = [];
  private currentScope: GitHunkScope | null = null;
  private disposed = false;

  constructor(editor: monaco.editor.IStandaloneDiffEditor, options: MonacoHunkManagerOptions) {
    this.editor = editor;
    this.options = options;
  }

  private renderToolbar(root: Root, hunk: GitDiffHunk, scope: GitHunkScope): void {
    root.render(
      React.createElement(HunkActionToolbar, {
        hunk,
        scope,
        busy: this.busyHunkId === hunk.id,
        onApply: (action) => {
          void this.handleApply(hunk, scope, action);
        },
      })
    );
  }

  private async handleApply(
    hunk: GitDiffHunk,
    scope: GitHunkScope,
    action: GitHunkAction
  ): Promise<void> {
    if (this.disposed) return;
    this.busyHunkId = hunk.id;
    this.refreshRenders();
    try {
      await this.options.onApplyHunk(hunk, scope, action);
    } finally {
      this.busyHunkId = null;
      if (!this.disposed) {
        this.refreshRenders();
      }
    }
  }

  private refreshRenders(): void {
    if (!this.currentScope) return;
    for (const hunk of this.currentHunks) {
      const existing = this.viewZoneRoots.get(hunk.id);
      if (existing) {
        this.renderToolbar(existing.root, hunk, this.currentScope);
      }
    }
  }

  setHunks(hunks: GitDiffHunk[], scope: GitHunkScope | null): void {
    if (this.disposed) return;
    this.currentHunks = scope ? hunks : [];
    this.currentScope = scope;

    const modifiedEditor = this.editor.getModifiedEditor();
    const activeMap = new Map<string, GitDiffHunk>(
      scope ? hunks.map((hunk) => [`${scope}:${hunk.id}`, hunk]) : []
    );

    modifiedEditor.changeViewZones((accessor) => {
      for (const [key, zoneInfo] of Array.from(this.viewZoneRoots.entries())) {
        if (!activeMap.has(key)) {
          accessor.removeZone(zoneInfo.zoneId);
          queueMicrotask(() => zoneInfo.root.unmount());
          this.viewZoneRoots.delete(key);
        }
      }

      if (!scope) return;

      for (const [key, hunk] of activeMap.entries()) {
        const afterLineNumber = resolveAfterLineNumber(hunk);
        const existing = this.viewZoneRoots.get(key);
        if (existing) {
          this.renderToolbar(existing.root, hunk, scope);
          if (existing.afterLineNumber !== afterLineNumber) {
            accessor.removeZone(existing.zoneId);
            const zoneId = accessor.addZone({
              afterLineNumber,
              heightInPx: HUNK_ZONE_HEIGHT_PX,
              domNode: existing.domNode,
              suppressMouseDown: false,
              showInHiddenAreas: true,
            });
            this.viewZoneRoots.set(key, {
              ...existing,
              zoneId,
              afterLineNumber,
            });
          }
          continue;
        }

        const domNode = document.createElement('div');
        domNode.className = 'hunk-action-view-zone';
        domNode.style.pointerEvents = 'auto';
        domNode.style.position = 'relative';
        domNode.style.zIndex = '11';
        domNode.style.width = '100%';
        domNode.style.height = `${HUNK_ZONE_HEIGHT_PX}px`;

        const root = createRoot(domNode);
        this.renderToolbar(root, hunk, scope);

        const zoneId = accessor.addZone({
          afterLineNumber,
          heightInPx: HUNK_ZONE_HEIGHT_PX,
          domNode,
          suppressMouseDown: false,
          showInHiddenAreas: true,
        });

        this.viewZoneRoots.set(key, {
          zoneId,
          root,
          domNode,
          afterLineNumber,
        });
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    const modifiedEditor = this.editor.getModifiedEditor();
    modifiedEditor.changeViewZones((accessor) => {
      for (const zone of this.viewZoneRoots.values()) {
        accessor.removeZone(zone.zoneId);
        queueMicrotask(() => zone.root.unmount());
      }
    });
    this.viewZoneRoots.clear();
  }
}
