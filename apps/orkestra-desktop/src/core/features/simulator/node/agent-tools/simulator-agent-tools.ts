import { randomBytes } from 'node:crypto';
import { isLocalHostRef } from '@orkestra/core/primitives/host/api';
import type { Logger } from '@orkestra/shared/logger';
import type {
  AgentToolCallResult,
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import { AGENT_TOOLS_BRIDGE_ENV } from '@core/services/agent-tools/node/agent-tools-bridge';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';
import type { SimulatorService } from '../simctl';
import {
  SIMULATOR_MCP_SERVER_NAME,
  SIMULATOR_TOOLS,
  SIMULATOR_TOOLS_INSTRUCTIONS,
  SIMULATOR_TOOLS_SERVER_ID,
} from './simulator-tool-definitions';

export type SimulatorAgentToolsDeps = {
  /** Paylaşılan ajan araçları altyapısı (RPC sunucusu, köprü). */
  tools: AgentToolsBridgeHost;
  simulator: SimulatorService;
  /** "Ajanın simülatörü kullanmasına izin ver" ayarı; varsayılan kapalıdır. */
  isEnabled: () => Promise<boolean>;
  logger: Logger;
};

/**
 * iOS Simülatör araçlarını "orkestra-simulator" MCP sunucusu olarak sunar. Yalnızca macOS'ta,
 * yerel (SSH olmayan) görevlerde ve kullanıcı ayarda açıkça izin verdiyse eklenir; ayar çağrı
 * sırasında yeniden denetlenir, böylece kapatılınca çalışan oturumlar da durur.
 */
export class SimulatorAgentTools implements ConversationMcpServerProvider {
  private readonly tokens = new Map<string, string>();
  private readonly conversationsByToken = new Map<string, string>();
  private readonly offered = new Set<string>();
  private readonly unregister: () => void;

  constructor(private readonly deps: SimulatorAgentToolsDeps) {
    this.unregister = deps.tools.register({
      id: SIMULATOR_TOOLS_SERVER_ID,
      authenticate: (token) => this.conversationsByToken.get(token) ?? null,
      handle: (conversationId, method, params) => this.handle(conversationId, method, params),
    });
  }

  async conversationMcpServers(context: ConversationToolContext): Promise<AgentToolsMcpServer[]> {
    if (!this.deps.simulator.supported) return [];
    if (!isLocalHostRef(context.host)) return [];
    if (!(await this.deps.isEnabled())) return [];
    this.offered.add(context.conversationId);
    const server = await this.deps.tools.bridgeServer({
      name: SIMULATOR_MCP_SERVER_NAME,
      host: context.host,
      token: this.tokenFor(context.conversationId),
      env: AGENT_TOOLS_BRIDGE_ENV,
      serverId: SIMULATOR_TOOLS_SERVER_ID,
    });
    return server ? [server] : [];
  }

  dispose(): void {
    this.unregister();
  }

  private tokenFor(conversationId: string): string {
    let token = this.tokens.get(conversationId);
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.tokens.set(conversationId, token);
      this.conversationsByToken.set(token, conversationId);
    }
    return token;
  }

  private async handle(
    conversationId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.offered.has(conversationId)) {
      throw new Error('This conversation has no access to the iOS simulator.');
    }
    if (!(await this.deps.isEnabled())) {
      throw new Error('iOS simulator tools are disabled in the Orkestra simulator panel.');
    }
    if (method === 'describe') {
      return {
        name: SIMULATOR_MCP_SERVER_NAME,
        instructions: SIMULATOR_TOOLS_INSTRUCTIONS,
        tools: SIMULATOR_TOOLS,
      };
    }
    if (method !== 'call') throw new Error(`Unknown method: ${method}`);
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    this.deps.logger.debug('Orkestra simülatör aracı çağrıldı', { conversationId, tool: name });
    return this.run(name, args);
  }

  private async run(name: string, args: Record<string, unknown>): Promise<AgentToolCallResult> {
    const { simulator } = this.deps;
    if (name === 'list_devices') {
      const devices = await simulator.listDevices();
      if (!devices.success) return failure(devices.error.message);
      if (devices.data.length === 0) return text('No iOS simulators are available.');
      return text(
        devices.data
          .map((device) => `${device.udid}  ${device.name} (${device.runtime})  ${device.state}`)
          .join('\n')
      );
    }
    if (
      name !== 'screenshot' &&
      name !== 'open_url' &&
      name !== 'install_app' &&
      name !== 'launch_app'
    ) {
      return failure(`Unknown tool: ${name}`);
    }
    const udid = await this.resolveUdid(args.udid);
    if (!udid.success) return failure(udid.message);
    switch (name) {
      case 'screenshot': {
        const shot = await simulator.screenshot(udid.udid);
        if (!shot.success) return failure(shot.error.message);
        return {
          content: [
            { type: 'text', text: `Simulator screenshot (${udid.udid})` },
            { type: 'image', data: shot.data.data, mimeType: shot.data.mimeType },
          ],
        };
      }
      case 'open_url': {
        const result = await simulator.openUrl(udid.udid, asString(args.url));
        return result.success
          ? text('Opened the URL in the simulator.')
          : failure(result.error.message);
      }
      case 'install_app': {
        const result = await simulator.installApp(udid.udid, asString(args.app_path));
        return result.success ? text('Installed the app.') : failure(result.error.message);
      }
      case 'launch_app': {
        const result = await simulator.launchApp(udid.udid, asString(args.bundle_id));
        return result.success ? text('Launched the app.') : failure(result.error.message);
      }
    }
  }

  /** `udid` verilmezse tek açık cihazı seçer; belirsizse hata verir. */
  private async resolveUdid(
    value: unknown
  ): Promise<{ success: true; udid: string } | { success: false; message: string }> {
    if (typeof value === 'string' && value.length > 0) return { success: true, udid: value };
    const devices = await this.deps.simulator.listDevices();
    if (!devices.success) return { success: false, message: devices.error.message };
    const booted = devices.data.filter((device) => device.state === 'booted');
    if (booted.length === 1) return { success: true, udid: booted[0]!.udid };
    return {
      success: false,
      message:
        booted.length === 0
          ? 'No simulator is booted. Ask the user to boot one in the simulator panel.'
          : 'Several simulators are booted; pass udid (see list_devices).',
    };
  }
}

function text(value: string): AgentToolCallResult {
  return { content: [{ type: 'text', text: value }] };
}

function failure(message: string): AgentToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
