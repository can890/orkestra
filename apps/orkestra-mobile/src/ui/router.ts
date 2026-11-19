import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { name: 'projects' }
  | { name: 'tasks'; projectId: string; projectName: string }
  | { name: 'conversations'; projectId: string; taskId: string; taskName: string }
  | { name: 'chat'; conversationId: string; title: string; providerId: string }
  | { name: 'accounts' }
  | { name: 'settings' };

const HOME: Route = { name: 'projects' };

function readRoute(state: unknown): Route {
  if (typeof state === 'object' && state !== null && 'route' in state) {
    return (state as { route: Route }).route;
  }
  return HOME;
}

/**
 * Gezinme `history` API'si üzerindedir: Android'in geri düğmesi WebView geçmişinde geri gider
 * (Capacitor `canGoBack`), böylece ek eklenti gerekmez.
 */
export function useRouter() {
  const [route, setRoute] = useState<Route>(() => readRoute(window.history.state));

  useEffect(() => {
    if (window.history.state === null) window.history.replaceState({ route: HOME }, '');
    const onPop = (event: PopStateEvent): void => setRoute(readRoute(event.state));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const push = useCallback((next: Route) => {
    window.history.pushState({ route: next }, '');
    setRoute(next);
  }, []);
  const replace = useCallback((next: Route) => {
    window.history.replaceState({ route: next }, '');
    setRoute(next);
  }, []);
  const back = useCallback(() => window.history.back(), []);
  return { route, push, replace, back };
}
