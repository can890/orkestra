import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppSession } from '@/core/app-session';
import { createPairingRepository } from '@/core/pairing-store';
import { createDeviceSecureStore } from '@/core/secure-store';
import { ConnectionBanner, TabBar } from './ui/components';
import { useConnectionStatus } from './ui/hooks';
import { useRouter, type Route } from './ui/router';
import { AccountsScreen } from './ui/screens/AccountsScreen';
import { ConversationsScreen, ProjectsScreen, TasksScreen } from './ui/screens/BrowseScreens';
import { ChatScreen } from './ui/screens/ChatScreen';
import { PairingScreen } from './ui/screens/PairingScreen';
import { SettingsScreen } from './ui/screens/SettingsScreen';

/** Arka planda bu kadar kalan uygulama, öne dönünce bağlantısını tazeler. */
const BACKGROUND_REFRESH_MS = 20_000;

export function App() {
  const session = useMemo(
    () =>
      new AppSession({
        repository: createPairingRepository(createDeviceSecureStore()),
        clientName: 'Android telefon',
        platform: 'android',
      }),
    []
  );
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);

  useEffect(() => {
    void session.init();
    let hiddenAt: number | null = null;
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt !== null && Date.now() - hiddenAt > BACKGROUND_REFRESH_MS) {
        hiddenAt = null;
        session.refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [session]);

  if (state.phase === 'loading') return <p className="empty">Yükleniyor…</p>;
  if (state.phase === 'unpaired') return <PairingScreen session={session} />;
  return <Paired session={session} state={state} />;
}

function Paired(props: {
  session: AppSession;
  state: Extract<ReturnType<AppSession['getState']>, { phase: 'paired' }>;
}) {
  const { session, state } = props;
  const { api, manager, record } = state;
  const status = useConnectionStatus(manager);
  const { route, push, replace, back } = useRouter();

  const topLevel =
    route.name === 'projects' || route.name === 'accounts' || route.name === 'settings';
  const goTab = (tab: 'projects' | 'accounts' | 'settings'): void =>
    replace({ name: tab } as Route);

  return (
    <div className="app">
      <ConnectionBanner status={status} session={session} />
      <div className="content">
        {route.name === 'projects' ? <ProjectsScreen api={api} push={push} /> : null}
        {route.name === 'tasks' ? (
          <TasksScreen
            api={api}
            projectId={route.projectId}
            projectName={route.projectName}
            push={push}
            back={back}
          />
        ) : null}
        {route.name === 'conversations' ? (
          <ConversationsScreen
            api={api}
            manager={manager}
            projectId={route.projectId}
            taskId={route.taskId}
            taskName={route.taskName}
            push={push}
            back={back}
          />
        ) : null}
        {route.name === 'chat' ? (
          <ChatScreen
            api={api}
            conversationId={route.conversationId}
            title={route.title}
            providerId={route.providerId}
            back={back}
          />
        ) : null}
        {route.name === 'accounts' ? <AccountsScreen api={api} /> : null}
        {route.name === 'settings' ? (
          <SettingsScreen session={session} record={record} manager={manager} />
        ) : null}
      </div>
      {topLevel ? (
        <TabBar
          active={
            route.name === 'accounts'
              ? 'accounts'
              : route.name === 'settings'
                ? 'settings'
                : 'projects'
          }
          onSelect={goTab}
        />
      ) : null}
    </div>
  );
}
