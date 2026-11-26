import type { SessionConfigState } from '#runtimes/acp/api';

const LIVE_PROGRESS_PROVIDERS = new Set(['antigravity', 'claude']);

const LIVE_PROGRESS_GUIDANCE =
  'For multi-step or tool-using requests, keep the user updated live with a warm, concise, direct progress flow in the user’s language: ' +
  'emit one short, friendly sentence right before your first tool call saying what you are starting, ' +
  'and one brief progress update at each meaningful phase transition (discovery, edit, verification) in the same turn alongside tool calls — ' +
  'for tasks with 3+ distinct steps, also maintain a live checklist using your step/todo tracking tool (such as update_steps, TodoWrite, TaskCreate/TaskUpdate, or update_plan) by posting the steps up front and updating each step as it moves from in_progress to completed — ' +
  'never spend an extra text-only turn, do not stall in silent reasoning before initial inspection, and skip preambles for simple direct questions.';

/**
 * Antigravity (Gemini/Claude) ve Claude oturumlarında canlı ara bildirim talimatı üretir.
 * Slash komutlarına eklenmez.
 */
export function antigravityLiveProgressInstructions(
  providerId: string,
  _config: Pick<SessionConfigState, 'modelOptions'>,
  prompt: string
): string | undefined {
  if (!LIVE_PROGRESS_PROVIDERS.has(providerId)) return undefined;
  // ACP bağdaştırıcısı slash komutunu birden fazla metin bloğuyla reddedebilir.
  if (/^\s*\/[a-z][\w-]*(?:\s|$)/i.test(prompt)) return undefined;

  return LIVE_PROGRESS_GUIDANCE;
}
