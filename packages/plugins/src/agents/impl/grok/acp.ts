import type { SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import type { AcpAgentApi, IAcpBehavior } from '@orkestra/core/services/agent-plugins/api/plugins';
import { connectStdioAcp } from '../../helpers/acp-stdio';

const MODE_ID = 'orkestra_approval';
const APPROVAL_COMMAND = /^\/always-approve (?:on|off)$/;

/** Grok replays the approval commands Orkestra sends on the user's behalf as user messages. */
export function isApprovalCommandEcho(update: SessionNotification['update']): boolean {
  return (
    update.sessionUpdate === 'user_message_chunk' &&
    update.content.type === 'text' &&
    APPROVAL_COMMAND.test(update.content.text.trim())
  );
}

type DecorateOptions = (sessionId: string, options: SessionConfigOption[]) => SessionConfigOption[];
export function withGrokApproval(
  agent: AcpAgentApi,
  bindUpdates?: (decorate: DecorateOptions) => void
): AcpAgentApi {
  const sessions = new Map<string, { mode: string; options: SessionConfigOption[] }>();
  const optionsFor = (sessionId: string): SessionConfigOption[] => {
    const state = sessions.get(sessionId);
    return [
      ...(state?.options ?? []).filter((option) => option.id !== MODE_ID),
      {
        id: MODE_ID,
        name: 'İşlem onayı',
        category: 'mode',
        type: 'select',
        currentValue: state?.mode ?? 'ask',
        options: [
          { value: 'ask', name: 'Her işlemde sor' },
          {
            value: 'always-approve',
            name: 'Otomatik onayla',
            description: 'Bu sohbetin araç işlemlerini otomatik onaylar.',
          },
        ],
      },
    ];
  };
  bindUpdates?.((sessionId, options) => {
    const state = sessions.get(sessionId);
    if (!state) return options;
    state.options = options;
    return optionsFor(sessionId);
  });
  const setApproval = async (sessionId: string, value: string) => {
    if (value !== 'ask' && value !== 'always-approve') throw new Error('Geçersiz onay modu.');
    const result = await agent.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: `/always-approve ${value === 'always-approve' ? 'on' : 'off'}` },
      ],
    });
    if (result.stopReason !== 'end_turn') throw new Error('Grok onay modu değiştirilemedi.');
  };
  return {
    initialize: async (params) => {
      const result = await agent.initialize(params);
      // Grok CLI 1.0.46 accepts native ACP image blocks but incorrectly advertises image: false.
      // Verified with a visual-only text/shape fixture against the real CLI, without file tools.
      const version = String(result._meta?.agentVersion ?? '');
      const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
      const nativeImages =
        parts &&
        (Number(parts[1]) > 1 ||
          (Number(parts[1]) === 1 && (Number(parts[2]) > 0 || Number(parts[3]) >= 46)));
      return nativeImages
        ? {
            ...result,
            agentCapabilities: {
              ...result.agentCapabilities,
              promptCapabilities: { ...result.agentCapabilities?.promptCapabilities, image: true },
            },
          }
        : result;
    },
    newSession: async (params) => {
      const result = await agent.newSession(params);
      await setApproval(result.sessionId, 'ask');
      sessions.set(result.sessionId, { mode: 'ask', options: result.configOptions ?? [] });
      return { ...result, configOptions: optionsFor(result.sessionId) };
    },
    ...(agent.loadSession
      ? {
          loadSession: async (params: Parameters<NonNullable<AcpAgentApi['loadSession']>>[0]) => {
            const result = await agent.loadSession!(params);
            await setApproval(params.sessionId, 'ask');
            sessions.set(params.sessionId, { mode: 'ask', options: result.configOptions ?? [] });
            return { ...result, configOptions: optionsFor(params.sessionId) };
          },
        }
      : {}),
    prompt: (params) => agent.prompt(params),
    cancel: (params) => agent.cancel(params),
    setSessionConfigOption: async (params) => {
      const state = sessions.get(params.sessionId);
      if (!state) throw new Error('Grok sohbeti hazır değil.');
      if (params.configId === MODE_ID) {
        if (typeof params.value !== 'string') throw new Error('Geçersiz onay modu.');
        await setApproval(params.sessionId, params.value);
        state.mode = params.value;
      } else {
        if (!agent.setSessionConfigOption) throw new Error('Grok bu ayarı desteklemiyor.');
        const result = await agent.setSessionConfigOption(params);
        state.options = result.configOptions;
      }
      return { configOptions: optionsFor(params.sessionId) };
    },
    ...(agent.setSessionMode ? { setSessionMode: agent.setSessionMode.bind(agent) } : {}),
    ...(agent.closeSession
      ? {
          closeSession: async (params: Parameters<NonNullable<AcpAgentApi['closeSession']>>[0]) => {
            const result = await agent.closeSession!(params);
            sessions.delete(params.sessionId);
            return result;
          },
        }
      : {}),
  };
}

export const grokAcpBehavior: IAcpBehavior = {
  buildSpawn: (ctx) => ({ command: ctx.cli, args: ['agent', 'stdio'] }),
  connect: (io, toClient) => {
    let decorate: DecorateOptions = (_sessionId, options) => options;
    const raw = connectStdioAcp(io, (agent) => {
      const client = toClient(agent);
      return {
        ...client,
        sessionUpdate: async (params) => {
          const update = params.update;
          if (isApprovalCommandEcho(update)) return;
          await client.sessionUpdate(
            update.sessionUpdate === 'config_option_update'
              ? {
                  ...params,
                  update: {
                    ...update,
                    configOptions: decorate(params.sessionId, update.configOptions),
                  },
                }
              : params
          );
        },
      };
    });
    return withGrokApproval(raw, (handler) => {
      decorate = handler;
    });
  },
};
