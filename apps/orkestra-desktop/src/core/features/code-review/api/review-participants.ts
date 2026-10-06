import { isReviewConversationTitle } from './review-prompt';

/**
 * İncelemeye katılan konuşmaları seçen saf yardımcılar: görevin "ana" konuşması (düzeltme
 * isteklerinin gideceği yer) ve varsayılan inceleyici (mümkünse ana konuşmadan farklı bir
 * sağlayıcı/model).
 */

export type ConversationLike = Readonly<{
  id: string;
  title: string;
  providerId: string;
  model?: string | null;
  type?: 'pty' | 'acp';
  isInitialConversation?: boolean | null;
  lastInteractedAt?: string | null;
}>;

/** Orkestra işçi konuşmaları "🎼" ile başlar; ana konuşma sayılmazlar. */
export function isOrchestraWorkerTitle(title: string): boolean {
  return title.trimStart().startsWith('🎼');
}

/** İnceleme ya da Orkestra işçisi olmayan, kullanıcının yürüttüğü konuşma mı. */
export function isPrimaryConversation(conversation: ConversationLike): boolean {
  return (
    !isReviewConversationTitle(conversation.title) && !isOrchestraWorkerTitle(conversation.title)
  );
}

function interactedAt(conversation: ConversationLike): number {
  const parsed = conversation.lastInteractedAt ? Date.parse(conversation.lastInteractedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Düzeltme isteğinin gönderilebileceği konuşmalar, en uygun aday başta. */
export function rankMainConversationCandidates<T extends ConversationLike>(
  conversations: readonly T[]
): T[] {
  return conversations.filter(isPrimaryConversation).sort((left, right) => {
    const acp = Number(right.type === 'acp') - Number(left.type === 'acp');
    if (acp !== 0) return acp;
    const initial =
      Number(right.isInitialConversation === true) - Number(left.isInitialConversation === true);
    if (initial !== 0) return initial;
    return interactedAt(right) - interactedAt(left);
  });
}

export function pickMainConversation<T extends ConversationLike>(
  conversations: readonly T[]
): T | null {
  return rankMainConversationCandidates(conversations)[0] ?? null;
}

export type ReviewerCandidate = Readonly<{
  providerId: string;
  /** Sağlayıcının seçilebilir model kimlikleri (sıralı); seçim yoksa boş. */
  models: readonly string[];
}>;

export type ReviewerChoice = Readonly<{ providerId: string; model: string | null }>;

/**
 * Varsayılan inceleyiciyi seçer: önce ana konuşmadan farklı bir sağlayıcı, yoksa aynı
 * sağlayıcının farklı bir modeli, o da yoksa aynı sağlayıcı. Aday yoksa null.
 */
export function pickDefaultReviewer(
  candidates: readonly ReviewerCandidate[],
  main: Readonly<{ providerId: string | null; model: string | null }> | null
): ReviewerChoice | null {
  if (candidates.length === 0) return null;
  const mainProvider = main?.providerId ?? null;
  const other = candidates.find((candidate) => candidate.providerId !== mainProvider);
  if (other) return { providerId: other.providerId, model: null };
  const same = candidates[0]!;
  const differentModel = same.models.find((model) => model !== (main?.model ?? null));
  return {
    providerId: same.providerId,
    model: main?.model && differentModel ? differentModel : null,
  };
}
