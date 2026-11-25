import type { SessionConfigState } from '#runtimes/acp/api';

const ABOVE_HIGH = new Set(['xhigh', 'extra-high', 'max', 'ultra']);
const ANTIGRAVITY_ORCHESTRATOR_MODELS = new Set([
  'gemini-pro-orchestrator',
  'gemini-pro-orchestrator-neon',
  'gemini-pro-orchestrator-argon',
]);
const THROUGH_HIGH = new Set(['none', 'minimal', 'low', 'medium', 'high']);
const providerControls = new Map([
  [
    'codex',
    'For Codex spawn_agent, use the native model and reasoning_effort arguments when available.',
  ],
  [
    'claude',
    'For Claude Code Agent, use the matching parent model alias if required and set the effort argument when supported.',
  ],
  ['copilot', 'For Copilot task, use per-call model and reasoning effort when supported.'],
  ['cursor', 'For Cursor Task, use the parent model or an inheriting subagent when supported.'],
  [
    'kimi',
    'For Kimi Agent, preserve model inheritance unless the configured model pool has a matching alias.',
  ],
  [
    'opencode',
    'For OpenCode Task, prefer a subagent that inherits the parent model and supports the requested effort.',
  ],
]);

export function nativeSubagentInstructions(
  providerId: string,
  config: Pick<SessionConfigState, 'modelOptions' | 'efforts' | 'collaborationModeOptions'>,
  prompt: string
): string | undefined {
  // ACP bağdaştırıcısı slash komutunu birden fazla metin bloğuyla reddedebilir.
  if (/^\s*\/[a-z][\w-]*(?:\s|$)/i.test(prompt)) return undefined;

  const selectedModel = config.modelOptions?.selected?.trim() ?? '';
  if (providerId === 'antigravity') {
    const mode = config.collaborationModeOptions?.selected?.trim() ?? '';
    if (
      ANTIGRAVITY_ORCHESTRATOR_MODELS.has(mode) ||
      ANTIGRAVITY_ORCHESTRATOR_MODELS.has(selectedModel) ||
      (!selectedModel && mode !== 'standard')
    ) {
      return undefined;
    }
  }

  // Bazı ACP katalogları eforu ayrı bir seçenek yerine model kimliğine ekler.
  const modelAndEffort =
    providerId === 'codex'
      ? /^(.+)\[([^\]]+)\]$/.exec(selectedModel)
      : providerId === 'opencode'
        ? /^(.+)#([^#]+)$/.exec(selectedModel)
        : null;
  const model = modelAndEffort?.[1] ?? selectedModel;
  const modelTarget =
    !/^(auto|default|inherit)$/i.test(model) && /^[\w./:@-]+$/.test(model)
      ? `the parent session model (${model})`
      : 'the parent session model';
  const effort = (config.efforts?.selected ?? modelAndEffort?.[2])?.toLowerCase();
  const target = effort && ABOVE_HIGH.has(effort) ? 'high' : effort;
  const effortTarget =
    target && THROUGH_HIGH.has(target)
      ? `Use reasoning effort ${target}.`
      : 'Use the parent reasoning effort when known, capped at high.';

  const controls = providerControls.get(providerId);
  return [
    `If you use a provider-native subagent tool, default to ${modelTarget} unless the user explicitly chose another child model. ${effortTarget} Never request a child effort above high.`,
    ...(controls ? [controls] : []),
    'Prefer inheritance when the tool cannot select a setting. If its inherited effort exceeds high and cannot be reduced, do not use that native subagent.',
  ].join(' ');
}
