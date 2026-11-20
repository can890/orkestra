import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { openConversation, type ConversationHandle } from '@/core/conversation-session';
import {
  mapSessionConfig,
  mapSessionPlan,
  mapSessionUsage,
  type ConversationView,
  type PermissionView,
  type PlanEntryView,
  type SessionConfigView,
  type SessionUsageView,
  type TranscriptEntry,
} from '@/core/mappers';
import { REMOTE_TOPICS, topicOf, type RemoteApi } from '@/core/wire-client';
import {
  ErrorNote,
  Loading,
  WorkbenchHeader,
  formatTokens,
  providerDisplayName,
} from '../components';
import { useLive } from '../hooks';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileCodeIcon,
  GlobeIcon,
  ListChecksIcon,
  ShieldAlertIcon,
  SparklesIcon,
  SquareStopIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from '../icons';
import { MarkdownView } from '../MarkdownView';
import type { Route } from '../router';

export function ChatScreen(props: {
  api: RemoteApi;
  conversationId: string;
  title: string;
  providerId: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskName?: string;
  siblingConversations: ConversationView[];
  agentNames: Record<string, string>;
  onOpenMenu: () => void;
  onSwitchConversation: (route: Route) => void;
  back: () => void;
}) {
  const [handle, setHandle] = useState<ConversationHandle | null>(null);
  useEffect(() => {
    const opened = openConversation(props.api, props.conversationId);
    setHandle(opened);
    return () => {
      opened.dispose();
      setHandle(null);
    };
  }, [props.api, props.conversationId]);

  const config = useLive<SessionConfigView>(
    props.api,
    topicOf(REMOTE_TOPICS.sessionConfig, { conversationId: props.conversationId }),
    mapSessionConfig
  );
  const usage = useLive<SessionUsageView | null>(
    props.api,
    topicOf(REMOTE_TOPICS.sessionUsage, { conversationId: props.conversationId }),
    mapSessionUsage
  );
  const plan = useLive<PlanEntryView[]>(
    props.api,
    topicOf(REMOTE_TOPICS.sessionPlan, { conversationId: props.conversationId }),
    mapSessionPlan
  );

  const providerLabel = providerDisplayName(props.providerId, props.agentNames);

  if (!handle) {
    return (
      <main className="screen chat-screen">
        <WorkbenchHeader
          title={props.title}
          subtitle={props.projectName ? `${props.projectName} · ${providerLabel}` : providerLabel}
          onBack={props.back}
          onMenu={props.onOpenMenu}
        />
        <div className="chat-loading-wrap">
          <Loading label="Oturum açılıyor…" />
        </div>
      </main>
    );
  }

  return (
    <ChatView
      handle={handle}
      conversationId={props.conversationId}
      title={props.title}
      providerId={props.providerId}
      providerLabel={providerLabel}
      projectId={props.projectId}
      projectName={props.projectName}
      taskId={props.taskId}
      taskName={props.taskName}
      siblingConversations={props.siblingConversations}
      agentNames={props.agentNames}
      config={config.data}
      usage={usage.data}
      plan={plan.data ?? []}
      onOpenMenu={props.onOpenMenu}
      onSwitchConversation={props.onSwitchConversation}
      back={props.back}
    />
  );
}

