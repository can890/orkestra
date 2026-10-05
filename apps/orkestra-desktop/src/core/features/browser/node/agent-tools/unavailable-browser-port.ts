import type { AgentBrowserPort } from '@core/primitives/browser/api/agent-browser';

const UNAVAILABLE = 'In-app browser is not available';

/**
 * Ana süreçteki gerçek tarayıcı kapısı bağlanmadan önce kullanılan yer tutucu: her çağrıyı
 * reddeder, böylece araçlar ajana anlaşılır bir hata döndürür. Gerçek kapı
 * (`agentBrowserPort`, `@main/host/browser/agent-browser-port`) bootstrap'ta bunun yerine geçer.
 */
export function createUnavailableAgentBrowserPort(): AgentBrowserPort {
  const unavailable = (): never => {
    throw new Error(UNAVAILABLE);
  };
  return {
    listTabs: unavailable,
    getTab: unavailable,
    openTab: async () => unavailable(),
    activateTab: async () => unavailable(),
    closeTab: async () => unavailable(),
    page: unavailable,
  };
}
