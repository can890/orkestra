import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { TuiSessionMcpServer } from '#runtimes/tui-agents/api';
import type { ResolvedTuiProvider } from '#services/agent-plugins/api/plugins';

/** Bayat dizin temizliği bu önekle eşleşen geçici dizinleri hedefler. */
export const SESSION_MCP_TEMP_DIR_PREFIX = 'orkestra-tui-mcp-';

export type PreparedSessionMcp = {
  /** Sağlayıcı komutunun argümanlarının başına eklenir. */
  args: string[];
  /** Oturumun yapılandırma dizinini siler; birden çok çağrı güvenlidir. */
  cleanup: () => Promise<void>;
};

export type SessionMcpFileDeps = {
  /** 0700 izinli, oturuma özel dizin oluşturur (varsayılan: `mkdtemp`). */
  createTempDir?: () => Promise<string>;
  writeConfigFile?: (filePath: string, contents: string) => Promise<void>;
  removeTempDir?: (directory: string) => Promise<void>;
};

export type PrepareSessionMcpParams = {
  servers: readonly TuiSessionMcpServer[] | undefined;
  provider: Pick<ResolvedTuiProvider, 'buildSessionMcp'>;
  platform: NodeJS.Platform;
};

/**
 * Orkestra'nın araç sunucularını sağlayıcının oturuma özel MCP mekanizmasıyla hazırlar. Dosyalar
 * TUI çalışma zamanının bulunduğu makinede (uzak makinede de) yazılır: dizin 0700, dosyalar 0600.
 * Sunucu yoksa ya da sağlayıcının oturuma özel mekanizması yoksa null döner. Hata fırlatırsa
 * çağıran oturumu araçlar olmadan başlatmalıdır; yarım kalan dizin burada silinir.
 */
export async function prepareSessionMcp(
  params: PrepareSessionMcpParams,
  deps: SessionMcpFileDeps = {}
): Promise<PreparedSessionMcp | null> {
  const servers = params.servers ?? [];
  const build = params.provider.buildSessionMcp;
  if (servers.length === 0 || !build) return null;

  const createTempDir =
    deps.createTempDir ?? (() => mkdtemp(join(tmpdir(), SESSION_MCP_TEMP_DIR_PREFIX)));
  const writeConfigFile =
    deps.writeConfigFile ??
    ((filePath: string, contents: string) =>
      // `wx`: yeni dizinde var olan bir dosyanın (ya da bağlantının) üzerine yazılmaz.
      writeFile(filePath, contents, { mode: 0o600, flag: 'wx' }));
  const removeTempDir =
    deps.removeTempDir ?? ((directory: string) => rm(directory, { recursive: true, force: true }));

  const directory = await createTempDir();
  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    removed = true;
    await removeTempDir(directory);
  };
  try {
    const launch = build(
      servers.map((server) => ({ ...server, args: [...server.args] })),
      { platform: params.platform, filePath: (name) => join(directory, name) }
    );
    for (const file of launch.files) {
      if (!file.name || basename(file.name) !== file.name || file.name.startsWith('.')) {
        throw new Error(`Invalid session MCP file name: ${JSON.stringify(file.name)}`);
      }
      await writeConfigFile(join(directory, file.name), file.contents);
    }
    if (launch.files.length === 0) await cleanup();
    if (launch.args.length === 0) {
      await cleanup();
      return null;
    }
    return { args: launch.args, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