function ChatView(props: {
  handle: ConversationHandle;
  conversationId: string;
  title: string;
  providerId: string;
  providerLabel: string;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskName?: string;
  siblingConversations: ConversationView[];
  agentNames: Record<string, string>;
  config: SessionConfigView | null;
  usage: SessionUsageView | null;
  plan: PlanEntryView[];
  onOpenMenu: () => void;
  onSwitchConversation: (route: Route) => void;
  back: () => void;
}) {
  const { handle } = props;
  const view = useSyncExternalStore(handle.subscribe, handle.getState, handle.getState);

  const [draft, setDraft] = useState('');
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [view.entries, view.pending, view.session?.permissions.length]);

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(144, Math.max(40, ta.scrollHeight))}px`;
  }, [draft]);

  const session = view.session;
  const isWorking = session?.lifecycle === 'working' || session?.isGenerating === true;
  const canCancel = session?.canCancel === true || session?.isGenerating === true;

  const subtitle = useMemo(() => {
    const parts: string[] = [];
    if (props.projectName) parts.push(props.projectName);
    if (isWorking) parts.push('Çalışıyor…');
    else if (session?.lifecycle === 'cancelling') parts.push('Durduruluyor…');
    else if (session?.lifecycle === 'closed') parts.push('Oturum kapalı');
    else if (session?.suspended) parts.push('Askıda');
    else parts.push(props.providerLabel);
    return parts.join(' · ');
  }, [props.projectName, props.providerLabel, isWorking, session?.lifecycle, session?.suspended]);

  async function send(): Promise<void> {
    const text = draft;
    if (text.trim() === '') return;
    setDraft('');
    stick.current = true;
    setShowScrollBtn(false);
    const accepted = await handle.send(text);
    if (!accepted) setDraft(text);
  }

  function scrollToBottom(): void {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setShowScrollBtn(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  const chatTabs = props.siblingConversations.filter((c) => c.chatCapable);

  return (
    <main className="screen chat-screen">
      <WorkbenchHeader
        title={props.title}
        subtitle={subtitle}
        onBack={props.back}
        onMenu={props.onOpenMenu}
        trailing={
          isWorking ? (
            <span className="working-badge">
              <span className="status-dot is-working" aria-hidden="true" />
              <span>Aktif</span>
            </span>
          ) : null
        }
      />

      {chatTabs.length > 1 ? (
        <div className="conv-tabs" role="tablist" aria-label="Görev sohbetleri">
          {chatTabs.map((conv) => {
            const active = conv.id === props.conversationId;
            return (
              <button
                key={conv.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`conv-tab ${active ? 'is-active' : ''}`}
                onClick={() => {
                  if (!active) {
                    props.onSwitchConversation({
                      name: 'chat',
                      conversationId: conv.id,
                      title: conv.title,
                      providerId: conv.providerId,
                      projectId: props.projectId,
                      projectName: props.projectName,
                      taskId: props.taskId,
                      taskName: props.taskName,
                    });
                  }
                }}
              >
                <span className="conv-tab-title">{conv.title}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="chat-stage">
        <div
          className="transcript"
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            stick.current = atBottom;
            setShowScrollBtn(!atBottom);
          }}
        >
          {view.phase === 'loading' ? <Loading label="Sohbet yükleniyor…" /> : null}
          {view.phase === 'error' ? <ErrorNote message={view.error} /> : null}

          {view.hasOlder ? (
            <button
              type="button"
              className="btn btn-ghost load-older-btn"
              disabled={view.loadingOlder}
              onClick={() => void handle.loadOlder()}
            >
              {view.loadingOlder ? 'Yükleniyor…' : 'Daha eski mesajları yükle'}
            </button>
          ) : null}

          {view.entries.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}

          {view.pending.map((item) => (
            <div key={item.promptId} className="msg-user is-pending">
              <p className="msg-user-text">{item.text}</p>
              <div className="msg-user-meta">
                {item.state === 'failed' ? (
                  <>
                    <span className="text-err">{item.error ?? 'Gönderilemedi'}</span>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => void handle.retry(item.promptId)}
                    >
                      Tekrar dene
                    </button>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => handle.dismissPending(item.promptId)}
                    >
                      Sil
                    </button>
                  </>
                ) : item.state === 'queued' ? (
                  <span>Sıraya alındı</span>
                ) : (
                  <span>Gönderiliyor…</span>
                )}
              </div>
            </div>
          ))}

          {isWorking && view.entries.length > 0 ? (
            <div className="typing-indicator" aria-live="polite">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span>{props.providerLabel} yanıtlıyor…</span>
            </div>
          ) : null}

          {session?.suspended ? (
            <p className="suspended-note">
              Oturum uyku modunda — mesaj gönderdiğinizde masaüstünde otomatik uyanır.
            </p>
          ) : null}
        </div>

        {showScrollBtn ? (
          <button
            type="button"
            className="scroll-bottom-btn"
            onClick={scrollToBottom}
            aria-label="En alta in"
          >
            <ArrowDownIcon size={16} />
          </button>
        ) : null}
      </div>

      {props.plan.length > 0 ? (
        <PlanStrip entries={props.plan} open={planOpen} onToggle={() => setPlanOpen((v) => !v)} />
      ) : null}

      {session?.permissions.map((permission) => (
        <PermissionCard
          key={permission.requestId}
          permission={permission}
          onChoose={(optionId) => void handle.resolvePermission(permission.requestId, optionId)}
        />
      ))}

      {view.actionError ? (
        <div className="banner banner-error" role="alert">
          <span className="banner-text">{view.actionError}</span>
          <button type="button" className="btn btn-sm" onClick={() => handle.dismissActionError()}>
            Tamam
          </button>
        </div>
      ) : null}

      <div className="composer-dock">
        <div className="composer-card">
          <textarea
            ref={textareaRef}
            className="composer-input"
            rows={1}
            value={draft}
            placeholder={
              session?.queuedCount
                ? `${session.queuedCount} mesaj sırada · Yeni mesaj yazın…`
                : `${props.providerLabel} ile devam et…`
            }
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Mesaj"
          />
          <div className="composer-bar">
            <div className="composer-meta">
              <span className="composer-chip">
                {props.config?.modelLabel || props.providerLabel}
              </span>
              {props.config?.modeLabel ? (
                <span className="composer-chip subtle">{props.config.modeLabel}</span>
              ) : null}
              {props.usage ? (
                <span
                  className={`composer-chip mono ${props.usage.percent >= 85 ? 'warn' : 'subtle'}`}
                  title="Bağlam penceresi kullanımı"
                >
                  {formatTokens(props.usage.contextUsed)} / {formatTokens(props.usage.contextSize)}
                </span>
              ) : null}
              {session && session.queuedCount > 0 ? (
                <span className="composer-chip accent">+{session.queuedCount} sırada</span>
              ) : null}
            </div>
            <div className="composer-actions">
              {canCancel ? (
                <button
                  type="button"
                  className="composer-stop-btn"
                  onClick={() => void handle.cancel()}
                  aria-label="Durdur"
                  title="Turu durdur"
                >
                  <SquareStopIcon size={15} />
                </button>
              ) : null}
              <button
                type="button"
                className="composer-send-btn"
                disabled={draft.trim() === '' || view.phase !== 'ready'}
                onClick={() => void send()}
                aria-label="Gönder"
                title="Gönder"
              >
                <ArrowUpIcon size={17} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function PlanStrip(props: { entries: PlanEntryView[]; open: boolean; onToggle: () => void }) {
  const doneCount = props.entries.filter((e) => e.status === 'completed').length;
  const activeStep = props.entries.find((e) => e.status === 'in_progress');
  return (
    <div className="plan-strip">
      <button type="button" className="plan-toggle" onClick={props.onToggle}>
        <ListChecksIcon size={14} className="icon-accent" />
        <span className="plan-summary">
          {activeStep
            ? activeStep.content
            : `Plan · ${doneCount}/${props.entries.length} tamamlandı`}
        </span>
        <span className="plan-count">
          {doneCount}/{props.entries.length}
        </span>
        {props.open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
      </button>
      {props.open ? (
        <ul className="plan-list">
          {props.entries.map((step) => (
            <li key={step.id} className={`plan-item is-${step.status}`}>
              <span className="plan-icon" aria-hidden="true">
                {step.status === 'completed' ? (
                  <CheckIcon size={12} />
                ) : step.status === 'in_progress' ? (
                  <span className="status-dot is-working sm" />
                ) : (
                  <span className="plan-bullet" />
                )}
              </span>
              <span>{step.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function toolCategoryIcon(title: string, detail: string | null) {
  const text = `${title} ${detail ?? ''}`.toLowerCase();
  if (/(bash|shell|cmd|command|run|terminal|exec|komut)/.test(text)) {
    return <TerminalIcon size={13} />;
  }
  if (/(read|write|edit|file|grep|glob|search|diff|patch|dosya)/.test(text)) {
    return <FileCodeIcon size={13} />;
  }
  if (/(chrome|web|http|url|fetch|browser|tab|navigate)/.test(text)) {
    return <GlobeIcon size={13} />;
  }
  return <WrenchIcon size={13} />;
}

function Entry(props: { entry: TranscriptEntry }) {
  const { entry } = props;
  switch (entry.kind) {
    case 'message':
      if (entry.role === 'user') {
        return (
          <div className="msg-user">
            <p className="msg-user-text">{entry.text}</p>
          </div>
        );
      }
      return (
        <div className="msg-assistant">
          <MarkdownView text={entry.text} />
        </div>
      );

    case 'thinking':
      return entry.text ? (
        <details className={`thinking-card ${entry.active ? 'is-active' : ''}`}>
          <summary className="thinking-summary">
            <SparklesIcon size={13} className="thinking-icon" />
            <span>{entry.active ? 'Düşünüyor…' : 'Düşünce süreci'}</span>
          </summary>
          <div className="thinking-body">{entry.text}</div>
        </details>
      ) : null;

    case 'tool': {
      const preview = entry.detail ? entry.detail.split('\n')[0]?.slice(0, 72) : null;
      return (
        <details className={`tool-card is-${entry.status}`}>
          <summary className="tool-summary">
            <span className={`tool-state-icon is-${entry.status}`} aria-hidden="true">
              {entry.status === 'running' ? (
                <span className="spinner xs" />
              ) : entry.status === 'done' ? (
                <CheckIcon size={12} />
              ) : entry.status === 'failed' ? (
                <XIcon size={12} />
              ) : (
                toolCategoryIcon(entry.title, entry.detail)
              )}
            </span>
            <span className="tool-title">{entry.title}</span>
            {preview ? <span className="tool-preview mono">{preview}</span> : null}
          </summary>
          <div className="tool-body">
            {entry.detail ? <pre className="tool-detail mono">{entry.detail}</pre> : null}
            {entry.children.length > 0 ? (
              <div className="tool-children">
                {entry.children.map((child) => (
                  <Entry key={child.id} entry={child} />
                ))}
              </div>
            ) : null}
          </div>
        </details>
      );
    }

    case 'notice':
      return <p className={`chat-notice is-${entry.tone}`}>{entry.text}</p>;
  }
}

function PermissionCard(props: {
  permission: PermissionView;
  onChoose: (optionId: string) => void;
}) {
  const { permission } = props;
  return (
    <section className="permission-sheet" role="alertdialog" aria-label="İzin isteği">
      <div className="permission-head">
        <ShieldAlertIcon size={16} className="icon-warn" />
        <strong className="permission-title">{permission.title}</strong>
      </div>
      {permission.detail ? <pre className="permission-code mono">{permission.detail}</pre> : null}
      <div className="permission-actions">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={option.allow ? 'btn btn-primary' : 'btn btn-danger-outline'}
            onClick={() => props.onChoose(option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </section>
  );
}
