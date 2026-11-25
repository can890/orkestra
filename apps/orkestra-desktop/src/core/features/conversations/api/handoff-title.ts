/**
 * Devir, çatal ve bağlam devriyle açılan sohbetlerin başlıkları: "<kaynak başlığı> (devam)".
 * Saf modüldür; hem renderer (yeni sohbetin başlığı) hem ana süreç (ajanın oturum başlığının bu
 * başlığı ezmemesi) kullanır.
 */
import { MAX_CONVERSATION_TITLE_LENGTH } from '@core/primitives/conversations/api';
import type { HandoffMode } from './handoff-schemas';

const LINEAGE_LABELS = ['devam', 'çatal', 'devir'] as const;
type LineageLabel = (typeof LINEAGE_LABELS)[number];

function lineageLabel(mode: HandoffMode): LineageLabel {
  if (mode === 'fork') return 'çatal';
  if (mode === 'context-handoff') return 'devam';
  return 'devir';
}

/** Sondaki " (devam)", " (devam 2)" … ekini ayırır. */
const LINEAGE_SUFFIX = new RegExp(
  `^(.*?)\\s\\((${LINEAGE_LABELS.join('|')})(?: ([1-9]\\d{0,3}))?\\)$`,
  'su'
);

function parseLineageSuffix(
  title: string
): { base: string; label: LineageLabel; index: number } | null {
  const match = LINEAGE_SUFFIX.exec(title.trim());
  if (!match) return null;
  return {
    base: match[1] ?? '',
    label: match[2] as LineageLabel,
    index: match[3] ? Number(match[3]) : 1,
  };
}

/**
 * Yeni sohbetin başlığı. Kaynak zaten aynı kiple açılmışsa ek çoğaltılmaz, numaralanır:
 * "Hata" → "Hata (devam)" → "Hata (devam 2)" → "Hata (devam 3)".
 */
export function handoffTitle(sourceTitle: string, mode: HandoffMode): string {
  const label = lineageLabel(mode);
  let base = sourceTitle.trim() || 'Sohbet';
  let index = 1;
  const parsed = parseLineageSuffix(base);
  if (parsed && parsed.label === label && parsed.base.trim()) {
    base = parsed.base.trim();
    index = parsed.index + 1;
  }
  const suffix = index === 1 ? ` (${label})` : ` (${label} ${index})`;
  return base.slice(0, Math.max(0, MAX_CONVERSATION_TITLE_LENGTH - suffix.length)) + suffix;
}

/**
 * Başlık bir devir/çatal/bağlam devri başlığı mı ("… (devam)", "… (çatal 2)")? Böyle bir başlık
 * kaynağa göre bilerek verilmiştir; ajanın ilk istemden türettiği oturum başlığı onu ezmemelidir.
 */
export function isHandoffLineageTitle(title: string | null | undefined): boolean {
  return parseLineageSuffix(title ?? '') !== null;
}
