import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * CLI tabanlı medya sağlayıcıları (Higgsfield, Flow) için ortak araç motoru. Sağlayıcı API'leri
 * yeniden yazılmaz ve kimlik bilgilerine dokunulmaz: her araç ilgili CLI'ı argv dizisiyle
 * (kabuk yok) bir kez çalıştırır. Kredi harcayan çağrılar varsayılan olarak iki adımlıdır
 * (önce önizleme, kullanıcı onayından sonra `confirm_spend: true`) ve asla otomatik yinelenmez.
 */

export type CliRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
};

export type CliRunner = (
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv }
) => Promise<CliRunResult>;

/** Bir https adresini dosyaya indirir; testlerde sahtesi verilir. */
export type MediaDownloader = (url: string, destination: string) => Promise<void>;

export type ToolText = { type: 'text'; text: string };
export type ToolResult = { content: ToolText[]; isError?: boolean };

export type MediaToolContext = {
  outputDir: string;
  now: number;
};

/** Bir aracın CLI çağrısı: argv ya da girdi hatası. */
export type ToolPlan = { argv: string[]; summary: string; timeoutMs?: number } | { error: string };

export type MediaToolSpec = {
  name: string;
  title: string;
  description: string;
  /** `spend`: kredi harcar (onay adımı + yineleme yok); `read`: salt okunur. */
  kind: 'read' | 'spend';
  /** Sonuç dosyaları indirilip/çıkış dizinine yazılır mı. */
  producesMedia?: boolean;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  plan(args: Record<string, unknown>, context: MediaToolContext): ToolPlan;
  /** Salt okunur çıktıyı dönüştürür (ör. hesap e-postasını ayıklamak için). */
  transform?(stdout: string): string;
};

export type MediaProviderSpec = {
  id: string;
  title: string;
  serverName: string;
  instructions: string;
  tools: MediaToolSpec[];
};

export type MediaToolHandlerDeps = {
  run: CliRunner;
  executable: string;
  outputDir: string;
  requireConfirmation: boolean;
  download: MediaDownloader;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const MAX_OUTPUT_CHARS = 6000;
const MEDIA_EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|flac|glb)$/i;

export const CONFIRM_SPEND_PROPERTY = {
  type: 'boolean',
  description:
    'Set to true only after the user approved this exact generation and its credit cost. Without it the tool only previews the call and spends nothing.',
} as const;

// ANSI kaçışları ve kontrol karakterleri temizlenir.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function cleanOutput(raw: string, max = MAX_OUTPUT_CHARS): string {
  const text = raw.replace(/\r\n?/g, '\n').replace(ANSI, '').replace(CONTROL, '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 16).trimEnd()}\n… (truncated)`;
}

