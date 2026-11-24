import { homedir } from 'node:os';
import { pluginRegistry } from '@orkestra/plugins/agents';
import type { PolicyCliDeps } from './policy-cli';

/** Gerçek makinede `policy` komutlarının bağlamı. */
export function createNodePolicyDeps(): PolicyCliDeps {
  return {
    homeDirectory: homedir(),
    platform: process.platform,
    env: process.env,
    // Paketli başlatıcı sürümü dışa aktarır; kaynaktan çalışırken geçersiz kılma denenebilir.
    allowPathOverride: !process.env.ORKESTRA_WS_APP_VERSION,
    knownProviderIds: pluginRegistry.getAll().map((plugin) => plugin.metadata.id),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
