import { describe, expect, it } from 'vitest';
import type { ToolNode } from '@/model';
import { isOrchestraSpawnNode, orchestraToolName, orchestraToolOf } from './orchestra-tool';

const base = { seq: 0, status: 'running' as const, toolCallId: 'call-1' };

const claudeSpawn: ToolNode = {
  ...base,
  kind: 'unknown-tool-call',
  id: 'claude',
  title: 'mcp__orkestra__spawn_agent',
  name: 'mcp__orkestra__spawn_agent',
  toolKind: 'other',
};

const codexSpawn: ToolNode = {
  ...base,
  kind: 'execute-tool-call',
  id: 'codex',
  title: 'mcp.orkestra.spawn_agent',
  command: 'mcp.orkestra.spawn_agent',
};

describe('orchestraToolName', () => {
  it('accepts every provider spelling of an Orkestra MCP tool', () => {
    expect(orchestraToolName('mcp__orkestra__spawn_agent')).toBe('spawn_agent');
    expect(orchestraToolName('mcp.orkestra.spawn_agent')).toBe('spawn_agent');
    expect(orchestraToolName('mcp.orkestra.wait_for_agents')).toBe('wait_for_agents');
    expect(orchestraToolName('orkestra__spawn_agent')).toBe('spawn_agent');
    expect(orchestraToolName('orkestra.spawn_agent')).toBe('spawn_agent');
    expect(orchestraToolName('orkestra:spawn_agent')).toBe('spawn_agent');
    expect(orchestraToolName(' mcp.orkestra.list_agents ')).toBe('list_agents');
  });

  it('rejects other servers, bare tool names and partial matches', () => {
    expect(orchestraToolName('mcp.linear.spawn_agent')).toBeUndefined();
    expect(orchestraToolName('mcp__github__create_issue')).toBeUndefined();
    expect(orchestraToolName('spawn_agent')).toBeUndefined();
    expect(orchestraToolName('mcp.orkestra')).toBeUndefined();
    expect(orchestraToolName('mcp.orkestra.spawn agent')).toBeUndefined();
    expect(orchestraToolName('xorkestra.spawn_agent')).toBeUndefined();
    expect(orchestraToolName('mcp__orkestra__spawn_agent (worker)')).toBeUndefined();
    expect(orchestraToolName(undefined)).toBeUndefined();
    expect(orchestraToolName('')).toBeUndefined();
  });
});

describe('orchestraToolOf', () => {
  it('recognizes spawn calls whatever tool kind the provider reported', () => {
    expect(isOrchestraSpawnNode(claudeSpawn)).toBe(true);
    expect(isOrchestraSpawnNode(codexSpawn)).toBe(true);
    expect(
      isOrchestraSpawnNode({
        ...base,
        kind: 'mcp-tool-call',
        id: 'mcp',
        title: 'spawn_agent',
        server: 'orkestra',
        tool: 'spawn_agent',
      })
    ).toBe(true);
    expect(
      orchestraToolOf({
        ...base,
        kind: 'mcp-tool-call',
        id: 'mcp-title',
        title: 'mcp.orkestra.cancel_agent',
        tool: 'mcp.orkestra.cancel_agent',
      })
    ).toBe('cancel_agent');
  });

  it('tells conductor tools apart from spawn calls', () => {
    const wait = { ...codexSpawn, title: 'mcp.orkestra.wait_for_agents' };
    expect(orchestraToolOf(wait)).toBe('wait_for_agents');
    expect(isOrchestraSpawnNode(wait)).toBe(false);
  });

  it('ignores other servers, groups and provider-native sub-agents', () => {
    expect(
      orchestraToolOf({
        ...base,
        kind: 'mcp-tool-call',
        id: 'other',
        title: 'spawn_agent',
        server: 'linear',
        tool: 'spawn_agent',
      })
    ).toBeUndefined();
    expect(orchestraToolOf({ ...codexSpawn, title: 'mcp.linear.list_issues' })).toBeUndefined();
    expect(
      orchestraToolOf({
        kind: 'tool-group',
        id: 'group',
        seq: 0,
        label: 'Ran 2 commands',
        groupKind: 'tool-run',
        status: 'running',
        children: [codexSpawn, { ...codexSpawn, id: 'codex-2', toolCallId: 'call-2' }],
      })
    ).toBeUndefined();
    expect(
      orchestraToolOf({
        ...base,
        kind: 'spawn-subagent-tool-call',
        id: 'native',
        title: 'mcp__orkestra__spawn_agent',
        name: 'mcp__orkestra__spawn_agent',
      })
    ).toBeUndefined();
  });
});
