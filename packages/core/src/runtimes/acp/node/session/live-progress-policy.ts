import type { SessionConfigState } from '#runtimes/acp/api';

const LIVE_PROGRESS_GUIDANCE =
  'For multi-step or tool-using requests, keep the user updated live like Claude Code and Codex in the user’s language: ' +
  'emit one short, friendly sentence right before your first tool call saying what you are starting, ' +
  'and one brief progress update at each meaningful phase transition (discovery, edit, verification) in the same turn alongside tool calls — ' +
  'never spend an extra text-only turn, do not stall in silent reasoning before initial inspection, and skip preambles for simple direct questions.';

/**
 * Antigravity (Gemini) oturumlarında Claude Code / Codex tarzı canlı ara bildirim talimatı üretir.
 * Slash komutlarına ve Antigravity içinden seçilen Claude modellerine eklenmez.
 */
export function antigravityLiveProgressInstructions(
  providerId: string,
  config: Pick<SessionConfigState, 'modelOptions'>,
  prompt: string
): string | undefined {
  if (providerId !== 'antigravity') return undefined;
  // ACP bağdaştırıcısı slash komutunu birden fazla metin bloğuyla reddedebilir.
  if (/^\s*\/[a-z][\w-]*(?:\s|$)/i.test(prompt)) return undefined;

  const selectedModel = config.modelOptions?.selected?.trim() ?? '';
  if (/^claude/i.test(selectedModel)) return undefined;

  return LIVE_PROGRESS_GUIDANCE;
}
