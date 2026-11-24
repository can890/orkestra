import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { isLocalHostRef } from '@orkestra/core/primitives/host/api';
import {
  MEDIA_PROVIDER_IDS,
  MEDIA_PROVIDER_INFO,
  type MediaProviderId,
  type MediaProvidersSettings,
  type MediaProviderStatus,
} from '@core/features/media-providers/api/media-providers-model';
import type {
  AgentToolsMcpServer,
  ConversationMcpServerProvider,
  ConversationToolContext,
} from '@core/services/agent-tools/api/agent-tools';

export type MediaCliResult = { exitCode: number; stdout: string; timedOut: boolean };

/** Enjekte edilen çalıştırıcı; testler sahte CLI betikleriyle çalışır. */
export type MediaCliRunner = (
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv }
) => Promise<MediaCliResult>;

export const nodeMediaCliRunner: MediaCliRunner = (executable, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      executable,
      [...args],
      { encoding: 'utf8', timeout: options.timeoutMs, env: options.env, windowsHide: true },
      (error, stdout) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          exitCode: failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0,
          stdout: String(stdout ?? ''),
          timedOut: failure?.killed === true,
        });
      }
    );
    child.stdin?.end();
  });

/**
 * Algılama komutları: sürüm (`--version`) ve zararsız oturum denetimi. Higgsfield için
 * `account status` (yalnızca çıkış kodu kullanılır; e-posta okunmaz), Flow için `auth status`
 * (çerezle oturum yoklar, tarayıcı açmaz, kredi harcamaz).
 */
const DETECTION: Record<MediaProviderId, { version: string[]; status: string[] }> = {
  higgsfield: { version: ['--version'], status: ['account', 'status', '--json'] },
  flow: { version: ['--version'], status: ['auth', 'status'] },
};

export type MediaProvidersServiceDeps = {
  settings(): Promise<MediaProvidersSettings>;
  run: MediaCliRunner;
  /** Kullanıcı kabuk ortamı (PATH vb.). */
  env(): NodeJS.ProcessEnv;
  /** Masaüstü paketindeki köprü betiğinin yolu (`out/main/adapters/<ad>`); yoksa null. */
  adapterPath(fileName: string): string | null;
  /** Köprüyü çalıştıran Node (Electron ikilisi + `ELECTRON_RUN_AS_NODE`). */
  nodeExecutable: string;
  exists?: (path: string) => Promise<boolean>;
  home?: string;
  now?: () => number;
};

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Higgsfield ve Flow CLI'larını algılar, ayarlar sayfasına durum verir ve ayarı açık sağlayıcıları
 * yerel konuşmalara stdio MCP sunucusu (`orkestra-higgsfield`, `orkestra-flow`) olarak ekler.
 * CLI'lar yalnızca bu makinede bulunduğundan uzak (SSH) konuşmalara eklenmez.
 */
export class MediaProvidersService implements ConversationMcpServerProvider {
  private readonly cache = new Map<MediaProviderId, MediaProviderStatus>();
  private readonly now: () => number;

  constructor(private readonly deps: MediaProvidersServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private searchPath(): string[] {
    const home = this.deps.home ?? homedir();
    const extra = [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
    const fromEnv = (this.deps.env().PATH ?? '').split(delimiter).filter(Boolean);
    return [...new Set([...extra, ...fromEnv])];
  }

  private cliEnv(): NodeJS.ProcessEnv {
    return { ...this.deps.env(), PATH: this.searchPath().join(delimiter) };
  }

  async resolveCli(id: MediaProviderId): Promise<string | null> {
    const exists = this.deps.exists ?? isExecutable;
    for (const dir of this.searchPath()) {
      const candidate = join(dir, MEDIA_PROVIDER_INFO[id].cli);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  async status(refresh = false): Promise<MediaProviderStatus[]> {
    const settings = await this.deps.settings();
    return Promise.all(
      MEDIA_PROVIDER_IDS.map(async (id) => {
        const cached = this.cache.get(id);
        const detected = !refresh && cached ? cached : await this.detect(id);
        this.cache.set(id, detected);
        return {
          ...detected,
          enabled: settings[id].enabled,
          requireConfirmation: settings[id].requireConfirmation,
        };
      })
    );
  }

  private async detect(id: MediaProviderId): Promise<MediaProviderStatus> {
    const base = {
      id,
      enabled: false,
      requireConfirmation: true,
      checkedAt: this.now(),
    };
    const path = await this.resolveCli(id);
    if (!path) {
      return {
        ...base,
        cli: { available: false, path: null, version: null },
        signedIn: null,
        message: `The ${MEDIA_PROVIDER_INFO[id].cli} CLI was not found on PATH or in ~/.local/bin.`,
      };
    }
    const env = this.cliEnv();
    const version = await this.deps.run(path, DETECTION[id].version, { timeoutMs: 10_000, env });
    const status = await this.deps.run(path, DETECTION[id].status, { timeoutMs: 120_000, env });
    const signedIn = status.timedOut ? null : status.exitCode === 0;
    return {
      ...base,
      cli: {
        available: version.exitCode === 0,
        path,
        version: version.exitCode === 0 ? firstLine(version.stdout) : null,
      },
      signedIn,
      message:
        signedIn === false
          ? `Not signed in. Sign in with the ${MEDIA_PROVIDER_INFO[id].cli} CLI in a terminal.`
          : signedIn === null
            ? 'The sign-in check timed out.'
            : null,
    };
  }

  async conversationMcpServers(context: ConversationToolContext): Promise<AgentToolsMcpServer[]> {
    if (!isLocalHostRef(context.host)) return [];
    const settings = await this.deps.settings();
    const servers: AgentToolsMcpServer[] = [];
    for (const id of MEDIA_PROVIDER_IDS) {
      if (!settings[id].enabled) continue;
      const info = MEDIA_PROVIDER_INFO[id];
      const bridge = this.deps.adapterPath(info.adapter);
      const cli = await this.resolveCli(id);
      if (!bridge || !cli) continue;
      const env: Record<string, string> = {
        ELECTRON_RUN_AS_NODE: '1',
        ORKESTRA_MEDIA_CLI: cli,
        ORKESTRA_MEDIA_REQUIRE_CONFIRMATION: settings[id].requireConfirmation ? '1' : '0',
        PATH: this.searchPath().join(delimiter),
      };
      if (context.workspacePath) {
        env.ORKESTRA_MEDIA_OUTPUT_DIR = join(context.workspacePath, 'orkestra-media');
      }
      servers.push({
        name: info.serverName,
        command: this.deps.nodeExecutable,
        args: [bridge],
        env,
      });
    }
    return servers;
  }
}

function firstLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, 120) : null;
}
