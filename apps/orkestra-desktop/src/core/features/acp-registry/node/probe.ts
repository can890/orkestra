// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: packages/provider-acp-registry/src/server/probe.ts
// Bir ACP ajanını kısa süreliğine başlatıp `initialize` el sıkışmasıyla yeteneklerini (giriş
// yöntemleri, oturum yükleme, MCP taşıyıcıları) okur; mümkünse geçici bir dizinde `session/new`
// açarak bildirilen modelleri/modları öğrenir. Yalnızca kullanıcı açıkça istediğinde çalışır.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type InitializeResponse,
  type NewSessionResponse,
} from '@agentclientprotocol/sdk';
import type { CustomAcpAuthMethod, CustomAcpProbe } from '@orkestra/plugins/agents';

const DEFAULT_TIMEOUT_MS = 20_000;

export type ProbeLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
};

export class AcpProbeError extends Error {}

export async function probeAcpAgent(
  launch: ProbeLaunch,
  options: { timeoutMs?: number; now?: () => number } = {}
): Promise<CustomAcpProbe> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sessionDir = await mkdtemp(join(tmpdir(), 'orkestra-acp-probe-'));
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd || sessionDir,
    env: launch.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2_000);
  });
  const exited = new Promise<never>((_, reject) => {
    child.once('error', (error) =>
      reject(new AcpProbeError(`Could not start agent: ${error.message}`))
    );
    child.once('exit', (code, signal) =>
      reject(
        new AcpProbeError(
          `Agent exited before answering (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})${stderrTail.trim() ? `: ${stderrTail.trim().slice(-500)}` : ''}`
        )
      )
    );
  });
  exited.catch(() => undefined);

  try {
    const client: Client = {
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => undefined,
      readTextFile: async () => {
        throw new Error('File access is not available while checking an agent.');
      },
      writeTextFile: async () => {
        throw new Error('File access is not available while checking an agent.');
      },
    };
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    );
    const connection = new ClientSideConnection(() => client, stream);
    const initialized = await withTimeout(
      Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'orkestra', version: '1' },
        }),
        exited,
      ]),
      timeoutMs,
      'Agent did not answer the ACP initialize request in time.'
    );

    let session: NewSessionResponse | undefined;
    let sessionError: string | undefined;
    try {
      session = await withTimeout(
        Promise.race([connection.newSession({ cwd: sessionDir, mcpServers: [] }), exited]),
        timeoutMs,
        'Agent did not open a session in time.'
      );
    } catch (error) {
      sessionError = describeError(error);
    }
    return buildProbe(initialized, session, sessionError, options.now?.() ?? Date.now());
  } catch (error) {
    if (error instanceof AcpProbeError) throw error;
    throw new AcpProbeError(describeError(error));
  } finally {
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    killTimer.unref();
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function buildProbe(
  initialized: InitializeResponse,
  session: NewSessionResponse | undefined,
  sessionError: string | undefined,
  now: number
): CustomAcpProbe {
  const capabilities = initialized.agentCapabilities ?? {};
  const info = (initialized as { agentInfo?: { name?: string; title?: string; version?: string } })
    .agentInfo;
  return {
    probedAt: now,
    protocolVersion:
      typeof initialized.protocolVersion === 'number' ? initialized.protocolVersion : null,
    ...(info?.title || info?.name
      ? { agentName: String(info.title || info.name).slice(0, 160) }
      : {}),
    ...(info?.version ? { agentVersion: String(info.version).slice(0, 128) } : {}),
    loadSession: capabilities.loadSession === true,
    mcp: {
      http: capabilities.mcpCapabilities?.http === true,
      sse: capabilities.mcpCapabilities?.sse === true,
    },
    authMethods: normalizeAuthMethods(initialized.authMethods),
    models: session ? sessionModels(session) : [],
    modes: session ? sessionModes(session) : [],
    ...(sessionError ? { sessionError: sessionError.slice(0, 1_024) } : {}),
  };
}

export function normalizeAuthMethods(raw: unknown): CustomAcpAuthMethod[] {
  if (!Array.isArray(raw)) return [];
  const methods: CustomAcpAuthMethod[] = [];
  for (const entry of raw.slice(0, 16)) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.name !== 'string') continue;
    const type = value.type === 'terminal' || value.type === 'env_var' ? value.type : 'agent';
    const method: CustomAcpAuthMethod = {
      id: value.id.slice(0, 128),
      name: value.name.slice(0, 160),
      type,
      ...(typeof value.description === 'string'
        ? { description: value.description.slice(0, 1_024) }
        : {}),
    };
    if (type === 'terminal') {
      method.args = Array.isArray(value.args)
        ? value.args.filter((arg): arg is string => typeof arg === 'string').slice(0, 32)
        : [];
      if (value.env && typeof value.env === 'object') {
        method.env = Object.fromEntries(
          Object.entries(value.env as Record<string, unknown>).filter(
            (pair): pair is [string, string] =>
              /^[A-Za-z_][A-Za-z0-9_]*$/u.test(pair[0]) && typeof pair[1] === 'string'
          )
        );
      }
    }
    if (type === 'env_var') {
      const vars = Array.isArray(value.vars) ? value.vars : [];
      method.vars = vars
        .filter(
          (v): v is { name: string; label?: unknown; optional?: unknown } =>
            !!v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string'
        )
        .filter((v) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(v.name))
        .slice(0, 16)
        .map((v) => ({
          name: v.name,
          ...(typeof v.label === 'string' ? { label: v.label.slice(0, 160) } : {}),
          ...(v.optional === true ? { optional: true } : {}),
        }));
      if (typeof value.link === 'string' && value.link.startsWith('https://'))
        method.link = value.link;
    }
    methods.push(method);
  }
  return methods;
}

