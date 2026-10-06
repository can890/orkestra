import { Badge, Button, Checkbox, Select, toast } from '@orkestra/ui/react/primitives';
import { ChevronDown, ChevronRight, FileCode, ListChecks, Wrench, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildFixPrompt } from '@core/features/code-review/api/fix-prompt';
import type { ReviewFinding } from '@core/features/code-review/api/review-model';
import { rankMainConversationCandidates } from '@core/features/code-review/api/review-participants';
import { isReviewConversationTitle } from '@core/features/code-review/api/review-prompt';
import {
  findLatestReviewReport,
  type LocatedReviewReport,
  type ReviewTurnLike,
} from '@core/features/code-review/api/review-transcript';
import {
  SEVERITY_LABELS,
  SEVERITY_TONES,
  VERDICT_LABELS,
  VERDICT_TONES,
} from '@core/features/code-review/browser/review-labels';
import { sendFollowUpPrompt } from '@core/features/code-review/browser/start-code-review';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { openFileInAdjacentPane } from '@core/features/editor/api/browser/open-file-in-file-editor';

/** Transcript her bu kadar milisaniyede bir yeniden okunur (canlı akış MobX'e bağlı değildir). */
const POLL_MS = 1500;
const REVIEWER_TARGET = '__reviewer__';

export type ReviewTranscriptSnapshot = Readonly<{
  turns: readonly ReviewTurnLike[];
  activeTurnId: string | null;
}>;

type PanelProps = Readonly<{
  projectId: string;
  taskId: string;
  conversationId: string;
  isWorking: boolean;
  readTranscript: () => ReviewTranscriptSnapshot;
}>;

function locationLabel(finding: ReviewFinding): string {
  if (!finding.file) return finding.location ?? '';
  if (finding.line === null) return finding.file;
  return `${finding.file}:${finding.line}${finding.endLine ? `-${finding.endLine}` : ''}`;
}

function reportSignature(located: LocatedReviewReport | null): string {
  if (!located) return '';
  const { report } = located;
  return [
    located.turnId,
    located.settled,
    report.verdict,
    report.noFindings,
    report.verdictRationale,
    ...report.findings.map((finding) => finding.id),
  ].join('|');
}

