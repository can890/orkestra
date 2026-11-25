import { Badge, Button, toast } from '@orkestra/ui/react/primitives';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Compass,
  FileDiff,
  LoaderCircle,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  buildHeuristicReviewGuide,
  parseLlmReviewGuide,
  type ReviewGuide,
  type ReviewGuideFileInput,
  type ReviewGuideRiskLevel,
} from '@core/features/code-review/api/review-guide';
import { getTextGenerationClient } from '@core/features/text-generation/api/browser/client';

interface ReviewGuideDrawerProps {
  open: boolean;
  onClose: () => void;
  files: ReviewGuideFileInput[];
  activeFilePath?: string;
  onSelectFile: (filePath: string) => void;
}

const RISK_LABEL: Record<ReviewGuideRiskLevel, string> = {
  high: 'Yüksek Etki',
  medium: 'Orta Etki',
  low: 'Düşük Etki',
};

const RISK_TONE: Record<ReviewGuideRiskLevel, 'error' | 'warning' | 'neutral'> = {
  high: 'error',
  medium: 'warning',
  low: 'neutral',
};

export function ReviewGuideDrawer({
  open,
  onClose,
  files,
  activeFilePath,
  onSelectFile,
}: ReviewGuideDrawerProps) {
  const heuristicGuide = useMemo(() => buildHeuristicReviewGuide(files), [files]);
  const [llmGuide, setLlmGuide] = useState<ReviewGuide | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(() => new Set());
  const [enriching, setEnriching] = useState(false);

  const fileSignature = useMemo(
    () =>
      files
        .map((f) => f.path)
        .sort()
        .join('|'),
    [files]
  );

  useEffect(() => {
    setLlmGuide(null);
    setStepIndex(0);
  }, [fileSignature]);

  if (!open) return null;

  const guide = llmGuide ?? heuristicGuide;
  const clampedIndex = Math.min(Math.max(stepIndex, 0), Math.max(guide.steps.length - 1, 0));
  const currentStep = guide.steps[clampedIndex];
  const reviewedCount = files.filter((f) => reviewedFiles.has(f.path)).length;
  const progressPercent =
    guide.totalFiles > 0 ? Math.round((reviewedCount / guide.totalFiles) * 100) : 0;

  const toggleReviewed = (filePath: string) => {
    setReviewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const handleEnrichWithAi = async () => {
    if (files.length === 0) return;
    setEnriching(true);
    try {
      const client = await getTextGenerationClient();
      const status = await client.getStatus();
      if (!status.enabled || !status.hasApiKey) {
        toast('Text Generator API etkin değil', {
          description:
            'Yapay zekâ inceleme özeti için Ayarlar → General → Text Generator API bölümünü etkinleştirin.',
        });
        return;
      }
      const fileLines = files
        .slice(0, 60)
        .map(
          (f) =>
            `- ${f.path} (${f.status ?? 'modified'}${
              f.additions !== undefined || f.deletions !== undefined
                ? `, +${f.additions ?? 0}/-${f.deletions ?? 0}`
                : ''
            })`
        )
        .join('\n');
      const res = await client.generateText({
        systemPrompt:
          'Değişen dosyaları mantıklı bir kod inceleme sırasına göre gruplayan Türkçe bir JSON rehberi döndür. Şema: {"summary":"...","steps":[{"category":"contracts|core|ui|tests|config","title":"...","summary":"...","files":["..."],"riskLevel":"low|medium|high"}]}. Yalnızca JSON döndür.',
        prompt: `Değişen dosyalar:\n${fileLines}`,
        maxTokens: 1200,
        temperature: 0.2,
      });
      if (!res.success) {
        toast.error('İnceleme turu oluşturulamadı', { description: res.error.message });
        return;
      }
      const parsed = parseLlmReviewGuide(
        res.data.text,
        files.map((f) => f.path)
      );
      if (!parsed) {
        toast.error('Yapay zekâ yanıtı ayrıştırılamadı');
        return;
      }
      setLlmGuide(parsed);
      setStepIndex(0);
      toast.success('AI İnceleme Turu güncellendi');
    } finally {
      setEnriching(false);
    }
  };

  return (
    <div
      className="fixed top-20 right-4 z-40 flex max-h-[75vh] w-96 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
      role="dialog"
      aria-label="İnceleme Turu"
    >
      <div className="flex items-center justify-between border-b border-border bg-(--em-surface) px-3 py-2">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 text-blue-400" />
          <span className="text-xs font-semibold text-foreground">İnceleme Turu</span>
          <Badge variant="soft" tone={guide.source === 'llm' ? 'info' : 'neutral'}>
            {guide.source === 'llm' ? 'AI' : 'Otomatik'}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={enriching || files.length === 0}
            onClick={() => void handleEnrichWithAi()}
          >
            {enriching ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            AI ile Zenginleştir
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon
            onClick={onClose}
            aria-label="İnceleme Turunu kapat"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="border-b border-border px-3 py-2">
        <div className="text-muted-foreground flex items-center justify-between text-[11px]">
          <span>
            {reviewedCount} / {guide.totalFiles} dosya incelendi
          </span>
          <span>%{progressPercent}</span>
        </div>
        <div className="bg-muted mt-1 h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <p className="text-muted-foreground mt-1.5 text-[11px]">{guide.summary}</p>
      </div>

      {guide.steps.length === 0 || !currentStep ? (
        <div className="text-muted-foreground px-4 py-8 text-center text-xs">
          Bu görevde incelenecek aktif değişiklik bulunmuyor.
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">{currentStep.title}</div>
                <p className="text-muted-foreground mt-0.5 text-[11px]">{currentStep.summary}</p>
              </div>
              <Badge variant="soft" tone={RISK_TONE[currentStep.riskLevel]}>
                {RISK_LABEL[currentStep.riskLevel]}
              </Badge>
            </div>

            <div className="mt-2.5 space-y-1">
              {currentStep.files.map((filePath) => {
                const isReviewed = reviewedFiles.has(filePath);
                const isActive = activeFilePath === filePath;
                return (
                  <div
                    key={filePath}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                      isActive
                        ? 'border-blue-500/40 bg-blue-500/10'
                        : 'border-border/60 bg-(--em-surface)'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleReviewed(filePath)}
                      className="text-muted-foreground shrink-0 hover:text-emerald-500"
                      title={
                        isReviewed ? 'İncelenmedi olarak işaretle' : 'İncelendi olarak işaretle'
                      }
                    >
                      {isReviewed ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Circle className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectFile(filePath)}
                      className={`flex min-w-0 flex-1 items-center gap-1.5 text-left hover:underline ${
                        isReviewed ? 'text-muted-foreground line-through' : 'text-foreground'
                      }`}
                      title={filePath}
                    >
                      <FileDiff className="text-muted-foreground h-3 w-3 shrink-0" />
                      <span className="truncate font-mono text-[11px]">{filePath}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border bg-(--em-surface) px-3 py-2">
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={clampedIndex <= 0}
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Önceki Adım
            </Button>
            <span className="text-muted-foreground text-[11px]">
              Adım {clampedIndex + 1} / {guide.steps.length}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={clampedIndex >= guide.steps.length - 1}
              onClick={() => setStepIndex((i) => Math.min(guide.steps.length - 1, i + 1))}
            >
              Sonraki Adım
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
