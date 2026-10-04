import type { AcpAgentApi } from '@orkestra/core/services/agent-plugins/api/plugins';
import { describe, expect, it, vi } from 'vitest';
import { withGrokApproval } from './acp';
function setup() {
  const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
  let id = 0;
  const raw = {
    prompt,
    newSession: async () => ({ sessionId: String(++id), configOptions: [] }),
    setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: [] }),
  } as unknown as AcpAgentApi;
  return { agent: withGrokApproval(raw), prompt, raw };
}
describe('Grok approval mode', () => {
  it('starts with manual approval and changes only the selected session', async () => {
    const { agent, prompt } = setup();
    const first = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    expect(first.configOptions?.[0].currentValue).toBe('ask');
    const result = await agent.setSessionConfigOption!({
      sessionId: '1',
      configId: 'orkestra_approval',
      value: 'always-approve',
    });
    expect(result.configOptions[0].currentValue).toBe('always-approve');
    expect(prompt).toHaveBeenLastCalledWith({
      sessionId: '1',
      prompt: [{ type: 'text', text: '/always-approve on' }],
    });
    const second = await agent.setSessionConfigOption!({
      sessionId: '2',
      configId: 'model',
      value: 'grok-4.7',
    });
    expect(second.configOptions[0].currentValue).toBe('ask');
  });
  it('preserves approval controls after asynchronous model updates', async () => {
    const { raw } = setup();
    let decorate: any;
    const agent = withGrokApproval(raw, (handler) => {
      decorate = handler;
    });
    await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.setSessionConfigOption!({
      sessionId: '1',
      configId: 'orkestra_approval',
      value: 'always-approve',
    });
    const updated = decorate('1', [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'grok-4.7',
        options: [],
      },
    ]);
    expect(updated.find((option: any) => option.id === 'orkestra_approval').currentValue).toBe(
      'always-approve'
    );
    expect(updated.find((option: any) => option.id === 'model').currentValue).toBe('grok-4.7');
  });
  it('keeps manual mode when Grok rejects the change', async () => {
    const { agent, prompt } = setup();
    await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    prompt.mockRejectedValueOnce(new Error('failed'));
    await expect(
      agent.setSessionConfigOption!({
        sessionId: '1',
        configId: 'orkestra_approval',
        value: 'always-approve',
      })
    ).rejects.toThrow('failed');
    const result = await agent.setSessionConfigOption!({
      sessionId: '1',
      configId: 'model',
      value: 'grok-4.7',
    });
    expect(result.configOptions[0].currentValue).toBe('ask');
  });
});

describe('Grok native images', () => {
  it('corrects the known CLI capability report without altering other capabilities', async () => {
    const raw = {
      initialize: async () => ({
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: false, audio: false } },
        _meta: { agentVersion: '1.0.46' },
      }),
    } as unknown as AcpAgentApi;
    const result = await withGrokApproval(raw).initialize({ protocolVersion: 1 });
    expect(result.agentCapabilities?.promptCapabilities).toMatchObject({
      image: true,
      audio: false,
    });
  });
  it('does not invent capabilities for unidentified older implementations', async () => {
    const raw = {
      initialize: async () => ({
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: false } },
      }),
    } as unknown as AcpAgentApi;
    expect(
      (await withGrokApproval(raw).initialize({ protocolVersion: 1 })).agentCapabilities
        ?.promptCapabilities?.image
    ).toBe(false);
  });
});
