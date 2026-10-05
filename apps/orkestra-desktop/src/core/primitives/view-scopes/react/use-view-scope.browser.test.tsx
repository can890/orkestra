import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineViewScope } from '@core/primitives/view-scopes/api';
import { ViewScopes, type ViewScopeInstance } from '@core/primitives/view-scopes/browser';
import { useViewScope, ViewScopeInstanceProvider } from './use-view-scope';

const layerScope = defineViewScope({
  id: 'test.layer',
  params: z.object({ name: z.string() }),
  commands: [],
  activation: 'logical',
  key: ({ name }) => name,
});

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('useViewScope', () => {
  let host: HTMLDivElement;
  let root: Root;
  let runtime: ViewScopes;
  let errors: unknown[];
  let rendered: Map<string, ViewScopeInstance | undefined>;

  function Layer({ name, children }: { name: string; children?: ReactNode }) {
    const { instance } = useViewScope<typeof layerScope>(layerScope({ name }), {}, runtime);
    rendered.set(name, instance);
    return <ViewScopeInstanceProvider instance={instance}>{children}</ViewScopeInstanceProvider>;
  }

  function live(name: string): ViewScopeInstance {
    const instance = rendered.get(name);
    expect(instance, `${name} scope`).toBeDefined();
    expect(instance!.isDisposed, `${name} scope disposed`).toBe(false);
    return instance!;
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    errors = [];
    rendered = new Map();
    runtime = new ViewScopes(document);
    root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
  });

  afterEach(() => {
    act(() => root.unmount());
    runtime.dispose();
    host.remove();
  });

  it('attaches three nested scopes that mount in the same commit to their live parents', () => {
    act(() =>
      root.render(
        <Layer name="task">
          <Layer name="pane">
            <Layer name="editor" />
          </Layer>
        </Layer>
      )
    );

    expect(errors).toEqual([]);
    const task = live('task');
    const pane = live('pane');
    const editor = live('editor');
    expect(task.parent).toBeUndefined();
    expect(pane.parent).toBe(task);
    expect(editor.parent).toBe(pane);
  });

  it('recreates a scope whose key changes while an ancestor is replaced in the same commit', () => {
    const tree = (task: string, editor: string) => (
      <Layer name={task}>
        <Layer name="pane">
          <Layer name={editor} />
        </Layer>
      </Layer>
    );
    act(() => root.render(tree('task-a', 'editor-a')));
    const previousPane = live('pane');

    act(() => root.render(tree('task-b', 'editor-b')));

    expect(errors).toEqual([]);
    expect(previousPane.isDisposed).toBe(true);
    const task = live('task-b');
    const pane = live('pane');
    const editor = live('editor-b');
    expect(pane).not.toBe(previousPane);
    expect(pane.parent).toBe(task);
    expect(editor.parent).toBe(pane);
  });
});
