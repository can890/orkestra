// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/components/settings/browserImportWizard.logic.ts
//
// Tarayıcıdan içe aktarma penceresinin saf (UI'dan bağımsız) adım mantığı.
import type {
  BrowserImportFailureReason,
  BrowserImportResult,
  BrowserImportSource,
  BrowserImportSummary,
} from '@core/features/browser/api/browser-import';

export type BrowserImportStep =
  | { step: 'loading' }
  | { step: 'configure' }
  | { step: 'importing' }
  | { step: 'done'; summary: BrowserImportSummary; targetProfileName: string }
  | { step: 'failed'; reason: BrowserImportFailureReason };

/** Seçilebilecek ilk kaynak: içe aktarmaya hazır olan, yoksa izin/kapatma bekleyen. */
export function preferredSourceId(sources: readonly BrowserImportSource[]): string | undefined {
  return (
    sources.find((source) => source.unavailable === undefined)?.id ??
    sources.find(
      (source) =>
        source.unavailable === 'needsFullDiskAccess' || source.unavailable === 'browserRunning'
    )?.id
  );
}

/** Kullanıcının seçebileceği (kurulu) kaynaklar; kurulu olmayanlar listelenmez. */
export function selectableSources(sources: readonly BrowserImportSource[]): BrowserImportSource[] {
  return sources.filter(
    (source) =>
      source.unavailable !== 'notInstalled' && source.unavailable !== 'unsupportedPlatform'
  );
}

export function outcomeToStep(
  result: BrowserImportResult,
  targetProfileName: string
): BrowserImportStep {
  return result.success
    ? { step: 'done', summary: result.summary, targetProfileName }
    : { step: 'failed', reason: result.reason };
}

export function canStartImport(input: {
  source: BrowserImportSource | undefined;
  sourceProfileDirectory: string;
  target: { kind: 'existing'; profileId: string } | { kind: 'new'; name: string };
}): boolean {
  if (!input.source || input.source.unavailable !== undefined) return false;
  if (
    !input.source.profiles.some((profile) => profile.directory === input.sourceProfileDirectory)
  ) {
    return false;
  }
  return input.target.kind === 'existing'
    ? input.target.profileId.length > 0
    : input.target.name.trim().length > 0;
}

/** Özet satırları: yalnızca sayılar; çerez adı ya da değeri gösterilmez. */
export function summaryLines(summary: BrowserImportSummary): string[] {
  const lines = [`Imported ${summary.imported} cookies.`];
  if (summary.skippedExpired > 0) lines.push(`Skipped ${summary.skippedExpired} expired cookies.`);
  if (summary.skippedPartitioned > 0) {
    lines.push(`Skipped ${summary.skippedPartitioned} partitioned or container cookies.`);
  }
  if (summary.skippedUndecryptable > 0) {
    lines.push(`Skipped ${summary.skippedUndecryptable} cookies that could not be decrypted.`);
  }
  if (summary.skippedRejected > 0) {
    lines.push(`Skipped ${summary.skippedRejected} cookies the browser rejected.`);
  }
  return lines;
}
