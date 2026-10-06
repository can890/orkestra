import type {
  FindingSeverity,
  ReviewFocus,
  ReviewScope,
  ReviewVerdict,
} from '@core/features/code-review/api/review-model';

/** Kod incelemesi arayüzünün Türkçe etiketleri. */

export const SCOPE_LABELS: Record<ReviewScope, string> = {
  uncommitted: 'Commit edilmemiş değişiklikler',
  branch: 'Dal ↔ temel dal',
  'last-commit': 'Son commit',
};

export const FOCUS_LABELS: Record<ReviewFocus, string> = {
  correctness: 'Doğruluk',
  security: 'Güvenlik',
  simplification: 'Sadeleştirme',
};

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  critical: 'Kritik',
  high: 'Yüksek',
  medium: 'Orta',
  low: 'Düşük',
};

export const SEVERITY_TONES: Record<FindingSeverity, 'error' | 'warning' | 'info' | 'neutral'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'neutral',
};

export const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: 'Onaylandı',
  comment: 'Yorumlarla onay',
  'request-changes': 'Değişiklik isteniyor',
};

export const VERDICT_TONES: Record<ReviewVerdict, 'success' | 'warning' | 'error'> = {
  approve: 'success',
  comment: 'warning',
  'request-changes': 'error',
};
