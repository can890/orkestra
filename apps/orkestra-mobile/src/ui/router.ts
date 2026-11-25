import { useCallback, useEffect, useRef, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'projects' }
  | { name: 'tasks'; projectId: string; projectName: string }
  | {
      name: 'conversations';
      projectId: string;
      projectName?: string;
      taskId: string;
      taskName: string;
    }
  | {
      name: 'chat';
      conversationId: string;
      title: string;
      providerId: string;
      projectId?: string;
      projectName?: string;
      taskId?: string;
      taskName?: string;
      workspaceId?: string;
    }
  | { name: 'accounts' }
  | { name: 'settings' };

const HOME: Route = { name: 'home' };

function readRoute(state: unknown, scope: string): Route {
  if (
    typeof state === 'object' &&
    state !== null &&
    'route' in state &&
    'scope' in state &&
    state.scope === scope
  ) {
    const candidate = (state as { route?: Route }).route;
    if (candidate && typeof candidate.name === 'string') {
      return candidate;
    }
  }
  return HOME;
}

export function isSameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  switch (a.name) {
    case 'home':
    case 'projects':
    case 'accounts':
    case 'settings':
      return true;
    case 'tasks':
      return b.name === 'tasks' && a.projectId === b.projectId;
    case 'conversations':
      return b.name === 'conversations' && a.projectId === b.projectId && a.taskId === b.taskId;
    case 'chat':
      return b.name === 'chat' && a.conversationId === b.conversationId;
  }
}

/**
 * Bellek-içi yığın destekli yönlendirici: Android'in native geri tuşu/hareketi
 * (`MainActivity` -> `window.__orkestraHandleBack`) doğrudan `goBack()` çağırır;
 * böylece geçmişte ekran varken uygulama asla kapanmaz.
 */
export function useRouter(scope: string) {
  const [history, setHistory] = useState(() => ({
    scope,
    stack: [readRoute(window.history.state, scope)],
  }));
  const stack = history.scope === scope ? history.stack : [HOME];
  const setStack = useCallback(
    (update: (current: Route[]) => Route[]) => {
      setHistory((current) => ({
        scope,
        stack: update(current.scope === scope ? current.stack : [HOME]),
      }));
    },
    [scope]
  );
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const route = stack[stack.length - 1] ?? HOME;

  useEffect(() => {
    if (window.history.state?.scope !== scope) {
      window.history.replaceState({ route: HOME, scope }, '');
    }
    const onPop = (event: PopStateEvent): void => {
      const target = readRoute(event.state, scope);
      setStack((prev) => {
        if (prev.length > 1) {
          const next = prev.slice(0, -1);
          next[next.length - 1] = target;
          return next;
        }
        return [target];
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [scope, setStack]);

  const push = useCallback(
    (next: Route) => {
      const current = stackRef.current[stackRef.current.length - 1] ?? HOME;
      if (isSameRoute(current, next)) return;
      window.history.pushState({ route: next, scope }, '');
      setStack((prev) => {
        // Yığını makul boyutta tut (son 40 ekran)
        const trimmed = prev.length >= 40 ? prev.slice(prev.length - 39) : prev;
        return [...trimmed, next];
      });
    },
    [scope, setStack]
  );

  const replace = useCallback(
    (next: Route) => {
      window.history.replaceState({ route: next, scope }, '');
      setStack((prev) => {
        if (prev.length === 0) return [next];
        return [...prev.slice(0, -1), next];
      });
    },
    [scope, setStack]
  );

  /**
   * Bir önceki ekrana döner. Geri dönülebildiyse `true`, kök ana ekrandaysa `false` döner.
   */
  const goBack = useCallback((): boolean => {
    const currentStack = stackRef.current;
    if (currentStack.length > 1) {
      const nextStack = currentStack.slice(0, -1);
      const target = nextStack[nextStack.length - 1] ?? HOME;
      setStack(() => nextStack);
      window.history.replaceState({ route: target, scope }, '');
      return true;
    }
    const current = currentStack[0] ?? HOME;
    if (current.name !== 'home') {
      setStack(() => [HOME]);
      window.history.replaceState({ route: HOME, scope }, '');
      return true;
    }
    return false;
  }, [scope, setStack]);

  const back = useCallback(() => {
    goBack();
  }, [goBack]);

  return { route, push, replace, back, goBack };
}
