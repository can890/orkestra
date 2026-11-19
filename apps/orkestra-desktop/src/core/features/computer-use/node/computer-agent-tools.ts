import { randomBytes } from 'node:crypto';
import { sshConnectionIdOf } from '@orkestra/core/primitives/host/api';
import type { Logger } from '@orkestra/shared/logger';
import type {
  AgentToolCallResult,
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';
import { AGENT_TOOLS_BRIDGE_ENV } from '@core/services/agent-tools/node/agent-tools-bridge';
import type { AgentToolsBridgeHost } from '@core/services/agent-tools/node/agent-tools-host';
import type { ComputerUsePermissions } from '../api';
import type { ComputerDesktop } from './computer-desktop';
import { ComputerToolError, parseCoordinate, parseKey, parseTypeText } from './computer-input';
import {
  COMPUTER_MCP_SERVER_NAME,
  COMPUTER_TOOLS,
  COMPUTER_TOOLS_INSTRUCTIONS,
  COMPUTER_TOOLS_SERVER_ID,
} from './computer-tool-definitions';
import { gateMessage, type ComputerUseState } from './computer-use-state';

/** İzin durumunu izin istemini TETİKLEMEDEN okur (Electron: `isTrustedAccessibilityClient(false)`). */
export type ComputerPermissionProbe = () => ComputerUsePermissions;

export const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
export const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

const ACCESSIBILITY_MESSAGE =
  'macOS Accessibility permission is missing for Orkestra, so mouse and keyboard control is blocked. Ask the user to open System Settings > Privacy & Security > Accessibility (Sistem Ayarları > Gizlilik ve Güvenlik > Erişilebilirlik), allow Orkestra, and try again. You cannot grant or request this permission yourself.';
const SCREEN_RECORDING_MESSAGE =
  'macOS Screen Recording permission is missing for Orkestra, so screenshots are blocked. Ask the user to open System Settings > Privacy & Security > Screen & System Audio Recording (Sistem Ayarları > Gizlilik ve Güvenlik > Ekran Kaydı), allow Orkestra, restart Orkestra and try again. You cannot grant or request this permission yourself.';

export type ComputerAgentToolsDeps = {
  tools: AgentToolsBridgeHost;
  state: ComputerUseState;
  desktop: ComputerDesktop;
  permissions: ComputerPermissionProbe;
  logger: Logger;
};

/**
 * "orkestra-computer" MCP sunucusu. Sunucu bir oturuma yalnızca genel ayar VE sohbet kilidi açıkken
 * eklenir (yalnızca yerel ve macOS); her çağrıda kilitler yeniden denetlenir, bu yüzden "Durdur"
 * araçları anında hataya çevirir. Bu sınıfın kilidi açan hiçbir yolu yoktur.
 */
export class ComputerAgentTools implements ConversationMcpServerProvider {
  private readonly tokens = new Map<string, string>();
  private readonly conversationsByToken = new Map<string, string>();
  private readonly unregister: () => void;
  /** Farklı sohbetlerin girdi olayları iç içe geçmesin diye tüm çağrılar sıraya girer. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ComputerAgentToolsDeps) {
    this.unregister = deps.tools.register({
      id: COMPUTER_TOOLS_SERVER_ID,
      authenticate: (token) => this.conversationsByToken.get(token) ?? null,
      handle: (conversationId, method, params) => this.handle(conversationId, method, params),
    });
  }

  async conversationMcpServers(context: ConversationToolContext): Promise<AgentToolsMcpServer[]> {
    // Uzak (SSH) projelerde masaüstü kontrolü sunulmaz.
    if (sshConnectionIdOf(context.host)) return [];
    const gate = await this.deps.state.check(context.conversationId);
    if (!gate.open) return [];
    const server = await this.deps.tools.bridgeServer({
      name: COMPUTER_MCP_SERVER_NAME,
      host: context.host,
      token: this.tokenFor(context.conversationId),
      env: AGENT_TOOLS_BRIDGE_ENV,
      serverId: COMPUTER_TOOLS_SERVER_ID,
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
    if (method === 'describe') {
      return {
        name: COMPUTER_MCP_SERVER_NAME,
        instructions: COMPUTER_TOOLS_INSTRUCTIONS,
        tools: COMPUTER_TOOLS,
      };
    }
    if (method !== 'call') throw new Error(`Unknown method: ${method}`);
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const run = this.queue.then(() => this.call(conversationId, name, args));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async call(
    conversationId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<AgentToolCallResult> {
    const { state, logger } = this.deps;
    const gate = await state.check(conversationId);
    if (!gate.open) {
      state.record({
        conversationId,
        tool,
        summary: `blocked (${gate.reason})`,
        outcome: 'denied',
      });
      return errorResult(gateMessage(gate.reason));
    }
    let summary = tool;
    try {
      const outcome = await this.perform(conversationId, tool, args, (text) => {
        summary = text;
      });
      state.record({ conversationId, tool, summary, outcome: 'ok' });
      logger.info('Orkestra bilgisayar aracı çalıştı', { conversationId, tool, summary });
      return outcome;
    } catch (error) {
      const message =
        error instanceof ComputerToolError ? error.message : 'The desktop action failed.';
      state.record({ conversationId, tool, summary: `${summary}: failed`, outcome: 'error' });
      logger.warn('Orkestra bilgisayar aracı hata verdi', {
        conversationId,
        tool,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResult(message);
    }
  }

  private async perform(
    conversationId: string,
    tool: string,
    args: Record<string, unknown>,
    describe: (summary: string) => void
  ): Promise<AgentToolCallResult> {
    const { desktop, permissions, state } = this.deps;
    const granted = permissions();
    if (tool === 'screenshot') {
      if (!granted.screenRecording) throw new ComputerToolError(SCREEN_RECORDING_MESSAGE);
      describe('screenshot');
      const shot = await desktop.screenshot();
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: shot.mimeType },
          { type: 'text', text: `Screenshot ${shot.width}x${shot.height} px (main display).` },
        ],
      };
    }
    if (!COMPUTER_TOOLS.some((definition) => definition.name === tool)) {
      throw new ComputerToolError(`Unknown tool: ${tool.slice(0, 40)}`);
    }
    if (!granted.accessibility) throw new ComputerToolError(ACCESSIBILITY_MESSAGE);
    const display = await desktop.displayInfo();
    switch (tool) {
      case 'mouse_move': {
        const x = parseCoordinate(args.x, 'x', display);
        const y = parseCoordinate(args.y, 'y', display);
        describe(`mouse_move (${x}, ${y})`);
        await desktop.moveMouse(x, y);
        return okText(`Moved the mouse to (${x}, ${y}).`);
      }
      case 'click': {
        const x = parseCoordinate(args.x, 'x', display);
        const y = parseCoordinate(args.y, 'y', display);
        const button = args.button === undefined ? 'left' : args.button;
        if (button !== 'left' && button !== 'right') {
          throw new ComputerToolError('button must be "left" or "right".');
        }
        const double = args.double === true;
        if (double && button === 'right') {
          throw new ComputerToolError('Double click is only supported with the left button.');
        }
        describe(`click ${button}${double ? ' double' : ''} (${x}, ${y})`);
        await desktop.click(x, y, button, double ? 2 : 1);
        return okText(`Clicked at (${x}, ${y}).`);
      }
      case 'drag': {
        const fromX = parseCoordinate(args.from_x, 'x', display);
        const fromY = parseCoordinate(args.from_y, 'y', display);
        const toX = parseCoordinate(args.to_x, 'x', display);
        const toY = parseCoordinate(args.to_y, 'y', display);
        describe(`drag (${fromX}, ${fromY}) -> (${toX}, ${toY})`);
        await desktop.drag(fromX, fromY, toX, toY);
        return okText(`Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY}).`);
      }
      case 'type_text': {
        const text = parseTypeText(args.text);
        // Günlüğe yalnızca uzunluk yazılır; metnin kendisi asla kaydedilmez.
        describe(`type_text (${text.length} chars)`);
        await desktop.typeText(text, async () => (await state.check(conversationId)).open);
        return okText(`Typed ${text.length} characters.`);
      }
      case 'key': {
        const key = parseKey(args.key, args.modifiers);
        const label = [...key.modifiers, key.name].join('+');
        describe(`key ${label}`);
        await desktop.pressKey(key.keyCode, key.flags);
        return okText(`Pressed ${label}.`);
      }
      default:
        throw new ComputerToolError(`Unknown tool: ${tool.slice(0, 40)}`);
    }
  }
}

function okText(text: string): AgentToolCallResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): AgentToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