type SelectOption = { value: string; name: string };

function flattenSelectOptions(options: unknown): SelectOption[] {
  if (!Array.isArray(options)) return [];
  const out: SelectOption[] = [];
  for (const option of options) {
    if (!option || typeof option !== 'object') continue;
    const value = option as { value?: unknown; name?: unknown; options?: unknown };
    if (Array.isArray(value.options)) out.push(...flattenSelectOptions(value.options));
    else if (typeof value.value === 'string')
      out.push({
        value: value.value,
        name: typeof value.name === 'string' ? value.name : value.value,
      });
  }
  return out;
}

function sessionModels(session: NewSessionResponse): Array<{ id: string; name: string }> {
  const fromConfig = (session.configOptions ?? []).find(
    (option) => option.category === 'model' && option.type === 'select'
  );
  const options = fromConfig
    ? flattenSelectOptions((fromConfig as { options?: unknown }).options)
    : [];
  if (options.length > 0) {
    return options
      .slice(0, 256)
      .map((o) => ({ id: o.value.slice(0, 512), name: o.name.slice(0, 256) }));
  }
  // Eski (unstable) `models` alanı.
  const legacy = (session as { models?: { availableModels?: unknown } }).models?.availableModels;
  if (!Array.isArray(legacy)) return [];
  return legacy
    .filter(
      (m): m is { modelId: string; name?: string } =>
        !!m && typeof m === 'object' && typeof (m as { modelId?: unknown }).modelId === 'string'
    )
    .slice(0, 256)
    .map((m) => ({ id: m.modelId.slice(0, 512), name: (m.name ?? m.modelId).slice(0, 256) }));
}

function sessionModes(session: NewSessionResponse): Array<{ id: string; name: string }> {
  const modes = session.modes?.availableModes ?? [];
  return modes
    .slice(0, 64)
    .map((mode) => ({ id: mode.id.slice(0, 256), name: mode.name.slice(0, 256) }));
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AcpProbeError(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
