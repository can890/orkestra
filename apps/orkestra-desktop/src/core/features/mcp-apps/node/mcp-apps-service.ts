import { createHash } from 'node:crypto';
import { isLocalHostRef } from '@orkestra/core/primitives/host/api';
import type { McpServer } from '@orkestra/core/primitives/mcp/api';
import {
  mcpAppCspSchema,
  mcpAppToolCallableByApp,
  mcpAppToolResourceUri,
  mcpServerNameMatches,
  mcpToolIsReadOnly,
  mcpToolTitle,
  readMcpAppCsp,
  readMcpAppDocument,
  readMcpAppPermissions,
  type TranscriptMcpCallResult,
} from '@orkestra/core/runtimes/acp/api/client';
import { err, ok, type Result } from '@orkestra/shared';
import type { Logger } from '@orkestra/shared/logger';
import type {
  McpAppResolveInput,
  McpAppResolveResult,
  McpAppsError,
  McpAppViewDto,
} from '../api/contract';
import {
  HttpMcpTransport,
  McpClient,
  StdioMcpTransport,
  type McpToolDefinition,
  type McpTransport,
} from './mcp-client';
import type { McpAppSnapshot, McpAppSnapshotStore } from './snapshot-store';

/** Kullanılmayan bağlantı bu süre sonra kapatılır. */
const IDLE_CLOSE_MS = 5 * 60_000;
const MAX_CONNECTIONS = 8;
const CONNECT_TIMEOUT_MS = 20_000;

/** Bir MCP sunucusuna açık bağlantı; araç listesi bağlantı ömrü boyunca önbelleğe alınır. */
export interface McpAppConnection {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
  close(): Promise<void>;
  readonly isClosed: boolean;
}

export type McpAppsServiceDeps = {
  store: McpAppSnapshotStore;
  /** Genel ayar ve sunucu başına kapatma listesi; `server` sağlayıcının bildirdiği addır. */
  isEnabled(server: string): Promise<boolean>;
  /** Sağlayıcının yapılandırmasındaki MCP sunucuları (yalnızca yerel makine). */
  listServers(providerId: string): Promise<McpServer[]>;
  /** Sunucuya bağlanır; testler kendi bağlantısını verebilir. */
  connect?: (server: McpServer) => Promise<McpAppConnection>;
  clientInfo: { name: string; version: string };
  logger: Logger;
  now?: () => number;
};

type PooledConnection = {
  connection: Promise<McpAppConnection>;
  tools?: Promise<McpToolDefinition[]>;
  timer?: NodeJS.Timeout;
  lastUsed: number;
};

const failure = (type: McpAppsError['type'], message: string): McpAppsError => ({ type, message });

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() ? error.message : 'Request failed.';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Sunucu tanımını bir MCP taşımasına çevirir. HTTP'de yalnızca yapılandırılmış başlıklar gider. */
export function transportFor(server: McpServer): McpTransport | null {
  if (server.transport === 'stdio' && server.command) {
    return new StdioMcpTransport({
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    });
  }
  if (server.transport === 'http' && server.url && /^https?:\/\//i.test(server.url)) {
    return new HttpMcpTransport({
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    });
  }
  return null;
}

export async function connectMcpServer(
  server: McpServer,
  clientInfo: { name: string; version: string }
): Promise<McpAppConnection> {
  const transport = transportFor(server);
  if (!transport) throw new Error('This MCP server definition cannot be reached by Orkestra.');
  const client = new McpClient(transport, { clientInfo });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out connecting to the MCP server.')),
          CONNECT_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    listTools: () => client.listTools(),
    callTool: (name, args) => client.callTool(name, args),
    readResource: (uri) => client.readResource(uri),
    close: () => client.close(),
    get isClosed() {
      return client.isClosed;
    },
  };
}

