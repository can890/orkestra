import { observable, runInAction } from 'mobx';

/**
 * Sağlayıcı kimliğinden görünen ada eşzamanlı (MobX ile gözlenebilir) erişim. Sekme başlıkları ve
 * palet satırları gibi React sorgusu kullanamayan yerler, kullanıcı ACP ajanlarını
 * ("acp-local-hizli-ajan") kimliğiyle değil adıyla ("Hızlı Ajan") gösterebilsin diye tutulur.
 * `useAgentMetadata` her yüklemede tabloyu tazeler; ad gelince gözlemciler yeniden çizilir.
 */
const names = observable.map<string, string>();

/** Kullanıcı ACP ajanlarının (yerel ve registry) kimlik öneki. */
const CUSTOM_ACP_PROVIDER_PREFIX = 'acp-';

export function isCustomAcpProviderId(providerId: string): boolean {
  return providerId.toLowerCase().startsWith(CUSTOM_ACP_PROVIDER_PREFIX);
}

export function rememberAgentDisplayNames(
  agents: ReadonlyArray<{ id: string; name: string }>
): void {
  runInAction(() => {
    for (const agent of agents) {
      const name = agent.name.trim();
      if (name) names.set(agent.id.toLowerCase(), name);
    }
  });
}

/** Bilinen görünen ad; meta veri henüz yüklenmediyse `undefined`. */
export function agentDisplayName(providerId: string): string | undefined {
  return names.get(providerId.toLowerCase());
}

/** Yalnızca testler için. */
export function resetAgentDisplayNamesForTests(): void {
  runInAction(() => names.clear());
}
