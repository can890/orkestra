import { redactAll } from '@orkestra/shared/logger';
import type { LogHealthGroup, LogHealthReport } from './contract';

const LEVEL_LABELS: Record<LogHealthGroup['level'], string> = {
  warn: 'UYARI',
  error: 'HATA',
  fatal: 'ÖLÜMCÜL',
};

export function logHealthLevelLabel(level: LogHealthGroup['level']): string {
  return LEVEL_LABELS[level];
}

/**
 * Hata raporlarına eklenecek düz metin özet üretir. Gruplar zaten maskelenmiş
 * gelir; yine de çıktının tamamı son bir kez `redactAll` taramasından geçer.
 */
export function formatLogHealthSummary(
  groups: readonly LogHealthGroup[],
  report: Pick<LogHealthReport, 'logFilePath' | 'windowDays'>,
  generatedAt: Date = new Date()
): string {
  const lines: string[] = [
    'Orkestra günlük sağlığı özeti',
    `Oluşturulma: ${generatedAt.toISOString()}`,
    `Pencere: son ${report.windowDays} gün · ${groups.length} grup`,
  ];
  if (report.logFilePath) lines.push(`Günlük dosyası: ${report.logFilePath}`);

  groups.forEach((group, index) => {
    lines.push('', `${index + 1}. [${LEVEL_LABELS[group.level]}] ${group.template}`);
    if (group.errorSignature) lines.push(`   Hata: ${group.errorSignature}`);
    lines.push(
      `   Sayı: ${group.count} (bu oturumda ${group.sessionCount}, ${group.launchCount} açılış, ${group.dayCount} gün)`,
      `   İlk: ${new Date(group.firstSeen).toISOString()} · Son: ${new Date(group.lastSeen).toISOString()}`
    );
    if (group.processes.length > 0) lines.push(`   Süreçler: ${group.processes.join(', ')}`);
    const example = group.example;
    lines.push(`   Örnek: ${example.message}`);
    if (example.errorName || example.errorMessage) {
      lines.push(
        `   Örnek hata: ${[example.errorName, example.errorMessage].filter(Boolean).join(': ')}`
      );
    }
    if (example.stack) {
      lines.push('   Yığın:', ...example.stack.split('\n').map((line) => `     ${line.trim()}`));
    }
    if (example.fields) {
      lines.push('   Alanlar:', ...example.fields.split('\n').map((line) => `     ${line}`));
    }
  });

  return redactAll(lines.join('\n'));
}
