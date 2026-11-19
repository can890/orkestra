import { join, posix } from 'node:path';
import type { Scope } from '@orkestra/shared/concurrency';
import type { Logger } from '@orkestra/shared/logger';
import { app, shell, systemPreferences } from 'electron';
import { BrowserAgentTools } from '@core/features/browser/node/agent-tools/browser-agent-tools';
import type { LoopbackForwardBackend } from '@core/features/browser/node/agent-tools/loopback-forwarding';
import { SimulatorAgentTools } from '@core/features/simulator/node/agent-tools/simulator-agent-tools';
import { SimulatorService } from '@core/features/simulator/node/simctl';
import { MemoryAgentTools } from '@core/features/project-memory/node/memory-agent-tools';
import { ProjectMemorySettingsStore } from '@core/features/project-memory/node/memory-settings';
import { ProjectMemoryStore } from '@core/features/project-memory/node/memory-store';
import { ProjectMemoryService } from '@core/features/project-memory/node/project-memory-service';
import {
  ACCESSIBILITY_SETTINGS_URL,
  SCREEN_RECORDING_SETTINGS_URL,
  ComputerAgentTools,
} from '@core/features/computer-use/node/computer-agent-tools';
import { ComputerDesktop } from '@core/features/computer-use/node/computer-desktop';
import {
  nodeProcessRunner,
  tmpScratchFiles,
} from '@core/features/computer-use/node/computer-process';
import { ComputerUseState } from '@core/features/computer-use/node/computer-use-state';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { AgentToolsHost } from '@core/services/agent-tools/node/agent-tools-host';
import { workspaceServerLayout } from '@core/services/hosts/node/workspace-server/layout';
import { agentBrowserPort } from '@main/host/browser/agent-browser-port';

export type AgentToolsServices = {
  /** Şef ve tarayıcı araçlarının paylaştığı RPC sunucusu, köprü betiği ve SSH ters tünelleri. */
  readonly agentTools: AgentToolsHost;
  /** Her ACP konuşmasına eklenen "orkestra-browser" MCP sunucusu. */
  readonly browserAgentTools: BrowserAgentTools;
  /** "orkestra-simulator" MCP sunucusu; yalnızca macOS'ta ve ayar açıkken eklenir. */
  readonly simulatorAgentTools: SimulatorAgentTools;
  /** Proje başına ortak hafıza (userData altında); ayar kapalıyken araç sunucusu eklenmez. */
  readonly projectMemory: ProjectMemoryService;
  /** Ayarı açık projelerin konuşmalarına eklenen "orkestra-memory" MCP sunucusu. */
  readonly memoryAgentTools: MemoryAgentTools;
  /** "orkestra-computer" sunucusu (yalnızca macOS, çift kilit); kilitler ve etkinlik günlüğü. */
  readonly computerUse: ComputerUseState;
  readonly computerAgentTools: ComputerAgentTools;
  /** Sistem Ayarları'nda izin bölümünü açar (izin istemini tetiklemez). */
  readonly openComputerPermissionSettings: (
    pane: 'accessibility' | 'screen-recording'
  ) => Promise<void>;
  /** İzin durumu; sormak izin istemini tetiklemez. */
  readonly computerPermissions: () => { accessibility: boolean; screenRecording: boolean };
};

/**
 * Ajanlara sunulan Orkestra araç sunucularını kurar. Konuşmalar denetleyicisi şefi aynı
 * altyapıyla çalıştırır ve tarayıcı araçlarını her ACP oturumuna bağlanırken ekler.
 */
export function createAgentToolsServices(deps: {
  scope: Scope;
  getSshProxy(connectionId: string): SshClientProxy | undefined;
  previewServers: LoopbackForwardBackend;
  /** Genel "Bilgisayar kullanımı" ayarı (varsayılan kapalı). */
  isComputerUseEnabled(): Promise<boolean>;
  logger: Logger;
  /** "Ajanın iOS Simülatör'ü kullanmasına izin ver" ayarı. */
  isSimulatorAgentToolsEnabled(): Promise<boolean>;
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
  const simulatorAgentTools = new SimulatorAgentTools({
    tools: agentTools,
    simulator: new SimulatorService(),
    isEnabled: deps.isSimulatorAgentToolsEnabled,
    logger: deps.logger,
  });
  const memoryDirectory = join(app.getPath('userData'), 'project-memory');
  const projectMemory = new ProjectMemoryService(
    new ProjectMemoryStore({ rootDir: join(memoryDirectory, 'projects') }),
    new ProjectMemorySettingsStore(join(memoryDirectory, 'settings.json'))
  );
  const memoryAgentTools = new MemoryAgentTools({
    tools: agentTools,
    memory: projectMemory,
    logger: deps.logger,
  });
  const computerUse = new ComputerUseState({
    isGloballyEnabled: deps.isComputerUseEnabled,
    platform: process.platform,
  });
  const computerPermissions = () => ({
    // false: izin istemini tetikleme, yalnızca durumu oku.
    accessibility:
      process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording:
      process.platform === 'darwin' &&
      systemPreferences.getMediaAccessStatus('screen') === 'granted',
  });
  const computerAgentTools = new ComputerAgentTools({
    tools: agentTools,
    state: computerUse,
    desktop: new ComputerDesktop({ run: nodeProcessRunner, scratch: tmpScratchFiles }),
    permissions: computerPermissions,
    logger: deps.logger,
  });
  const openComputerPermissionSettings = async (pane: 'accessibility' | 'screen-recording') => {
    await shell.openExternal(
      pane === 'accessibility' ? ACCESSIBILITY_SETTINGS_URL : SCREEN_RECORDING_SETTINGS_URL
    );
  };
  deps.scope.add(async () => {
    computerAgentTools.dispose();
    memoryAgentTools.dispose();
    simulatorAgentTools.dispose();
    browserAgentTools.dispose();
    await agentTools.dispose();
  });
  return {
    agentTools,
    browserAgentTools,
    simulatorAgentTools,
    projectMemory,
    memoryAgentTools,
    computerUse,
    computerAgentTools,
    openComputerPermissionSettings,
    computerPermissions,
  };
}
