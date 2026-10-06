import { join, posix } from 'node:path';
import type { Scope } from '@orkestra/shared/concurrency';
import type { Logger } from '@orkestra/shared/logger';
import { app } from 'electron';
import { BrowserAgentTools } from '@core/features/browser/node/agent-tools/browser-agent-tools';
import type { LoopbackForwardBackend } from '@core/features/browser/node/agent-tools/loopback-forwarding';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { AgentToolsHost } from '@core/services/agent-tools/node/agent-tools-host';
import { workspaceServerLayout } from '@core/services/hosts/node/workspace-server/layout';
import { agentBrowserPort } from '@main/host/browser/agent-browser-port';

export type AgentToolsServices = {
  /** Şef ve tarayıcı araçlarının paylaştığı RPC sunucusu, köprü betiği ve SSH ters tünelleri. */
  readonly agentTools: AgentToolsHost;
  /** Her ACP konuşmasına eklenen "orkestra-browser" MCP sunucusu. */
  readonly browserAgentTools: BrowserAgentTools;
};

/**
 * Ajanlara sunulan Orkestra araç sunucularını kurar. Konuşmalar denetleyicisi şefi aynı
 * altyapıyla çalıştırır ve tarayıcı araçlarını her ACP oturumuna bağlanırken ekler.
 */
export function createAgentToolsServices(deps: {
  scope: Scope;
  getSshProxy(connectionId: string): SshClientProxy | undefined;
  previewServers: LoopbackForwardBackend;
  logger: Logger;
}): AgentToolsServices {
  const agentTools = new AgentToolsHost({
    localDirectory: join(app.getPath('userData'), 'agent-tools'),
    nodeExecutable: process.execPath,
    logger: deps.logger,
    remote: {
      getProxy: deps.getSshProxy,
      // Uzak köprü workspace-server ile gelen Node çalışma zamanıyla çalışır.
      nodePath: (home) => posix.join(workspaceServerLayout(home).currentLink, 'node'),
    },
  });
  // Ana süreçteki tarayıcı kaydı ve sayfa kontrolcüleri.
  const browser = agentBrowserPort;
  const browserAgentTools = new BrowserAgentTools({
    tools: agentTools,
    browser,
    previewServers: deps.previewServers,
    logger: deps.logger,
  });
  deps.scope.add(async () => {
    browserAgentTools.dispose();
    await agentTools.dispose();
  });
  return { agentTools, browserAgentTools };
}