/**
 * MCP Apps ana makine servisi (ana süreç). Bir araç çağrısının uygulamasını çözer ve anlık
 * görüntüsünü saklar; uygulamanın araç/kaynak isteklerini YALNIZCA o çağrının sunucusuna iletir.
 * Sunucu, ajanın kullandığı yapılandırmadan (sağlayıcının MCP listesi) bulunur ve Orkestra ona
 * kendisi bağlanır. Onay (kullanıcıya sorma) sohbet arayüzündeki aracıda yapılır; burada görünürlük
 * (`_meta.ui.visibility`) ve ayarlar zorunlu kılınır.
 */
export class McpAppsService {
  private readonly pool = new Map<string, PooledConnection>();
  private disposed = false;

  constructor(private readonly deps: McpAppsServiceDeps) {}

  async resolve(input: McpAppResolveInput): Promise<Result<McpAppResolveResult, McpAppsError>> {
    const none = (reason: Extract<McpAppResolveResult, { status: 'none' }>['reason']) =>
      ok<McpAppResolveResult>({ status: 'none', reason });
    if (!isLocalHostRef(input.host)) return none('remote-host');
    if (!(await this.deps.isEnabled(input.server))) return none('disabled');

    const stored = await this.deps.store.read(input.conversationId, input.toolCallId);
    if (stored) {
      const snapshot = await this.backfill(stored, input);
      const definition = await this.findServer(snapshot.providerId, snapshot.serverName, true);
      return ok({ status: 'ready', app: this.view(snapshot, definition !== null) });
    }

    const definition = await this.findServer(input.providerId, input.server, false);
    if (!definition) return none('unknown-server');

    let tool: McpToolDefinition | undefined;
    let contents: unknown[];
    let uri: string | undefined;
    try {
      tool = await this.findTool(definition, input.providerId, input.tool);
      uri = tool ? mcpAppToolResourceUri(tool._meta) : undefined;
      if (!tool || !uri) return none('no-app');
      const read = await (await this.connection(definition, input.providerId)).readResource(uri);
      contents = isObject(read) && Array.isArray(read.contents) ? read.contents : [];
    } catch (error) {
      this.deps.logger.warn('MCP app could not be resolved', {
        server: definition.name,
        error: errorMessage(error),
      });
      return none('unreachable');
    }

    const document = readMcpAppDocument(contents, uri);
    if (!document) return none('no-app');
    if (document.html === null) return none('too-large');
    const ui = isObject(document.meta) ? document.meta : {};
    const csp = readMcpAppCsp(ui.csp);
    const permissions = readMcpAppPermissions(ui.permissions);
    const snapshot: McpAppSnapshot = {
      version: 1,
      conversationId: input.conversationId,
      toolCallId: input.toolCallId,
      providerId: input.providerId,
      server: input.server,
      serverName: definition.name,
      tool: input.tool,
      resourceUri: uri,
      html: document.html,
      ...(csp ? { csp: mcpAppCspSchema.parse(csp) } : {}),
      ...(permissions ? { permissions: { ...permissions } } : {}),
      ...(typeof ui.prefersBorder === 'boolean' ? { prefersBorder: ui.prefersBorder } : {}),
      ...(input.input ? { input: input.input } : {}),
      ...(input.result ? { result: input.result } : {}),
      toolDefinition: tool,
      createdAt: (this.deps.now ?? Date.now)(),
    };
    try {
      await this.deps.store.write(snapshot);
    } catch (error) {
      // Saklanamasa da uygulama bu oturumda gösterilir; geçmişte yeniden çözülür.
      this.deps.logger.warn('MCP app snapshot could not be saved', { error: errorMessage(error) });
    }
    return ok({ status: 'ready', app: this.view(snapshot, true) });
  }

  async toolInfo(input: {
    conversationId: string;
    toolCallId: string;
    name: string;
  }): Promise<Result<{ callable: boolean; readOnly: boolean; title?: string }, McpAppsError>> {
    const target = await this.target(input);
    if (!target.success) return target;
    try {
      const tool = await this.findTool(
        target.data.definition,
        target.data.snapshot.providerId,
        input.name
      );
      const title = tool ? mcpToolTitle(tool) : undefined;
      return ok({
        callable: tool !== undefined && mcpAppToolCallableByApp(tool._meta),
        readOnly: tool !== undefined && mcpToolIsReadOnly(tool),
        ...(title !== undefined ? { title } : {}),
      });
    } catch (error) {
      return err(failure('unreachable', errorMessage(error)));
    }
  }

