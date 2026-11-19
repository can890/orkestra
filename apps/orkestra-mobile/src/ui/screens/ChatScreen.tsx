import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { openConversation, type ConversationHandle } from '@/core/conversation-session';
import type { PermissionView, TranscriptEntry } from '@/core/mappers';
import { splitCodeBlocks } from '@/core/text-blocks';
import type { RemoteApi } from '@/core/wire-client';
import { ErrorNote, Header } from '../components';

export function ChatScreen(props: {
  api: RemoteApi;
  conversationId: string;
  title: string;
  providerId: string;
  back: () => void;
}) {
  // Oturum efektte açılıp kapatılır (StrictMode çift çalıştırmasına dayanıklı).
  const [handle, setHandle] = useState<ConversationHandle | null>(null);
  useEffect(() => {
    const opened = openConversation(props.api, props.conversationId);
    setHandle(opened);
    return () => {
      opened.dispose();
      setHandle(null);
    };
  }, [props.api, props.conversationId]);
  if (!handle) {
    return (
      <main className="screen chat">
        <Header title={props.title} subtitle={props.providerId} onBack={props.back} />
      </main>
    );
  }
  return (
    <ChatView handle={handle} title={props.title} providerId={props.providerId} back={props.back} />
  );
}

function ChatView(props: {
  handle: ConversationHandle;
  title: string;
  providerId: string;
  back: () => void;
}) {
  const { handle } = props;
  const view = useSyncExternalStore(handle.subscribe, handle.getState, handle.getState);

  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [view.entries, view.pending, view.session?.permissions.length]);

  const session = view.session;
  const canCancel = session?.canCancel === true || session?.isGenerating === true;
  const subtitle = !session
    ? props.providerId
    : session.lifecycle === 'working' || session.isGenerating
      ? 'Ajan çalışıyor…'
      : session.lifecycle === 'cancelling'
        ? 'İptal ediliyor…'
        : session.lifecycle === 'closed'
          ? 'Oturum kapalı'
          : props.providerId;

  async function send(): Promise<void> {
    const text = draft;
    if (text.trim() === '') return;
    setDraft('');
    stick.current = true;
    const accepted = await handle.send(text);
    if (!accepted) setDraft(text);
  }

  return (
    <main className="screen chat">
      <Header title={props.title} subtitle={subtitle} onBack={props.back} />
      <div
        className="transcript"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {view.phase === 'loading' ? <p className="empty">Sohbet yükleniyor…</p> : null}
        {view.phase === 'error' ? <ErrorNote message={view.error} /> : null}
        {view.hasOlder ? (
          <button
            className="button small center"
            disabled={view.loadingOlder}
            onClick={() => void handle.loadOlder()}
          >
            {view.loadingOlder ? 'Yükleniyor…' : 'Daha eski mesajlar'}
          </button>
        ) : null}
        {view.entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
        {view.pending.map((item) => (
          <div key={item.promptId} className="bubble user pending">
            <Text text={item.text} />
            <div className="bubble-meta">
              {item.state === 'failed' ? (
                <>
                  <span className="error-inline">{item.error ?? 'Gönderilemedi'}</span>
                  <button className="link" onClick={() => void handle.retry(item.promptId)}>
                    Tekrar dene
                  </button>
                  <button className="link" onClick={() => handle.dismissPending(item.promptId)}>
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
        {session?.suspended ? (
          <p className="hint center">Oturum askıda; mesaj gönderince masaüstünde uyandırılır.</p>
        ) : null}
      </div>

      {session?.permissions.map((permission) => (
        <PermissionCard
          key={permission.requestId}
          permission={permission}
          onChoose={(optionId) => void handle.resolvePermission(permission.requestId, optionId)}
        />
      ))}
      {view.actionError ? (
        <div className="banner banner-error" role="alert">
          <span>{view.actionError}</span>
          <button className="button small" onClick={() => handle.dismissActionError()}>
            Tamam
          </button>
        </div>
      ) : null}

      <div className="composer">
        <textarea
          className="textarea"
          rows={1}
          value={draft}
          placeholder={session?.queuedCount ? `${session.queuedCount} mesaj sırada` : 'Mesaj yazın'}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Mesaj"
        />
        {canCancel ? (
          <button className="button danger" onClick={() => void handle.cancel()}>
            Durdur
          </button>
        ) : null}
        <button
          className="button primary"
          disabled={draft.trim() === '' || view.phase !== 'ready'}
          onClick={() => void send()}
        >
          Gönder
        </button>
      </div>
    </main>
  );
}

function Text(props: { text: string }) {
  return (
    <>
      {splitCodeBlocks(props.text).map((block, index) =>
        block.type === 'code' ? (
          <pre key={index} className="code">
            <code>{block.code}</code>
          </pre>
        ) : (
          <p key={index} className="text">
            {block.text}
          </p>
        )
      )}
    </>
  );
}

function Entry(props: { entry: TranscriptEntry }) {
  const { entry } = props;
  switch (entry.kind) {
    case 'message':
      return (
        <div className={`bubble ${entry.role}`}>
          <Text text={entry.text} />
        </div>
      );
    case 'thinking':
      return entry.text ? (
        <details className="note">
          <summary>{entry.active ? 'Düşünüyor…' : 'Düşünce'}</summary>
          <p className="text">{entry.text}</p>
        </details>
      ) : null;
    case 'tool':
      return (
        <details className="note tool">
          <summary>
            <span className={`dot dot-${entry.status}`} aria-hidden="true" /> {entry.title}
          </summary>
          {entry.detail ? <pre className="code">{entry.detail}</pre> : null}
          {entry.children.map((child) => (
            <Entry key={child.id} entry={child} />
          ))}
        </details>
      );
    case 'notice':
      return <p className={`notice ${entry.tone}`}>{entry.text}</p>;
  }
}

function PermissionCard(props: {
  permission: PermissionView;
  onChoose: (optionId: string) => void;
}) {
  const { permission } = props;
  return (
    <section className="permission" role="alertdialog" aria-label="İzin isteği">
      <strong>{permission.title}</strong>
      {permission.detail ? <pre className="code">{permission.detail}</pre> : null}
      <div className="row wrap">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            className={option.allow ? 'button primary' : 'button danger'}
            onClick={() => props.onChoose(option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </section>
  );
}
