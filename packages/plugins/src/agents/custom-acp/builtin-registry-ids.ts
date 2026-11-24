// Orkestra'nın birinci sınıf (yerleşik) desteklediği ajanların ACP Registry kimlikleri.
// Bu kayıtlar Registry listesinde "Yerleşik" olarak işaretlenir ve ikinci kez eklenemez.
export const BUILT_IN_ACP_REGISTRY_AGENT_IDS: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude-acp'],
  codex: ['codex-acp'],
  kimi: ['kimi', 'kimi-code'],
  glm: ['glm-acp-agent'],
  antigravity: ['antigravity-acp'],
  grok: ['grok-build'],
};

/** Registry ajan kimliğini karşılayan yerleşik sağlayıcı kimliği (varsa). */
export function builtInProviderForRegistryAgent(
  registryAgentId: string,
  builtInProviderIds: readonly string[] = Object.keys(BUILT_IN_ACP_REGISTRY_AGENT_IDS)
): string | undefined {
  for (const providerId of builtInProviderIds) {
    if (providerId === registryAgentId) return providerId;
    if (BUILT_IN_ACP_REGISTRY_AGENT_IDS[providerId]?.includes(registryAgentId)) return providerId;
  }
  return undefined;
}