  async callTool(input: {
    conversationId: string;
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<Result<TranscriptMcpCallResult, McpAppsError>> {
    const target = await this.target(input);
    if (!target.success) return target;
    const { definition, snapshot } = target.data;
    try {
      // Görünürlük sunucu tarafında zorunlu: istemci denetimi spesifikasyonu güvenceye almaz.
      const tool = await this.findTool(definition, snapshot.providerId, input.name);
      if (!tool || !mcpAppToolCallableByApp(tool._meta)) {
        return err(failure('tool-not-callable', 'This app cannot call that tool.'));
      }
      const connection = await this.connection(definition, snapshot.providerId);
      const result = await connection.callTool(input.name, input.arguments);
      if (!isObject(result) || !Array.isArray(result.content)) {
        return err(failure('request-failed', 'The MCP server returned an invalid result.'));
      }
      return ok({
        content: result.content,
        ...(isObject(result.structuredContent)
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError === true ? { isError: true } : {}),
        ...(isObject(result._meta) ? { _meta: result._meta } : {}),
      });
    } catch (error) {
      return err(failure('request-failed', errorMessage(error)));
    }
  }

  async readResource(input: {
    conversationId: string;
    toolCallId: string;
    uri: string;
  }): Promise<Result<{ contents: unknown[] }, McpAppsError>> {
    const target = await this.target(input);
    if (!target.success) return target;
    try {
      const connection = await this.connection(
        target.data.definition,
        target.data.snapshot.providerId
      );
      const read = await connection.readResource(input.uri);
      return ok({ contents: isObject(read) && Array.isArray(read.contents) ? read.contents : [] });
    } catch (error) {
      return err(failure('request-failed', errorMessage(error)));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(entries.map((entry) => this.closeEntry(entry)));
  }

  // ── iç yardımcılar ──────────────────────────────────────────────────────────

  private view(snapshot: McpAppSnapshot, live: boolean): McpAppViewDto {
    return {
      server: snapshot.server,
      tool: snapshot.tool,
      resourceUri: snapshot.resourceUri,
      html: snapshot.html,
      ...(snapshot.csp ? { csp: snapshot.csp } : {}),
      ...(snapshot.permissions ? { permissions: snapshot.permissions } : {}),
      ...(snapshot.prefersBorder !== undefined ? { prefersBorder: snapshot.prefersBorder } : {}),
      ...(snapshot.input ? { input: snapshot.input } : {}),
      ...(snapshot.result ? { result: snapshot.result } : {}),
      ...(snapshot.toolDefinition !== undefined ? { toolDefinition: snapshot.toolDefinition } : {}),
      live,
      hostVersion: this.deps.clientInfo.version,
    };
  }

  /** Anlık görüntüde eksik olan girdi/sonucu (sonradan gelmişse) tamamlar. */
  private async backfill(
    snapshot: McpAppSnapshot,
    input: McpAppResolveInput
  ): Promise<McpAppSnapshot> {
    const missingInput = snapshot.input === undefined && input.input !== undefined;
    const missingResult = snapshot.result === undefined && input.result !== undefined;
    if (!missingInput && !missingResult) return snapshot;
    const next: McpAppSnapshot = {
      ...snapshot,
      ...(missingInput ? { input: input.input } : {}),
      ...(missingResult ? { result: input.result } : {}),
    };
    await this.deps.store.write(next).catch(() => undefined);
    return next;
  }

  /** Uygulamanın kendi sunucusu: yalnızca kayıtlı anlık görüntüden, renderer'a güvenilmeden. */
  private async target(input: {
    conversationId: string;
    toolCallId: string;
  }): Promise<Result<{ snapshot: McpAppSnapshot; definition: McpServer }, McpAppsError>> {
    const snapshot = await this.deps.store.read(input.conversationId, input.toolCallId);
    if (!snapshot) return err(failure('not-an-app', 'This tool call has no MCP app.'));
    if (!(await this.deps.isEnabled(snapshot.server))) {
      return err(failure('disabled', 'Interactive apps from this MCP server are turned off.'));
    }
    const definition = await this.findServer(snapshot.providerId, snapshot.serverName, true);
    if (!definition) {
      return err(failure('unreachable', 'The MCP server of this app is no longer configured.'));
    }
    return ok({ snapshot, definition });
  }

  private async findServer(
    providerId: string,
    name: string,
    exact: boolean
  ): Promise<McpServer | null> {
    let servers: McpServer[];
    try {
      servers = await this.deps.listServers(providerId);
    } catch (error) {
      this.deps.logger.warn('MCP servers could not be listed for MCP apps', {
        providerId,
        error: errorMessage(error),
      });
      return null;
    }
    const usable = servers.filter((server) => server.enabled !== false);
    return (
      usable.find((server) => server.name === name) ??
      (exact ? undefined : usable.find((server) => mcpServerNameMatches(server.name, name))) ??
      null
    );
  }

  private keyOf(definition: McpServer, providerId: string): string {
    // Tanım değişirse (ör. yeni başlık/env) yeni bağlantı açılır. Anahtar gizli değer içermez.
    const fingerprint = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    return `${providerId}\u0000${definition.name}\u0000${fingerprint}`;
  }

  private async connection(definition: McpServer, providerId: string): Promise<McpAppConnection> {
    return (await this.entry(definition, providerId)).connection;
  }

  private async findTool(
    definition: McpServer,
    providerId: string,
    name: string
  ): Promise<McpToolDefinition | undefined> {
    const entry = await this.entry(definition, providerId);
    const connection = await entry.connection;
    entry.tools ??= connection.listTools();
    let tools: McpToolDefinition[];
    try {
      tools = await entry.tools;
    } catch (error) {
      entry.tools = undefined;
      throw error;
    }
    const found = tools.find((tool) => tool.name === name);
    if (found) return found;
    // Araç listesi değişmiş olabilir: bir kez yenilenir.
    entry.tools = connection.listTools();
    return (await entry.tools).find((tool) => tool.name === name);
  }

  private async entry(definition: McpServer, providerId: string): Promise<PooledConnection> {
    if (this.disposed) throw new Error('MCP apps are shutting down.');
    const key = this.keyOf(definition, providerId);
    let entry = this.pool.get(key);
    if (entry) {
      const connection = await entry.connection.catch(() => null);
      if (!connection || connection.isClosed) {
        this.pool.delete(key);
        entry = undefined;
      }
    }
    if (!entry) {
      await this.evictIfFull();
      const connect =
        this.deps.connect ??
        ((server: McpServer) => connectMcpServer(server, this.deps.clientInfo));
      const created: PooledConnection = { connection: connect(definition), lastUsed: 0 };
      // Başarısız bağlantı havuzda kalmaz.
      created.connection.catch(() => {
        if (this.pool.get(key) === created) this.pool.delete(key);
      });
      this.pool.set(key, created);
      entry = created;
    }
    this.touch(key, entry);
    return entry;
  }

  private touch(key: string, entry: PooledConnection) {
    entry.lastUsed = (this.deps.now ?? Date.now)();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.pool.get(key) !== entry) return;
      this.pool.delete(key);
      void this.closeEntry(entry);
    }, IDLE_CLOSE_MS);
    entry.timer.unref?.();
  }

  private async evictIfFull() {
    if (this.pool.size < MAX_CONNECTIONS) return;
    const oldest = [...this.pool.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!oldest) return;
    this.pool.delete(oldest[0]);
    await this.closeEntry(oldest[1]);
  }

  private async closeEntry(entry: PooledConnection) {
    clearTimeout(entry.timer);
    const connection = await entry.connection.catch(() => null);
    await connection?.close().catch(() => undefined);
  }
}
