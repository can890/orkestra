import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRef } from '@orkestra/core/primitives/host/api';
import type { McpServer } from '@orkestra/core/primitives/mcp/api';
import { err, ok, type Result } from '@orkestra/shared';
import { app, shell } from 'electron';
import type { McpConnectionState } from '../api/connection';
import type { McpRuntimeBroker } from '../api/runtime-adapter';
import { googleTool, loginGoogle, readGoogleClient } from './google-login';

type Session = {
  state: McpConnectionState;
  child?: ChildProcess;
  abort?: AbortController;
  directory?: string;
  timer?: ReturnType<typeof setTimeout>;
};
type Dependencies = {
  resolveCli?: () => Promise<string>;
  spawnLogin?: typeof spawn;
  openUrl?: (url: string) => Promise<unknown>;
};
export function authorizationUrl(output: string): string | undefined {
  for (const candidate of output.replace(/\x1b\[[0-9;]*m/g, '').match(/https:\/\/[^\s<>"']+/g) ??
    []) {
    try {
      const url = new URL(candidate);
      if (
        url.searchParams.get('response_type') === 'code' &&
        url.searchParams.has('state') &&
        url.searchParams.has('client_id') &&
        !url.username &&
        !url.password
      )
        return url.href;
    } catch {
      /* Beklenmeyen CLI çıktısını atla. */
    }
  }
  return undefined;
}
export function readLoginGrant(value: unknown, name: string, url: string) {
  if (!value || typeof value !== 'object') throw new Error('invalid-grant');
  for (const entry of Object.values(value)) {
    if (!entry || typeof entry !== 'object') continue;
    const grant = entry as Record<string, unknown>;
    if (
      grant.server_name !== name ||
      grant.server_url !== url ||
      typeof grant.access_token !== 'string' ||
      !grant.access_token ||
      typeof grant.client_id !== 'string' ||
      !grant.client_id
    )
      continue;
    return {
      server_name: name,
      server_url: url,
      client_id: grant.client_id,
      access_token: grant.access_token,
      ...(typeof grant.issuer === 'string' ? { issuer: grant.issuer } : {}),
      ...(typeof grant.refresh_token === 'string' ? { refresh_token: grant.refresh_token } : {}),
      expires_at: typeof grant.expires_at === 'number' ? grant.expires_at : null,
      scopes: Array.isArray(grant.scopes)
        ? grant.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [],
    };
  }
  throw new Error('missing-grant');
}
async function resolveCodexCli(): Promise<string> {
  const candidates = [
    join(homedir(), '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    ...(process.env.PATH ?? '')
      .split(':')
      .filter(Boolean)
      .map((path) => join(path, process.platform === 'win32' ? 'codex.exe' : 'codex')),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Sonraki kurulu CLI konumunu dene. */
    }
  }
  throw new Error('missing-cli');
}

export class McpConnectionManager {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly runtimes: McpRuntimeBroker,
    private readonly dependencies: Dependencies = {}
  ) {}

  start(input: {
    host: HostRef;
    server: McpServer;
  }): Result<McpConnectionState, { type: 'invalid-state'; message: string }> {
    if (!input.server.providers.length)
      return err({
        type: 'invalid-state',
        message: 'Bu makinede bağlantıyı kullanacak en az bir ajan kurulu olmalı.',
      });
    if (
      !googleTool(input.server.name) &&
      (input.server.transport !== 'http' ||
        !input.server.url ||
        !input.server.url.startsWith('https://'))
    )
      return err({
        type: 'invalid-state',
        message:
          'Bu servis doğrudan hesap girişini desteklemiyor. Servisin erişim anahtarını gelişmiş ayarlardan ekleyin.',
      });
    if (!/^[\w.-]+$/.test(input.server.name))
      return err({ type: 'invalid-state', message: 'Bağlantı adı geçerli değil.' });
    for (const [id, session] of this.sessions) {
      if (['connected', 'failed', 'cancelled'].includes(session.state.phase))
        this.sessions.delete(id);
    }
    if (this.sessions.size >= 8)
      return err({
        type: 'invalid-state',
        message: 'Önce açık hesap bağlantılarından birini tamamlayın.',
      });
    const session: Session = {
      state: { id: randomUUID(), phase: 'starting', message: 'Hesap giriş sayfası hazırlanıyor…' },
    };
    this.sessions.set(session.state.id, session);
    session.timer = setTimeout(
      () => {
        void this.stop(session, 'failed', 'Giriş süresi doldu. Yeniden bağlayın.');
      },
      10 * 60 * 1000
    );
    session.timer.unref();
    void this.login(session, input);
    return ok({ ...session.state });
  }
  status(id: string): McpConnectionState {
    return {
      ...(this.sessions.get(id)?.state ?? {
        id,
        phase: 'failed',
        message: 'Bağlantı işlemi sona erdi. Yeniden bağlayın.',
      }),
    };
  }
  async cancel(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session && !['saving', 'connected', 'failed', 'cancelled'].includes(session.state.phase))
      await this.stop(session, 'cancelled', 'Hesap bağlantısı iptal edildi.');
  }
  private active(session: Session) {
    return ['starting', 'awaiting-authorization'].includes(session.state.phase);
  }
  private async login(session: Session, input: { host: HostRef; server: McpServer }) {
    try {
      const runtime = await this.runtimes.client(input.host);
      if (!runtime.success) throw new Error('host-unavailable');
      const tool = googleTool(input.server.name);
      if (tool) {
        const clientPath =
          process.env.ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE ??
          join(app.getPath('userData'), 'oauth', 'google-client.json');
        const client = await readGoogleClient(clientPath).catch(async () => {
          if (process.env.ORKESTRA_GOOGLE_OAUTH_CLIENT_FILE)
            throw new Error('google-client-missing');
          return readGoogleClient(join(process.resourcesPath, 'oauth', 'google-client.json'));
        });
        if (!this.active(session)) return;
        session.abort = new AbortController();
        const grant = await loginGoogle({
          name: input.server.name,
          tool,
          client,
          signal: session.abort.signal,
          onUrl: (url) => {
            if (!this.active(session)) return;
            session.state = {
              id: session.state.id,
              phase: 'awaiting-authorization',
              url,
              message:
                'Açılan Google sayfasında hesabınızı seçip bu servisin izinlerini onaylayın.',
            };
            const open =
              this.dependencies.openUrl ?? (async (address: string) => shell.openExternal(address));
            void open(url).catch(() => {
              if (this.active(session))
                session.state.message =
                  'Google giriş sayfası açılamadı. “Giriş sayfasını aç” ile tekrar deneyin.';
            });
          },
        });
        if (!this.active(session)) return;
        session.state = {
          id: session.state.id,
          phase: 'saving',
          message: 'Google hesabı seçilen makineye ve ajanlara bağlanıyor…',
        };
        const saved = await runtime.data.agentConfig.installMcpOAuth({
          grant,
          providers: input.server.providers,
        });
        if (!saved.success) throw new Error('save-failed');
        session.state = {
          id: session.state.id,
          phase: 'connected',
          message: 'Google hesabı bağlandı. Yeni ajan sohbetlerinde bu servisi kullanabilirsiniz.',
        };
        return;
      }
      if (input.server.oauth === false) {
        const response = await fetch(input.server.url!, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'Orkestra', version: '1.2.6' },
            },
          }),
        });
        if (!response.ok) throw new Error('public-service-unavailable');
        const contentType = response.headers.get('Content-Type') ?? '';
        const initialized = contentType.includes('application/json')
          ? await response.json()
          : contentType.includes('text/event-stream')
            ? (await response.text())
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => {
                  try {
                    return JSON.parse(line.slice(5));
                  } catch {
                    return undefined;
                  }
                })
                .find((value) => value?.id === 1)
            : undefined;
        if (!initialized?.result?.serverInfo || !initialized?.result?.protocolVersion)
          throw new Error('public-service-unavailable');
        if (!this.active(session)) return;
        session.state = {
          id: session.state.id,
          phase: 'saving',
          message: 'Servis bağlantısı ajanlara kaydediliyor…',
        };
        const saved = await runtime.data.agentConfig.saveMcpServer({ server: input.server });
        if (!saved.success) throw new Error('save-failed');
        session.state = {
          id: session.state.id,
          phase: 'connected',
          message: 'Servis bağlandı. Bu servis hesap girişi gerektirmiyor.',
        };
        return;
      }
      const cli = await (this.dependencies.resolveCli ?? resolveCodexCli)();
      if (!this.active(session)) return;
      session.directory = await mkdtemp(join(tmpdir(), 'orkestra-account-'));
      await chmod(session.directory, 0o700);
      if (!this.active(session)) {
        await this.cleanup(session);
        return;
      }
      const server = input.server;
      const args = [
        '-c',
        'mcp_oauth_credentials_store="file"',
        '-c',
        'mcp_servers.' + server.name + '.url=' + JSON.stringify(server.url),
        'mcp',
        'login',
        server.name,
      ];
      if (server.name === 'elevenlabs')
        args.push('--scopes', 'text_to_speech,speech_history_read,flows');
      const child = (this.dependencies.spawnLogin ?? spawn)(cli, args, {
        env: { ...process.env, CODEX_HOME: session.directory },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      session.child = child;
      let output = '';
      const consume = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-32768);
        const url = authorizationUrl(output);
        if (url && session.state.url !== url && this.active(session)) {
          session.state = {
            id: session.state.id,
            phase: 'awaiting-authorization',
            url,
            message: 'Açılan sayfada hesabınıza giriş yapıp bağlantıya izin verin.',
          };
          const open =
            this.dependencies.openUrl ?? (async (address: string) => shell.openExternal(address));
          void open(url).catch(() => {
            if (this.active(session))
              session.state.message =
                'Giriş sayfası açılamadı. “Giriş sayfasını aç” ile tekrar deneyin.';
          });
        }
      };
      child.stdout?.on('data', consume);
      child.stderr?.on('data', consume);
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (!this.active(session)) return;
      if (exitCode !== 0)
        throw new Error(
          output.includes('does not support OAuth') || output.includes('No OAuth')
            ? 'unsupported-oauth'
            : 'login-failed'
        );
      const grant = readLoginGrant(
        JSON.parse(await readFile(join(session.directory, '.credentials.json'), 'utf8')),
        server.name,
        server.url!
      );
      if (!this.active(session)) return;
      session.state = {
        id: session.state.id,
        phase: 'saving',
        message: 'Hesap bağlantısı seçilen makineye ve ajanlara kaydediliyor…',
      };
      const saved = await runtime.data.agentConfig.installMcpOAuth({
        grant,
        providers: server.providers,
      });
      if (!saved.success) throw new Error('save-failed');
      session.state = {
        id: session.state.id,
        phase: 'connected',
        message: 'Hesap bağlandı. Yeni ajan sohbetlerinde bu servisi kullanabilirsiniz.',
      };
    } catch (error) {
      if (this.active(session) || session.state.phase === 'saving') {
        const reason = error instanceof Error ? error.message : '';
        session.state = {
          id: session.state.id,
          phase: 'failed',
          message:
            reason === 'google-client-missing'
              ? 'Orkestra’nın Google giriş kaydı henüz kurulmamış. Uygulama yöneticisi bağlantı kaydını tamamlamalı; bu sorun hesabınızdan kaynaklanmıyor.'
              : reason === 'google-denied'
                ? 'Google bağlantısına izin vermediniz. Yeniden bağlayıp izin verebilirsiniz.'
                : reason === 'google-scopes-missing'
                  ? 'Bu servisin bazı Google izinleri verilmedi. Yeniden bağlayıp istenen izinleri onaylayın.'
                  : reason.startsWith('google-')
                    ? 'Google hesabı doğrulanamadı. Google girişini yeniden deneyin.'
                    : reason === 'missing-cli'
                      ? 'Hesap bağlantısı için bu bilgisayarda Codex CLI kurulmalı.'
                      : reason === 'unsupported-oauth'
                        ? 'Servis hesapla girişi desteklemiyor. Erişim anahtarını gelişmiş ayarlardan ekleyin.'
                        : reason === 'host-unavailable'
                          ? 'Seçilen makineye ulaşılamadı. Makine bağlantısını kontrol edin.'
                          : reason === 'save-failed'
                            ? 'Giriş tamamlandı, ancak bağlantı makineye kaydedilemedi. Makineyi yeniden bağlayıp tekrar deneyin.'
                            : 'Hesap bağlantısı tamamlanamadı. Servisin giriş izinlerini kontrol edip yeniden deneyin.',
        };
      }
    } finally {
      if (session.timer) clearTimeout(session.timer);
      await this.cleanup(session);
    }
  }
  private async stop(session: Session, phase: 'failed' | 'cancelled', message: string) {
    session.state = { id: session.state.id, phase, message };
    if (session.timer) clearTimeout(session.timer);
    session.abort?.abort();
    session.child?.kill('SIGTERM');
    const child = session.child;
    if (child && child.exitCode === null) {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2000);
      timer.unref();
    }
    await this.cleanup(session);
  }
  private async cleanup(session: Session) {
    if (session.directory)
      await rm(session.directory, { recursive: true, force: true }).catch(() => {});
  }
}