/** Son yapılandırılmış raporu transcript'ten periyodik olarak okur; değişmediyse yeniden çizmez. */
function useLatestReport(readTranscript: () => ReviewTranscriptSnapshot) {
  const readRef = useRef(readTranscript);
  readRef.current = readTranscript;
  const [located, setLocated] = useState<LocatedReviewReport | null>(null);
  const signatureRef = useRef('');
  useEffect(() => {
    const tick = () => {
      const snapshot = readRef.current();
      const next = findLatestReviewReport(snapshot.turns, { activeTurnId: snapshot.activeTurnId });
      const signature = reportSignature(next);
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;
      setLocated(next);
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
  return located;
}

function FindingRow({
  finding,
  selected,
  onSelect,
  onOpen,
}: {
  finding: ReviewFinding;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(finding.failureScenario || finding.suggestedFix);
  return (
    <li className="border-b border-border px-3 py-2">
      <div className="flex items-start gap-2">
        <Checkbox
          className="mt-0.5"
          checked={selected}
          onCheckedChange={(checked) => onSelect(checked === true)}
          aria-label={`Bulgu ${finding.index} seç`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge tone={SEVERITY_TONES[finding.severity]}>
              {SEVERITY_LABELS[finding.severity]}
            </Badge>
            {finding.file ? (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 text-xs text-foreground-muted hover:text-foreground hover:underline"
                title="Dosyayı satırında aç"
                onClick={onOpen}
              >
                <FileCode className="size-3 shrink-0" />
                <span className="truncate">{locationLabel(finding)}</span>
              </button>
            ) : finding.location ? (
              <span className="truncate text-xs text-foreground-muted">{finding.location}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="mt-1 flex w-full items-start gap-1 text-left text-sm text-foreground"
            onClick={() => hasDetails && setExpanded((value) => !value)}
            aria-expanded={hasDetails ? expanded : undefined}
          >
            {hasDetails ? (
              expanded ? (
                <ChevronDown className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <ChevronRight className="mt-0.5 size-3.5 shrink-0" />
              )
            ) : null}
            <span>{finding.summary}</span>
          </button>
          {expanded ? (
            <div className="mt-1 flex flex-col gap-1.5 pl-4 text-xs text-foreground-muted">
              {finding.failureScenario ? (
                <div>
                  <div className="font-medium text-foreground">Hata senaryosu</div>
                  <p className="whitespace-pre-wrap">{finding.failureScenario}</p>
                </div>
              ) : null}
              {finding.suggestedFix ? (
                <div>
                  <div className="font-medium text-foreground">Önerilen düzeltme</div>
                  <p className="whitespace-pre-wrap">{finding.suggestedFix}</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * İnceleme konuşmasının yanında gösterilen bulgu paneli: önem rozetleri, satırında dosya açma ve
 * seçili bulguların düzeltilmesini ana konuşmadan (ya da inceleyiciden) isteme.
 */
export const ReviewFindingsPanel = observer(function ReviewFindingsPanel({
  projectId,
  taskId,
  conversationId,
  isWorking,
  readTranscript,
  onClose,
}: PanelProps & { onClose: () => void }) {
  const located = useLatestReport(readTranscript);
  const report = located?.report ?? null;
  const manager = conversationRegistry.get(taskId);
  const reviewTitle = manager?.conversations.get(conversationId)?.data.title ?? null;
  const targets = rankMainConversationCandidates(
    Array.from(manager?.conversations.values() ?? [], (conversation) => conversation.data)
  );

  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const turnId = located?.turnId ?? null;
  useEffect(() => {
    setSelection({});
  }, [turnId]);

  const findings = useMemo(() => report?.findings ?? [], [report]);
  // Varsayılan seçim: düşük önemli olanlar dışındaki tüm bulgular.
  const isSelected = (finding: ReviewFinding) =>
    selection[finding.id] ?? finding.severity !== 'low';
  const selected = findings.filter(isSelected);
  const allSelected = findings.length > 0 && selected.length === findings.length;
  const targetId =
    target && (target === REVIEWER_TARGET || targets.some((item) => item.id === target))
      ? target
      : (targets[0]?.id ?? REVIEWER_TARGET);
  const targetLabel = (id: string) =>
    id === REVIEWER_TARGET
      ? 'İnceleyici (bu konuşma)'
      : (targets.find((item) => item.id === id)?.title ?? id);

  const requestFix = async () => {
    if (selected.length === 0 || sending) return;
    const toReviewer = targetId === REVIEWER_TARGET;
    const prompt = buildFixPrompt(selected, {
      target: toReviewer ? 'reviewer' : 'main',
      reviewTitle,
    });
    setSending(true);
    try {
      const delivery = await sendFollowUpPrompt(
        projectId,
        taskId,
        toReviewer ? conversationId : targetId,
        prompt
      );
      if (delivery === 'copied') {
        toast('Düzeltme istemi panoya kopyalandı', {
          description: 'Bu konuşma sohbet arayüzü kullanmıyor; istemi terminale yapıştırın.',
        });
      } else {
        toast(`${selected.length} bulgu için düzeltme istendi`);
      }
    } catch (error) {
      toast.error('Düzeltme istenemedi', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <aside
      className="flex h-full w-[360px] max-w-[45%] min-w-[260px] shrink-0 flex-col border-l border-border bg-(--em-surface)"
      aria-label="İnceleme bulguları"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-sm text-foreground">İnceleme bulguları</span>
        {report?.verdict ? (
          <Badge tone={VERDICT_TONES[report.verdict]}>{VERDICT_LABELS[report.verdict]}</Badge>
        ) : null}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          icon
          aria-label="Paneli kapat"
          title="Paneli kapat"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {isWorking || (located !== null && !located.settled) ? (
        <div
          role="status"
          className="border-b border-border px-3 py-1.5 text-xs text-foreground-muted"
        >
          İnceleme sürüyor…
        </div>
      ) : null}
      {report?.verdictRationale ? (
        <p className="border-b border-border px-3 py-2 text-xs text-foreground-muted">
          {report.verdictRationale}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {findings.length > 0 ? (
          <ul>
            {findings.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                selected={isSelected(finding)}
                onSelect={(value) =>
                  setSelection((current) => ({ ...current, [finding.id]: value }))
                }
                onOpen={() => {
                  if (!finding.file) return;
                  void openFileInAdjacentPane(
                    projectId,
                    taskId,
                    finding.file,
                    finding.line !== null ? { line: finding.line } : {}
                  );
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-center text-xs text-foreground-muted">
            {report?.noFindings
              ? 'İnceleyici bir sorun bulmadı.'
              : isWorking
                ? 'Bulgular inceleme bitince burada listelenecek.'
                : 'Bu konuşmada henüz yapılandırılmış bir inceleme raporu yok.'}
          </p>
        )}
      </div>
      {findings.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border p-2">
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() =>
                setSelection(
                  Object.fromEntries(findings.map((finding) => [finding.id, !allSelected]))
                )
              }
            >
              {allSelected ? 'Seçimi kaldır' : 'Tümünü seç'}
            </Button>
            <Select.Root
              value={targetId}
              onValueChange={(value) => {
                if (value) setTarget(value);
              }}
            >
              <Select.Trigger appearance="input" className="max-w-[60%] text-xs">
                <Select.Value>{targetLabel(targetId)}</Select.Value>
              </Select.Trigger>
              <Select.Content align="end">
                {targets.map((item) => (
                  <Select.Item key={item.id} value={item.id}>
                    {item.title}
                  </Select.Item>
                ))}
                <Select.Item value={REVIEWER_TARGET}>İnceleyici (bu konuşma)</Select.Item>
              </Select.Content>
            </Select.Root>
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={selected.length === 0 || sending}
            onClick={() => void requestFix()}
          >
            <Wrench className="size-3.5" />
            {sending ? 'Gönderiliyor…' : `Düzeltmesini iste (${selected.length})`}
          </Button>
        </div>
      ) : null}
    </aside>
  );
});

/**
 * Sohbet panelinin yerleştirdiği giriş noktası: konuşma bir inceleme konuşmasıysa bulgu
 * panelini (kapatıldıysa yeniden açma düğmesini) gösterir, değilse hiçbir şey çizmez.
 */
export const ReviewFindingsSidePanel = observer(function ReviewFindingsSidePanel(
  props: PanelProps
) {
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const title = conversationRegistry.get(props.taskId)?.conversations.get(props.conversationId)
    ?.data.title;
  if (!isReviewConversationTitle(title)) return null;
  if (closedFor === props.conversationId) {
    return (
      <div className="flex shrink-0 flex-col border-l border-border bg-(--em-surface) p-1">
        <Button
          variant="ghost"
          size="xs"
          icon
          aria-label="İnceleme bulgularını göster"
          title="İnceleme bulgularını göster"
          onClick={() => setClosedFor(null)}
        >
          <ListChecks className="size-3.5" />
        </Button>
      </div>
    );
  }
  return (
    <ReviewFindingsPanel
      key={props.conversationId}
      {...props}
      onClose={() => setClosedFor(props.conversationId)}
    />
  );
});