export const nodeCliRunner: CliRunner = (executable, args, options) =>
  new Promise((resolvePromise) => {
    const child = execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: options.env,
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const code = failure?.code;
        resolvePromise({
          exitCode: failure ? (typeof code === 'number' ? code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: failure?.killed === true,
          notFound: code === 'ENOENT' || code === 'EACCES',
        });
      }
    );
    child.stdin?.end();
  });

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Yalnızca https; boyut sınırlı; yarım kalan dosya silinir. Kredi harcamaz. */
export const httpsDownloader: MediaDownloader = async (url, destination) => {
  if (!/^https:\/\//i.test(url)) throw new Error('Only https result URLs are downloaded.');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > MAX_DOWNLOAD_BYTES) throw new Error('The result file is too large to download.');
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(destination, { flags: 'wx', mode: 0o644 })
    );
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
};

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** JSON çıktısındaki tüm dizeleri dolaşır. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function parseJsonLoose(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Bazı CLI'lar JSON'dan önce ilerleme satırı basar: son JSON bloğunu dene.
    const start = trimmed.search(/[[{][^\n]*$/m);
    const first = Math.min(
      ...['{', '['].map((ch) => trimmed.indexOf(ch)).filter((index) => index >= 0)
    );
    for (const index of [first, start]) {
      if (Number.isFinite(index) && index >= 0) {
        try {
          return JSON.parse(trimmed.slice(index));
        } catch {
          // devam
        }
      }
    }
    return null;
  }
}

/** Çıktıdaki medya dosyası yolları (mutlak, bilinen uzantı) ve https medya adresleri. */
export function findMediaReferences(stdout: string): { files: string[]; urls: string[] } {
  const parsed = parseJsonLoose(stdout);
  const strings = parsed === null ? stdout.split(/\s+/) : collectStrings(parsed);
  const files = new Set<string>();
  const urls = new Set<string>();
  for (const raw of strings) {
    const value = raw.trim().replace(/^["'(<]+|["')>,.;]+$/g, '');
    if (/^https:\/\//i.test(value)) {
      try {
        if (MEDIA_EXTENSIONS.test(new URL(value).pathname)) urls.add(value);
      } catch {
        // geçersiz adres
      }
    } else if (isAbsolute(value) && MEDIA_EXTENSIONS.test(value)) {
      files.add(value);
    }
  }
  return { files: [...files], urls: [...urls] };
}

function safeFileStem(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'media'
  );
}

/** Sağlayıcı tanımından MCP araç listesi ve çağrı işleyicisi üretir. */
export function createMediaToolHandler(spec: MediaProviderSpec, deps: MediaToolHandlerDeps) {
  const now = deps.now ?? Date.now;
  const outputDir = resolve(deps.outputDir);

  const listTools = () =>
    spec.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema:
        tool.kind === 'spend'
          ? {
              ...tool.inputSchema,
              properties: { ...tool.inputSchema.properties, confirm_spend: CONFIRM_SPEND_PROPERTY },
              additionalProperties: false,
            }
          : { ...tool.inputSchema, additionalProperties: false },
      annotations: {
        title: tool.title,
        readOnlyHint: tool.kind === 'read' && !tool.producesMedia,
        // Kredi harcayan çağrılar geri alınamaz; ajanın onay akışı devreye girsin.
        destructiveHint: tool.kind === 'spend',
        idempotentHint: tool.kind === 'read',
        openWorldHint: true,
      },
    }));

  async function saveMedia(stdout: string, label: string): Promise<string[]> {
    const { files, urls } = findMediaReferences(stdout);
    const saved: string[] = [...files];
    if (urls.length === 0) return saved;
    await mkdir(outputDir, { recursive: true });
    let index = 0;
    for (const url of urls.slice(0, 8)) {
      index += 1;
      const ext = extname(new URL(url).pathname).toLowerCase() || '.bin';
      const target = join(outputDir, `${spec.id}-${safeFileStem(label)}-${now()}-${index}${ext}`);
      try {
        await deps.download(url, target);
        saved.push(target);
      } catch {
        // İndirilemeyen sonuç adresi metinde kalır.
      }
    }
    return saved;
  }

  async function callTool(name: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = spec.tools.find((candidate) => candidate.name === name);
    if (!tool) return textResult(`Unknown tool: ${name}`, true);
    const args =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const plan = tool.plan(args, { outputDir, now: now() });
    if ('error' in plan) return textResult(plan.error, true);
    const command = `${basename(deps.executable)} ${plan.argv.join(' ')}`;

    if (tool.kind === 'spend' && deps.requireConfirmation && args.confirm_spend !== true) {
      return textResult(
        [
          `Not run: ${spec.title} generation spends the user's credits.`,
          `Planned call: ${plan.summary}`,
          `Command: ${command}`,
          'Ask the user to approve this generation and its cost (estimate it first if a cost tool exists), then call this tool again with the same arguments and confirm_spend: true.',
        ].join('\n')
      );
    }

    if (tool.producesMedia) await mkdir(outputDir, { recursive: true });
    const result = await deps.run(deps.executable, plan.argv, {
      timeoutMs: plan.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: deps.env,
    });
    if (result.notFound) {
      return textResult(`The ${spec.title} CLI is not installed or not executable.`, true);
    }
    const output = cleanOutput(tool.transform ? tool.transform(result.stdout) : result.stdout);
    const errors = cleanOutput(result.stderr, 2000);
    if (result.exitCode !== 0 || result.timedOut) {
      return textResult(
        [
          `${spec.title} CLI ${result.timedOut ? 'timed out' : `exited with code ${result.exitCode}`}.`,
          output ? `Output:\n${output}` : '',
          errors ? `Errors:\n${errors}` : '',
          tool.kind === 'spend'
            ? 'Do NOT retry automatically: the generation may still have been created and billed. Check the job/credits first and ask the user before trying again.'
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        true
      );
    }
    if (!tool.producesMedia) return textResult(output || '(no output)');
    const saved = await saveMedia(result.stdout, String(args.job_id ?? args.media_id ?? tool.name));
    const lines = [
      `${spec.title} CLI output (credits and cost as reported by the CLI):`,
      output || '(no output)',
    ];
    if (saved.length > 0) {
      lines.push(
        '',
        'Saved files (mention these absolute paths in your reply so the chat shows them inline):',
        ...saved.map((path) => `- ${path}`)
      );
    } else {
      lines.push(
        '',
        `No result file was saved yet. If the job is still running, fetch it later with the fetch tool; output directory: ${outputDir}`
      );
    }
    return textResult(lines.join('\n'));
  }

  return { listTools, callTool };
}

/** Değer doğrulayıcıları (araç tanımları için). */
export const validate = {
  text(value: unknown, field: string, max = 4000): string | { error: string } {
    if (typeof value !== 'string' || !value.trim()) return { error: `${field} is required.` };
    if (value.length > max) return { error: `${field} is longer than ${max} characters.` };
    return value;
  },
  slug(value: unknown, field: string): string | { error: string } {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(value)) {
      return { error: `${field} must be a model/job identifier (letters, digits, . _ : -).` };
    }
    return value;
  },
  /** Yerel dosya yolu (mutlak) ya da sağlayıcı kimliği. Asla `-` ile başlamaz. */
  mediaRef(value: unknown, field: string): string | { error: string } {
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) {
      return { error: `${field} must be an absolute file path or a media id.` };
    }
    return value;
  },
};

export function isError(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value;
}
