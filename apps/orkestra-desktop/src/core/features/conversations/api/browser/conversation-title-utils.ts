import type { AgentProviderId } from '@orkestra/plugins/agents/types';
import {
  agentDisplayName,
  isCustomAcpProviderId,
} from '@core/features/agents/api/browser/agent-display-names';
import { parseDefaultConversationTitleIndex } from '@core/features/conversations/api/default-conversation-title';

type ConversationTitleInput = {
  providerId: AgentProviderId;
  title: string;
};

function capitalizeProviderId(providerId: AgentProviderId): string {
  return `${providerId.charAt(0).toUpperCase()}${providerId.slice(1)}`;
}

/**
 * Varsayılan başlıklarda gösterilen sağlayıcı adı. Kullanıcı ACP ajanlarının kimliği adlarından
 * türetilmiş bir slug'dır ("acp-local-hizli-ajan"); bunlar için kayıtlı ad ("Hızlı Ajan")
 * kullanılır. Yerleşik ajanlar alışılmış "Claude (1)" biçimini korur.
 */
export function providerTitleLabel(providerId: AgentProviderId): string {
  if (isCustomAcpProviderId(providerId)) {
    const name = agentDisplayName(providerId);
    if (name) return name;
  }
  return capitalizeProviderId(providerId);
}

// Kayıtlı başlığın başındaki kullanıcı ACP ajanı varsayılan başlığı ("Acp-local-x (1)"); devir
// başlıklarında ardından " (devam)" gibi bir ek gelebilir.
const LEADING_CUSTOM_DEFAULT_TITLE = /^(acp-[a-z0-9-]+) \(([1-9]\d*)\)(?=$|\s)/iu;

/**
 * Başlığın başında bir kullanıcı ACP ajanının kimlikten türemiş varsayılan başlığı varsa onu
 * ajanın adıyla değiştirir: "Acp-local-yavas-ajan (1) (devam)" → "Yavaş Ajan (1) (devam)".
 * Kayıtlı başlık değişmez; yalnızca gösterim.
 */
function withCustomAgentNames(title: string): string {
  const match = LEADING_CUSTOM_DEFAULT_TITLE.exec(title);
  if (!match) return title;
  const name = agentDisplayName(match[1] ?? '');
  if (!name) return title;
  return `${name} (${match[2]})${title.slice(match[0].length)}`;
}

function parseDefaultTitleIndex(title: string, providerId: AgentProviderId): number | null {
  return parseDefaultConversationTitleIndex(title, providerId);
}

/**
 * Sağlayıcının ilk prompt'tan türettiği başlıklar gizli bağlam bloğunu (çoğu zaman etiketin
 * ortasında kırpılmış halde) taşıyabilir. ACP çözümleyicisi yeni başlıkları temizler
 * (`stripHiddenContextFromTitle`); bu, daha önce kaydedilmiş başlıklar için gösterim tarafındaki
 * karşılığıdır. Görünür bir şey kalmazsa başlık olduğu gibi döner.
 */
export function visibleConversationTitle(title: string): string {
  const visible = title
    .replace(/<orkestra_context>[\s\S]*?<\/orkestra_context>/g, '')
    .replace(/<orkestra_context>[\s\S]*$/, '')
    .trim();
  return visible === '' ? title : visible;
}

export function formatConversationTitleForDisplay(
  providerId: AgentProviderId,
  title: string
): string {
  const index = parseDefaultTitleIndex(title, providerId);
  if (index === null) return withCustomAgentNames(visibleConversationTitle(title));
  return `${providerTitleLabel(providerId)} (${index})`;
}

export function nextDefaultConversationTitle(
  providerId: AgentProviderId,
  conversations: ConversationTitleInput[]
): string {
  const used = new Set<number>();

  for (const conversation of conversations) {
    if (conversation.providerId !== providerId) continue;
    const index = parseDefaultTitleIndex(conversation.title, providerId);
    if (index !== null) used.add(index);
  }

  let next = 1;
  while (used.has(next)) next += 1;

  return `${capitalizeProviderId(providerId)} (${next})`;
}

const PLACEHOLDER_TASK_NAMES = new Set(['yeni sohbet', 'yeni görev', 'new chat', 'new task']);
// human-id görev adları (`brave-fox-runs`, `brave-fox-runs-2`): sistem üretimidir, başlık değildir.
const GENERATED_TASK_NAME = /^[a-z]+-[a-z]+-[a-z]+(?:-\d+)?$/;

/**
 * Sekme ve başlıklarda bir sohbet için gösterilecek ad. Görevin TEK sohbeti hâlâ sağlayıcı
 * varsayılan başlığını ("Claude (1)") taşıyorsa ve görev ilk istekten anlamlı bir ad aldıysa,
 * kenar çubuğuyla aynı adı (görev adını) gösterir. Sohbetin kendi adı makinede değiştirilmez;
 * birden çok sohbet, kullanıcının verdiği sohbet başlığı ya da yer tutucu görev adı varsa
 * `formatConversationTitleForDisplay` davranışı aynen korunur.
 */
export function conversationTitleForDisplayInTask(input: {
  providerId: AgentProviderId;
  title: string;
  taskName: string | null | undefined;
  taskConversationCount: number;
}): string {
  const fallback = formatConversationTitleForDisplay(input.providerId, input.title);
  if (input.taskConversationCount !== 1) return fallback;
  if (parseDefaultTitleIndex(input.title, input.providerId) === null) return fallback;
  const taskName = input.taskName?.trim();
  if (!taskName) return fallback;
  if (PLACEHOLDER_TASK_NAMES.has(taskName.toLocaleLowerCase('tr-TR'))) return fallback;
  if (GENERATED_TASK_NAME.test(taskName)) return fallback;
  if (parseDefaultConversationTitleIndex(taskName, input.providerId) !== null) return fallback;
  return taskName;
}
