import { dirname, join } from 'node:path';
import { resolveDefaultSubagentsDir } from '#runtimes/acp/node/session/subagent-state-watcher';

/** Masaüstünün yönlendirme anlık görüntüsünü yazdığı, `orkestra-subagents` köprüsünün okuduğu dosya. */
export function resolveSubagentRoutingFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORKESTRA_SUBAGENTS_ROUTING_FILE?.trim())
    return env.ORKESTRA_SUBAGENTS_ROUTING_FILE.trim();
  const stateDir = env.ORKESTRA_SUBAGENTS_DIR?.trim() || resolveDefaultSubagentsDir();
  return join(dirname(stateDir), 'subagent-routing.json');
}
