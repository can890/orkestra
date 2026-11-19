import type { HostRef } from '@orkestra/core/primitives/host/api';
import type { McpServer } from '@orkestra/core/primitives/mcp/api';
import { runtimeResolveErrorAsError } from '@orkestra/core/services/runtime-broker/api';
import type { RuntimeBroker } from '@orkestra/core/services/runtime-broker/api';
import { err, ok, type Result } from '@orkestra/shared';
import type { PlanMcpServer } from './plugin-reader';
import type { PluginHostTarget } from './plugin-service';

type AgentConfigClient =
  Awaited<ReturnType<RuntimeBroker['client']>> extends infer R
    ? R extends { success: true; data: infer D }
      ? D extends { agentConfig: infer A }
        ? A
        : never
      : never
    : never;

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'Bilinmeyen hata';
}

/** Mevcut agent-config çalışma zamanı (skills + MCP) üzerinden host hedefi oluşturur. */
export async function resolveRuntimeHostTarget(
  runtimes: Pick<RuntimeBroker, 'client'>,
  host: HostRef
): Promise<Result<PluginHostTarget, string>> {
  const runtime = await runtimes.client(host);
  if (!runtime.success) return err(runtimeResolveErrorAsError(runtime.error).message);
  const config: AgentConfigClient = runtime.data.agentConfig;

  const target: PluginHostTarget = {
    async listSkills() {
      const snapshot = await config.skills.state(undefined, 'list').asLiveSource().snapshot();
      const skills = snapshot.data as { id: string; installId?: string; skillMdContent?: string }[];
      return skills.map((skill) => ({
        installId: skill.installId ?? skill.id,
        content: skill.skillMdContent,
      }));
    },
    async installSkill({ installId, content }) {
      const result = await config.installSkill({
        skill: { id: installId, installId, skillMdContent: content, source: 'local' },
      });
      return result.success ? ok(undefined) : err(describeError(result.error));
    },
    async removeSkill(installId) {
      const result = await config.removeSkill({ name: installId });
      return result.success ? ok(undefined) : err(describeError(result.error));
    },
    async listMcpServers() {
      const snapshot = await config.mcpServers.state(undefined, 'list').asLiveSource().snapshot();
      return snapshot.data as McpServer[];
    },
    async saveMcpServer(server: PlanMcpServer, providers: string[]) {
      const payload: McpServer = {
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
        env: server.env,
        headers: server.headers,
        cwd: server.cwd,
        enabled: true,
        providers,
      };
      const result = await config.saveMcpServer({ server: payload });
      return result.success ? ok(undefined) : err(describeError(result.error));
    },
    async removeMcpServer(name) {
      const result = await config.removeMcpServer({ name });
      return result.success ? ok(undefined) : err(describeError(result.error));
    },
  };
  return ok(target);
}
